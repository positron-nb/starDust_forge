import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs';
import { EditorMcpServer } from './mcp/server';
import { installReadTools } from './mcp/tools';
import { installContextTools } from './mcp/contextTools';
import { installCommandTool, installBatchCommandTool, killAllCommands } from './mcp/commandTool';
import { installEditTool } from './mcp/editTool';
import { installStateTool } from './mcp/stateTool';
import { TaskLedger } from './agent/ledger';
import { Workspace } from './mcp/workspace';
import { ContextIndex } from './context/index';
import { resolveMentions } from './context/mentions';
import { ChangeManager, proposalKey, type Proposal } from './changes/changeManager';
import type { EditSpec } from './changes/hunks';
import { prepareProposal } from './changes/prepare';
import { AgentRunner, type ApprovalDecision, type ApprovalRequest } from './trueforge/agentRunner';
import { loadAgentSpec } from './trueforge/agentSpec';
import { resolveModels, type ProviderListing } from './trueforge/models';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { AgentViewProvider } from './ui/agentView';
import { ReviewController, vscodeIO } from './ui/review';
import { registerInlineEdit } from './ui/inlineEdit';
import { INLINE_INSTRUCTIONS } from './trueforge/inlinePrompt';

let mcp: EditorMcpServer | undefined;

/** Returned by activate() so UI integration tests (test-ui/) can drive the same code paths TrueForge does. */
export interface ForgeTestApi {
  root: string;
  /** Exactly what runs during a TrueForge approval pause (opens the hunk review for propose_edit). */
  approve(req: ApprovalRequest): Promise<ApprovalDecision>;
  /** What the propose_edit tool does when TrueForge executes the approved call. */
  applyApproved(path: string, edits: EditSpec[]): Promise<{ ok: boolean; message: string }>;
  /** Same work as the Cancel button (without a running model turn). */
  cancelPending(): number;
  /** Panel input as a user would use it: 'prefill' types text into the input box, 'submit' presses Send. */
  panelInput(msg: { kind: 'prefill'; text: string } | { kind: 'submit' }): void;
  /** True while an agent or inline run is in progress. */
  isRunning(): boolean;
  /** TrueForge session id of the agent panel's current session. */
  sessionId(): string | undefined;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<ForgeTestApi | undefined> {
  const out = vscode.window.createOutputChannel('Forge Agent');
  const log = (m: string) => out.appendLine(`[${new Date().toISOString()}] ${m}`);
  const cfg = () => vscode.workspace.getConfiguration('forge');
  const baseUrl = () => cfg().get<string>('baseUrl', 'http://localhost:8790');

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { log('No workspace folder open; Forge Agent is idle.'); return undefined; }
  const ws = new Workspace(folder.uri.fsPath);

  // ---- context engine ------------------------------------------------------------
  const index = new ContextIndex(ws);
  void index.refresh().then(() => log(`Indexed ${index.fileCount} files / ${index.chunkCount} symbols in ${index.lastRefreshMs}ms`));

  // ---- change management + review -------------------------------------------------
  const changes = new ChangeManager(vscodeIO);
  const ledger = new TaskLedger();
  let view: AgentViewProvider;
  const postReview = (p: Proposal) => view?.post({ kind: 'review', id: p.id, path: p.path, description: p.description, status: p.status, isNew: p.isNew,
    hunks: p.set.hunks.map(h => ({ index: h.index, origStart: h.origStart, newStart: h.newStart, removed: h.removed, added: h.added, state: h.state })) });
  const review = new ReviewController(changes, postReview);
  review.register(ctx);

  // ---- MCP server: the editor capabilities TrueForge's agent can call ---------------
  const onToolCall = (n: string, a: unknown) => log(`tool ${n} ${JSON.stringify(a)}`);
  mcp = new EditorMcpServer(server => {
    installContextTools(server, { index, onToolCall, ledger, onContext: r => view?.post({
      kind: 'context', query: r.query, used: r.used, budget: r.budget,
      stats: `index: ${r.stats.files} files, ${r.stats.chunks} symbols · ${r.stats.candidates} candidates ranked · ${r.skipped.length} dropped (budget/per-file cap)`,
      items: r.items.map(i => ({ file: i.file, symbol: i.symbol, start: i.start, end: i.end, score: i.score, tokens: i.tokens, why: i.reasons.join('; ') })),
    }) });
    installReadTools(server, { ws, rgPath: findRipgrep(), onToolCall, ledger });
    installEditTool(server, { changes, onToolCall, ledger });
    installCommandTool(server, { ws, onToolCall, ledger });
    installBatchCommandTool(server, { ws, onToolCall, ledger, logDir: ctx.logUri.fsPath });
    installStateTool(server, { ledger, onToolCall });
  }, log);
  await mcp.start();

  // ---- TrueForge runners (created lazily: the extension works before TrueForge starts) ----
  const makeRunner = async (extraInstructions = ''): Promise<AgentRunner> => {
    const name = cfg().get<string>('mcpServerName', 'forge-workspace');
    const unreachable = (err: unknown) => new Error(`Cannot reach TrueForge at ${baseUrl()}. Start it with OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest (see README). Details: ${(err as Error).message}`);
    let providers: ProviderListing[] = [];
    try {
      const { data } = await new TrueForge({ baseUrl: baseUrl(), timeoutInSeconds: 15 }).settings.modelProviders.list();
      providers = (data as Array<{ name: string; manifest?: { models?: Array<{ name: string }> } }>).map(p => ({ name: p.name, models: p.manifest?.models ?? [] }));
    } catch (err) { throw unreachable(err); }
    const { models, note } = resolveModels(cfg().get<string[]>('models', []), providers);
    if (note) { log(note); view?.post({ kind: 'status', text: note, level: models.length ? 'info' : 'error' }); }
    if (!models.length) throw new Error('No model is configured in TrueForge. Add one in TrueForge → Settings → Models, or set forge.models.');
    const r = new AgentRunner({ baseUrl: baseUrl(), models, spec: loadAgentSpec(name, extraInstructions, { profile: cfg().get<'full' | 'lean'>('profile', 'full'), compactAt: cfg().get<number>('compactAtTokens', 0), reasoningEffort: cfg().get<string>('reasoningEffort', '') || undefined }),
      completionCheck: () => ledger.completionIssues(), handoff: () => ledger.handoff() });
    try { await mcp!.registerWithTrueForge(r.sdk, name); }
    catch (err) { throw unreachable(err); }
    return r;
  };
  let runner: AgentRunner | undefined;
  let runnerKey = '';
  const getRunner = async (): Promise<AgentRunner> => {
    const key = JSON.stringify([baseUrl(), cfg().get('models'), cfg().get('mcpServerName'), cfg().get('profile'), cfg().get('compactAtTokens'), cfg().get('reasoningEffort')]);
    if (!runner || key !== runnerKey) { runner = await makeRunner(); runnerKey = key; }
    return runner;
  };

  // ---- TrueForge approval pauses → editor UI ----------------------------------------
  const approve = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    if (req.toolName === 'propose_edit') {
      const prep = await prepareProposal(ws, changes, vscodeIO, req.args, ledger);
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
    if (req.toolName === 'run_command' || req.toolName === 'run_commands') {
      const cmds = req.toolName === 'run_command'
        ? [String((req.args as { command?: string })?.command ?? '')]
        : ((req.args as { commands?: Array<{ argv?: string[]; cwd?: string }> })?.commands ?? [])
          .map(c => `${(c.argv ?? []).join(' ')}${c.cwd && c.cwd !== '.' ? `   (in ${c.cwd})` : ''}`);
      const allow = cfg().get<string[]>('autoApproveCommands', []);
      const ok = (cmd: string) => allow.some(p => { try { return new RegExp(p).test(cmd); } catch { return false; } });
      if (cmds.length && cmds.every(ok)) {
        view.post({ kind: 'status', text: `Auto-approved (forge.autoApproveCommands): ${cmds.join(' ; ')}`, level: 'info' });
        return { allow: true };
      }
      const list = cmds.map((c, i) => `${i + 1}. ${c}`).join('\n');
      const pick = await vscode.window.showWarningMessage(`Forge agent wants to run ${cmds.length} command(s):\n\n${list}`, { modal: true }, 'Run', 'Deny');
      return pick === 'Run' ? { allow: true } : { allow: false, reason: 'The user denied this command batch.' };
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
    onRunStart: (label, task) => { ledger.reset(task, label === 'inline' ? 'inline' : 'agent'); return changes.beginRun(label); },
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
  return {
    root: ws.root,
    approve,
    applyApproved: (p, edits) => changes.applyApproved(proposalKey(p, edits)),
    cancelPending: () => { killAllCommands(); review.cancelAll(); return changes.cancelAll(); },
    panelInput: msg => view.post(msg as never),
    isRunning: () => view.isRunning,
    sessionId: () => runner?.currentSessionId,
  };
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
