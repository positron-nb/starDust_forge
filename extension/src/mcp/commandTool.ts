/**
 * run_command: runs a shell command in the workspace and returns its output.
 * Gated twice: TrueForge pauses for approval (require_approval_for_tools), and the
 * extension either auto-approves an allow-listed read/test command or asks the user.
 * A hard deny-list applies even after approval. Running processes die on cancel.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Workspace } from './workspace';

const HARD_DENY: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\*|\.\s*$)/i, /\bdel\s+\/s\b/i, /\brmdir\s+\/s\b/i, /\bformat\s+[a-z]:/i,
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\b)/i, /\b(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*(sh|bash|iex|powershell)/i,
  /\b(shutdown|reboot|mkfs|diskpart)\b/i, />\s*\/dev\/sd/, /\bnpm\s+publish\b/i, /\bpip\s+uninstall\b/i,
];

export function isHardDenied(cmd: string): string | undefined {
  const hit = HARD_DENY.find(r => r.test(cmd));
  return hit ? `blocked by safety policy (${hit.source})` : undefined;
}

const running = new Set<ChildProcess>();
export function killAllCommands(): void {
  for (const p of running) {
    try {
      if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
      else p.kill('SIGTERM');
    } catch { /* already gone */ }
  }
  running.clear();
}

/** Env with the workspace's virtualenv (.venv / venv) activated, if present. */
function workspaceEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const v of ['.venv', 'venv']) {
    const bin = path.join(root, v, process.platform === 'win32' ? 'Scripts' : 'bin');
    if (fs.existsSync(bin)) {
      const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
      env[key] = bin + path.delimiter + (env[key] ?? '');
      env.VIRTUAL_ENV = path.join(root, v);
      break;
    }
  }
  return env;
}

export function runShell(cmd: string, cwd: string, root: string, timeoutMs: number): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const p = spawn(cmd, { cwd, shell: true, env: workspaceEnv(root), windowsHide: true });
    running.add(p);
    let out = '';
    let timedOut = false;
    const cap = (s: string) => { out += s; if (out.length > 200_000) out = out.slice(-100_000); };
    p.stdout?.on('data', c => cap(c.toString()));
    p.stderr?.on('data', c => cap(c.toString()));
    const timer = setTimeout(() => { timedOut = true; running.delete(p); try { p.kill(); } catch { /* */ } }, timeoutMs);
    p.on('close', code => { clearTimeout(timer); running.delete(p); resolve({ code, out, timedOut }); });
    p.on('error', err => { clearTimeout(timer); running.delete(p); resolve({ code: -1, out: String(err), timedOut }); });
  });
}

export function installCommandTool(server: McpServer, d: { ws: Workspace; onToolCall?: (n: string, a: unknown) => void; ledger?: import('../agent/ledger').TaskLedger }): void {
  const shell = process.platform === 'win32' ? 'Windows cmd.exe (use `set VAR=x&& cmd` for env vars, not `VAR=x cmd`)' : 'POSIX sh';
  server.registerTool('run_command', {
    title: 'Run terminal command',
    description: `Run ONE shell command (for verification prefer run_commands, which runs several checks in one call). Returns exit code + output (tail). Shell: ${shell}. ` +
      'A workspace virtualenv (.venv) is activated automatically. Use it to run tests (e.g. "python -m pytest tests/test_x.py -q") and to verify changes. ' +
      'Do NOT use it to edit files: all file changes must go through propose_edit so the user can review them.',
    inputSchema: {
      command: z.string(),
      cwd: z.string().default('.').describe('Workspace-relative working directory'),
      timeout_seconds: z.number().int().min(1).max(600).default(120),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ command, cwd, timeout_seconds }) => {
    d.onToolCall?.('run_command', { command, cwd });
    const denied = isHardDenied(command);
    if (denied) return { content: [{ type: 'text' as const, text: `Error: ${denied}` }], isError: true };
    let dir: string;
    try { dir = d.ws.resolve(cwd).abs; } catch (e) { return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true }; }
    const r = await runShell(command, dir, d.ws.root, timeout_seconds * 1000);
    d.ledger?.recordCommand(command, r.code, r.out);
    const tail = r.out.length > 8000 ? '… (output truncated)\n' + r.out.slice(-8000) : r.out;
    return { content: [{ type: 'text' as const, text: `$ ${command}\nexit code: ${r.code}${r.timedOut ? ' (TIMED OUT)' : ''}\n${tail || '(no output)'}` }], isError: r.code !== 0 };
  });
}

/** Executes one argv command without a shell (no string concatenation / injection). */
export function runArgv(argv: string[], cwd: string, root: string, timeoutMs: number): Promise<{ code: number | null; out: string; timedOut: boolean; ms: number }> {
  const t0 = Date.now();
  return new Promise(resolve => {
    let p: ChildProcess;
    try { p = spawn(argv[0], argv.slice(1), { cwd, shell: false, env: workspaceEnv(root), windowsHide: true }); }
    catch (e) { resolve({ code: -1, out: String(e), timedOut: false, ms: 0 }); return; }
    running.add(p);
    let out = '';
    let timedOut = false;
    const cap = (s: string) => { out += s; if (out.length > 400_000) out = out.slice(-200_000); };
    p.stdout?.on('data', c => cap(c.toString()));
    p.stderr?.on('data', c => cap(c.toString()));
    const timer = setTimeout(() => { timedOut = true; running.delete(p); try { p.kill(); } catch { /* */ } }, timeoutMs);
    p.on('close', code => { clearTimeout(timer); running.delete(p); resolve({ code, out, timedOut, ms: Date.now() - t0 }); });
    p.on('error', err => { clearTimeout(timer); running.delete(p); resolve({ code: -1, out: String(err), timedOut, ms: Date.now() - t0 }); });
  });
}

/** Short, structured digest of one command's output: summary lines + tail (+ failure section for tests). */
export function digestOutput(out: string, maxLines = 25): string {
  const lines = out.replace(/\r/g, '').split('\n').filter(l => l.trim());
  const fail = lines.findIndex(l => /^(=+ FAILURES =+|FAILED |E\s|Traceback|error:)/i.test(l));
  const pick = fail >= 0 ? lines.slice(fail, fail + maxLines) : lines.slice(-maxLines);
  return pick.join('\n');
}

export const commandSpecSchema = z.object({
  argv: z.array(z.string()).min(1).describe('Program and arguments, e.g. ["python","-m","pytest","tests/test_x.py","-q"]. No shell: no pipes, &&, redirects or globbing.'),
  cwd: z.string().default('.').describe('Workspace-relative working directory'),
  timeout_seconds: z.number().int().min(1).max(600).default(120),
});

export function installBatchCommandTool(server: McpServer, d: { ws: Workspace; onToolCall?: (n: string, a: unknown) => void; ledger?: import('../agent/ledger').TaskLedger; logDir: string }): void {
  server.registerTool('run_commands', {
    title: 'Run several commands (verification batch)',
    description: 'Run up to 8 commands in ONE call, each as an argv list (no shell), and get a structured result per command: exit code, duration and a short digest (failure section or tail). ' +
      'Use it to verify a change in one step (tests, the feature itself, lint checks). The user approves the whole batch, seeing every command. Full logs are saved to a file whose path is returned. ' +
      'A workspace virtualenv is activated automatically. Never use it to edit files.',
    inputSchema: {
      commands: z.array(commandSpecSchema).min(1).max(8),
      fail_fast: z.boolean().default(false).describe('Stop at the first failing command'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ commands, fail_fast }) => {
    d.onToolCall?.('run_commands', { commands: commands.map(c => c.argv.join(' ')), fail_fast });
    const logs: string[] = [];
    const results: string[] = [];
    let failed = 0;
    for (const [i, c] of commands.entries()) {
      const shown = c.argv.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
      const denied = isHardDenied(shown);
      let dir: string | undefined;
      try { dir = d.ws.resolve(c.cwd).abs; } catch (e) { results.push(`[${i + 1}] ${shown}\n  error: ${(e as Error).message}`); failed++; if (fail_fast) break; continue; }
      if (denied) { results.push(`[${i + 1}] ${shown}\n  error: ${denied}`); failed++; if (fail_fast) break; continue; }
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { results.push(`[${i + 1}] ${shown}\n  error: cwd "${c.cwd}" is not a directory`); failed++; if (fail_fast) break; continue; }
      const r = await runArgv(c.argv, dir, d.ws.root, c.timeout_seconds * 1000);
      d.ledger?.recordCommand(shown, r.code, r.out);
      logs.push(`$ ${shown}   (cwd ${c.cwd}, exit ${r.code}${r.timedOut ? ', TIMED OUT' : ''}, ${r.ms} ms)\n${r.out}`);
      const ok = r.code === 0 && !r.timedOut;
      if (!ok) failed++;
      results.push(`[${i + 1}] ${shown}  → exit ${r.code}${r.timedOut ? ' (TIMED OUT)' : ''}, ${r.ms} ms${ok ? '' : '  ✗'}\n${digestOutput(r.out, ok ? 6 : 25).replace(/^/gm, '  ')}`);
      if (!ok && fail_fast) { results.push(`(fail_fast: ${commands.length - i - 1} remaining command(s) not run)`); break; }
    }
    fs.mkdirSync(d.logDir, { recursive: true });
    const logFile = path.join(d.logDir, `run-commands-${Date.now()}.log`);
    fs.writeFileSync(logFile, logs.join('\n\n'), 'utf8');
    const head = `${commands.length - failed}/${commands.length} succeeded${failed ? ` — ${failed} failed` : ''}. Full logs: ${logFile}`;
    return { content: [{ type: 'text' as const, text: `${head}\n\n${results.join('\n\n')}` }], isError: failed > 0 };
  });
}
