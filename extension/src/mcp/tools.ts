/** Read-only workspace tools. Write/command tools are added in Phase 3/5 behind diff review. */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Workspace } from './workspace.js';
import type { TaskLedger } from '../agent/ledger';

export interface ToolDeps {
  ws: Workspace;
  rgPath: string;
  /** Lets the UI show each tool call as it happens. */
  onToolCall?: (name: string, args: unknown) => void;
  ledger?: TaskLedger;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: `Error: ${t}` }], isError: true });
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export function installReadTools(server: McpServer, d: ToolDeps): void {
  server.registerTool('read_file', {
    title: 'Read file',
    description: 'Read a workspace file with line numbers. Prefer a line range (start_line/end_line) once you know where the relevant code is; whole large files waste context.',
    inputSchema: { path: z.string().describe('Workspace-relative path'), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() },
    annotations: RO,
  }, async ({ path, start_line, end_line }) => {
    d.onToolCall?.('read_file', { path, start_line, end_line });
    try { return text(await readRange(d, path, start_line, end_line)); } catch (err) { return fail((err as Error).message); }
  });

  server.registerTool('read_files', {
    title: 'Read several files/ranges',
    description: 'Read up to 8 files or line ranges in ONE call (same output format as read_file). Use it instead of several read_file calls once you know which regions matter.',
    inputSchema: { requests: z.array(z.object({ path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() })).min(1).max(8) },
    annotations: RO,
  }, async ({ requests }) => {
    d.onToolCall?.('read_files', { count: requests.length, paths: requests.map(r => r.path) });
    const parts: string[] = [];
    let budget = 1200; // total lines across the batch
    for (const r of requests) {
      if (budget <= 0) { parts.push(`${r.path}: skipped (batch line budget used; request it separately)`); continue; }
      try {
        const s = r.start_line ?? 1;
        const e = Math.min(r.end_line ?? s + 399, s + budget - 1);
        const out = await readRange(d, r.path, s, e);
        budget -= out.split('\n').length;
        parts.push(out);
      } catch (err) { parts.push(`${r.path}: Error: ${(err as Error).message}`); }
    }
    return text(parts.join('\n\n'));
  });

  server.registerTool('list_files', {
    title: 'List files',
    description: 'List files and directories under a workspace path (ignores .git, node_modules, virtualenvs, caches).',
    inputSchema: { path: z.string().default('.'), depth: z.number().int().min(1).max(6).default(2) },
    annotations: RO,
  }, async ({ path, depth }) => {
    d.onToolCall?.('list_files', { path, depth });
    try {
      const items = await d.ws.list(path, depth);
      return text(items.length ? items.join('\n') : '(empty)');
    } catch (err) { return fail((err as Error).message); }
  });

  server.registerTool('search_workspace', {
    title: 'Search workspace',
    description: 'Regex search across the workspace with ripgrep. Returns file:line:text matches. Use to locate definitions, call sites, docs and tests.',
    inputSchema: {
      pattern: z.string().describe('Rust/PCRE-style regex'),
      glob: z.string().optional().describe('Optional file glob, e.g. "*.py" or "docs/**"'),
      case_sensitive: z.boolean().default(false),
      max_results: z.number().int().min(1).max(200).default(60),
    },
    annotations: RO,
  }, async ({ pattern, glob, case_sensitive, max_results }) => {
    d.onToolCall?.('search_workspace', { pattern, glob });
    try {
      const hits = await ripgrep(d.rgPath, d.ws.root, pattern, { glob, caseSensitive: case_sensitive, max: max_results });
      return text(hits.length ? hits.join('\n') : 'No matches.');
    } catch (err) { return fail((err as Error).message); }
  });
}

/** Numbered lines of a file range; notes when the same unchanged range was already returned. */
async function readRange(d: ToolDeps, path: string, start_line?: number, end_line?: number): Promise<string> {
  const content = await d.ws.read(path);
  const lines = content.split(/\r?\n/);
  const rel = d.ws.resolve(path).rel;
  const s = Math.max(1, start_line ?? 1);
  const e = Math.min(lines.length, end_line ?? Math.min(lines.length, s + 399));
  const dup = d.ledger?.recordRead(rel, content, s, e);
  const body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}| ${l}`).join('\n');
  const more = e < lines.length ? `\n… (${lines.length - e} more lines; request start_line=${e + 1})` : '';
  const note = dup ? ' [already read earlier; file unchanged since: keep working from this content instead of reading it again]' : '';
  return `${rel} lines ${s}-${e} of ${lines.length}${note}\n${body}${more}`;
}

export function ripgrep(rg: string, cwd: string, pattern: string, o: { glob?: string; caseSensitive?: boolean; max: number }): Promise<string[]> {
  const args = ['--line-number', '--no-heading', '--color=never', '--max-columns=240', '--max-count=20',
    '-g', '!.git', '-g', '!node_modules', '-g', '!*.lock', o.caseSensitive ? '-s' : '-i'];
  if (o.glob) args.push('-g', o.glob);
  args.push('-e', pattern, '.');
  return new Promise((resolve, reject) => {
    const p = spawn(rg, args, { cwd, windowsHide: true });
    const out: string[] = [];
    let buf = '', err = '';
    p.stdout.on('data', c => {
      buf += c;
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const l of lines) { if (out.length < o.max) out.push(l.replace(/^\.[/\\]/, '').replace(/\\/g, '/')); }
      if (out.length >= o.max) p.kill();
    });
    p.stderr.on('data', c => (err += c));
    p.on('error', reject);
    p.on('close', code => (code === 2 && out.length === 0 ? reject(new Error(err.trim() || 'ripgrep failed')) : resolve(out)));
  });
}
