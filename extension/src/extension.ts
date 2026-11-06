import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs';
import { EditorMcpServer } from './mcp/server';
import { installReadTools } from './mcp/tools';
import { installContextTools } from './mcp/contextTools';
import { installCommandTool, killAllCommands } from './mcp/commandTool';
import { ContextIndex } from './context/index';
import { resolveMentions } from './context/mentions';
import type { ApprovalDecision, ApprovalRequest } from './trueforge/agentRunner';
import { Workspace } from './mcp/workspace';
import { AgentRunner } from './trueforge/agentRunner';
import { loadAgentSpec } from './trueforge/agentSpec';
import { AgentViewProvider } from './ui/agentView';

let mcp: EditorMcpServer | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const out = vscode.window.createOutputChannel('Forge Agent');
  const log = (m: string) => out.appendLine(`[${new Date().toISOString()}] ${m}`);
  const cfg = () => vscode.workspace.getConfiguration('forge');

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { log('No workspace folder open; Forge Agent is idle.'); return; }
  const ws = new Workspace(folder.uri.fsPath);

  const index = new ContextIndex(ws);
  void index.refresh().then(() => log(`Indexed ${index.fileCount} files / ${index.chunkCount} symbols in ${index.lastRefreshMs}ms`));
  const onToolCall = (n: string, a: unknown) => log(`tool ${n} ${JSON.stringify(a)}`);
  let view: AgentViewProvider;

  mcp = new EditorMcpServer(server => {
    installContextTools(server, { index, onToolCall, onContext: r => view?.post({
      kind: 'context', query: r.query, used: r.used, budget: r.budget,
      stats: `index: ${r.stats.files} files, ${r.stats.chunks} symbols · ${r.stats.candidates} candidates ranked · ${r.skipped.length} dropped (budget/per-file cap)`,
      items: r.items.map(i => ({ file: i.file, symbol: i.symbol, start: i.start, end: i.end, score: i.score, tokens: i.tokens, why: i.reasons.join('; ') })),
    }) });
    installReadTools(server, { ws, rgPath: findRipgrep(), onToolCall });
    installCommandTool(server, { ws, onToolCall });
  }, log);
  await mcp.start();

  // The runner is created lazily so the extension activates even when TrueForge is not running yet.
  let runner: AgentRunner | undefined;
  let runnerKey = '';
  const getRunner = async (): Promise<AgentRunner> => {
    const baseUrl = cfg().get<string>('baseUrl', 'http://localhost:8790');
    const models = cfg().get<string[]>('models', []);
    const name = cfg().get<string>('mcpServerName', 'forge-workspace');
    const key = JSON.stringify([baseUrl, models, name]);
    if (!runner || key !== runnerKey) {
      runner = new AgentRunner({ baseUrl, models, spec: loadAgentSpec(name) });
      runnerKey = key;
      try {
        await mcp!.registerWithTrueForge(runner.sdk, name);
      } catch (err) {
        runner = undefined;
        throw new Error(`Cannot reach TrueForge at ${baseUrl}. Start it with: npx @truefoundry/trueforge@latest  (${(err as Error).message})`);
      }
    }
    return runner;
  };

  /** Answers TrueForge approval pauses. Commands: allow-list or modal prompt. */
  const approve = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    if (req.toolName === 'run_command') {
      const cmd = String((req.args as { command?: string })?.command ?? '');
      const allow = cfg().get<string[]>('autoApproveCommands', []);
      if (allow.some(p => { try { return new RegExp(p).test(cmd); } catch { return false; } })) {
        view.post({ kind: 'status', text: `Auto-approved command (matches forge.autoApproveCommands): ${cmd}`, level: 'info' });
        return { allow: true };
      }
      const pick = await vscode.window.showWarningMessage(`Forge agent wants to run:

${cmd}`, { modal: true }, 'Run', 'Deny');
      return pick === 'Run' ? { allow: true } : { allow: false, reason: 'The user denied this command.' };
    }
    return { allow: false, reason: `No reviewer for ${req.toolName} yet.` };
  };

  view = new AgentViewProvider(ctx, getRunner, () => cfg().get<string>('baseUrl', 'http://localhost:8790'), approve, {
    prepare: async text => {
      const r = await resolveMentions(index, text, 5000);
      return { message: r.message, mentions: r.mentions.map(m => ({ ref: m.ref, kind: m.kind, resolved: m.resolved, detail: m.detail })) };
    },
    onCancel: () => killAllCommands(),
  });

  ctx.subscriptions.push(
    out,
    vscode.window.registerWebviewViewProvider('forge.agentView', view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('forge.cancel', () => view.cancel()),
    vscode.commands.registerCommand('forge.newSession', () => view.newSession()),
    vscode.commands.registerCommand('forge.showSession', async () => {
      const id = runner?.currentSessionId;
      if (!id) return vscode.window.showInformationMessage('No TrueForge session yet.');
      await vscode.env.openExternal(vscode.Uri.parse(`${cfg().get('baseUrl')}/sessions/${id}`));
    }),
    { dispose: () => void mcp?.stop() },
  );
  log(`Forge Agent active for ${ws.root}`);
}

export async function deactivate(): Promise<void> { killAllCommands(); await mcp?.stop(); }

/** VS Code ships ripgrep; prefer it, fall back to rg on PATH. */
function findRipgrep(): string {
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  for (const p of [
    path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
    path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
  ]) if (fs.existsSync(p)) return p;
  return 'rg';
}
