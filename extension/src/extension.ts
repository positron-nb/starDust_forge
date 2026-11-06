import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs';
import { EditorMcpServer } from './mcp/server';
import { installReadTools } from './mcp/tools';
import { installContextTools } from './mcp/contextTools';
import { installCommandTool, killAllCommands } from './mcp/commandTool';
import { installEditTool } from './mcp/editTool';
import { Workspace } from './mcp/workspace';
import { ContextIndex } from './context/index';
import { resolveMentions } from './context/mentions';
import { ChangeManager, type Proposal } from './changes/changeManager';
import { prepareProposal } from './changes/prepare';
import { AgentRunner, type ApprovalDecision, type ApprovalRequest } from './trueforge/agentRunner';
import { loadAgentSpec } from './trueforge/agentSpec';
import { AgentViewProvider } from './ui/agentView';
import { ReviewController, vscodeIO } from './ui/review';
import { registerInlineEdit, INLINE_INSTRUCTIONS } from './ui/inlineEdit';

let mcp: EditorMcpServer | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const out = vscode.window.createOutputChannel('Forge Agent');
  const log = (m: string) => out.appendLine(`[${new Date().toISOString()}] ${m}`);
  const cfg = () => vscode.workspace.getConfiguration('forge');
  const baseUrl = () => cfg().get<string>('baseUrl', 'http://localhost:8790');

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { log('No workspace folder open; Forge Agent is idle.'); return; }
  const ws = new Workspace(folder.uri.fsPath);

  // ---- context engine ------------------------------------------------------------
  const index = new ContextIndex(ws);
  void index.refresh().then(() => log(`Indexed ${index.fileCount} files / ${index.chunkCount} symbols in ${index.lastRefreshMs}ms`));

  // ---- change management + review -------------------------------------------------
  const changes = new ChangeManager(vscodeIO);
  let view: AgentViewProvider;
  const postReview = (p: Proposal) => view?.post({ kind: 'review', id: p.id, path: p.path, description: p.description, status: p.status, isNew: p.isNew,
    hunks: p.set.hunks.map(h => ({ index: h.index, origStart: h.origStart, newStart: h.newStart, removed: h.removed, added: h.added, state: h.state })) });
  const review = new ReviewController(changes, postReview);
  review.register(ctx);

  // ---- MCP server: the editor capabilities TrueForge's agent can call ---------------
  const onToolCall = (n: string, a: unknown) => log(`tool ${n} ${JSON.stringify(a)}`);
  mcp = new EditorMcpServer(server => {
    installContextTools(server, { index, onToolCall, onContext: r => view?.post({
      kind: 'context', query: r.query, used: r.used, budget: r.budget,
      stats: `index: ${r.stats.files} files, ${r.stats.chunks} symbols · ${r.stats.candidates} candidates ranked · ${r.skipped.length} dropped (budget/per-file cap)`,
      items: r.items.map(i => ({ file: i.file, symbol: i.symbol, start: i.start, end: i.end, score: i.score, tokens: i.tokens, why: i.reasons.join('; ') })),
    }) });
    installReadTools(server, { ws, rgPath: findRipgrep(), onToolCall });
    installEditTool(server, { changes, onToolCall });
    installCommandTool(server, { ws, onToolCall });
  }, log);
  await mcp.start();

  // ---- TrueForge runners (created lazily: the extension works before TrueForge starts) ----
  const makeRunner = async (extraInstructions = ''): Promise<AgentRunner> => {
    const name = cfg().get<string>('mcpServerName', 'forge-workspace');
    const r = new AgentRunner({ baseUrl: baseUrl(), models: cfg().get<string[]>('models', []), spec: loadAgentSpec(name, extraInstructions) });
    try { await mcp!.registerWithTrueForge(r.sdk, name); }
    catch (err) { throw new Error(`Cannot reach TrueForge at ${baseUrl()}. Start it with: npx @truefoundry/trueforge@latest  (${(err as Error).message})`); }
    return r;
  };
  let runner: AgentRunner | undefined;
  let runnerKey = '';
  const getRunner = async (): Promise<AgentRunner> => {
    const key = JSON.stringify([baseUrl(), cfg().get('models'), cfg().get('mcpServerName')]);
    if (!runner || key !== runnerKey) { runner = await makeRunner(); runnerKey = key; }
    return runner;
  };

  // ---- TrueForge approval pauses → editor UI ----------------------------------------
  const approve = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    if (req.toolName === 'propose_edit') {
      const prep = await prepareProposal(ws, changes, vscodeIO, req.args);
      if (!prep.ok) {
        view.post({ kind: 'status', text: `Proposed edit could not be shown: ${prep.reason}`, level: 'warn' });
        return { allow: false, reason: prep.reason };
      }
      const outcome = await review.review(prep.proposal);
      const r = changes.finish(prep.proposal.id, outcome);
      if (outcome === 'cancel') return { allow: false, reason: 'The run was cancelled; nothing was written.' };
      if (r.accepted === 0) return { allow: false, reason: `The user rejected all ${r.total} hunk(s) of this edit to ${prep.proposal.path}. Nothing was written.` };
      return { allow: true };
    }
    if (req.toolName === 'run_command') {
      const cmd = String((req.args as { command?: string })?.command ?? '');
      const allow = cfg().get<string[]>('autoApproveCommands', []);
      if (allow.some(p => { try { return new RegExp(p).test(cmd); } catch { return false; } })) {
        view.post({ kind: 'status', text: `Auto-approved command (forge.autoApproveCommands): ${cmd}`, level: 'info' });
        return { allow: true };
      }
      const pick = await vscode.window.showWarningMessage(`Forge agent wants to run:\n\n${cmd}`, { modal: true }, 'Run', 'Deny');
      return pick === 'Run' ? { allow: true } : { allow: false, reason: 'The user denied this command.' };
    }
    return { allow: false, reason: `Tool ${req.toolName} is not approved by this client.` };
  };

  const undo = async (scope: 'last' | 'run') => {
    const r = await changes.undo(scope);
    if (!r.undone.length && !r.skipped.length) return vscode.window.showInformationMessage('Forge: nothing to undo.');
    const msg = `Forge: reverted ${r.undone.join(', ') || 'nothing'}${r.skipped.length ? `; skipped ${r.skipped.join(', ')}` : ''}.`;
    view.post({ kind: 'status', text: msg, level: r.skipped.length ? 'warn' : 'info' });
    return vscode.window.showInformationMessage(msg);
  };

  view = new AgentViewProvider(ctx, getRunner, baseUrl, approve, {
    prepare: async text => {
      const r = await resolveMentions(index, text, 5000);
      return { message: r.message, mentions: r.mentions.map(m => ({ ref: m.ref, kind: m.kind, resolved: m.resolved, detail: m.detail })) };
    },
    onCancel: () => { killAllCommands(); review.cancelAll(); const n = changes.cancelAll(); if (n) log(`cancel: dropped ${n} approved-but-unapplied edit(s)`); },
    onRunStart: label => changes.beginRun(label),
    appliedSummary: runId => {
      const files = runId ? [...new Set(changes.appliedInRun(runId).map(u => u.path))] : [];
      return files.length ? `Applied changes to ${files.length} file(s): ${files.join(', ')} (Forge: Undo Agent Run reverts them).` : '';
    },
    onPanelCommand: m => {
      if (m.kind === 'undo') return void undo(m.action === 'last' ? 'last' : 'run');
      const map: Record<string, string> = { accept: 'forge.review.acceptHunk', reject: 'forge.review.rejectHunk', acceptAll: 'forge.review.acceptAll',
        rejectAll: 'forge.review.rejectAll', apply: 'forge.review.apply', open: 'forge.review.open' };
      if (m.action && map[m.action]) void vscode.commands.executeCommand(map[m.action], m.id, m.index);
    },
  });

  registerInlineEdit(ctx, { root: ws.root, view, makeRunner: () => makeRunner(INLINE_INSTRUCTIONS) });

  ctx.subscriptions.push(
    out,
    vscode.window.registerWebviewViewProvider('forge.agentView', view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('forge.cancel', () => view.cancel()),
    vscode.commands.registerCommand('forge.newSession', () => view.newSession()),
    vscode.commands.registerCommand('forge.undoLast', () => undo('last')),
    vscode.commands.registerCommand('forge.undoRun', () => undo('run')),
    vscode.commands.registerCommand('forge.showSession', async () => {
      const id = runner?.currentSessionId;
      if (!id) return vscode.window.showInformationMessage('No TrueForge session yet.');
      await vscode.env.openExternal(vscode.Uri.parse(`${baseUrl()}/sessions/${id}`));
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
