/**
 * Agent panel (webview view). Extension-host side: forwards user requests to the
 * AgentRunner and pushes streamed TrueForge events to the webview. Nothing here
 * blocks the extension host: the run is fully async and cancellable.
 */
import * as vscode from 'vscode';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { AgentRunner, ApprovalDecision, ApprovalRequest } from '../trueforge/agentRunner';

type ToWebview =
  | { kind: 'user'; text: string }
  | { kind: 'text'; id: string; thread: string; text: string }
  | { kind: 'tool'; id: string; thread: string; name: string; args: string }
  | { kind: 'toolResult'; id: string; text: string }
  | { kind: 'thread'; thread: string; title: string; done?: boolean }
  | { kind: 'status'; text: string; level: string }
  | { kind: 'session'; sessionId: string; model: string; url: string }
  | { kind: 'running'; running: boolean }
  | { kind: 'usage'; text: string };

export class AgentViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private running = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly getRunner: () => Promise<AgentRunner>,
    private readonly baseUrl: () => string,
    private readonly approve: (req: ApprovalRequest) => Promise<ApprovalDecision>,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(async (m: { kind: string; text?: string; url?: string }) => {
      if (m.kind === 'send' && m.text?.trim()) await this.send(m.text.trim());
      if (m.kind === 'cancel') await this.cancel();
      if (m.kind === 'new') await this.newSession();
      if (m.kind === 'open' && m.url) void vscode.env.openExternal(vscode.Uri.parse(m.url));
    });
  }

  post(msg: ToWebview): void { void this.view?.webview.postMessage(msg); }

  async newSession(): Promise<void> {
    if (this.running) await this.cancel();
    (await this.getRunner()).reset();
    void this.view?.webview.postMessage({ kind: 'clear' });
  }

  async cancel(): Promise<void> {
    if (!this.running) return;
    this.post({ kind: 'status', text: 'Cancelling…', level: 'warn' });
    await (await this.getRunner()).cancel();
  }

  async send(text: string): Promise<void> {
    if (this.running) { this.post({ kind: 'status', text: 'A run is already in progress. Cancel it first.', level: 'warn' }); return; }
    this.running = true;
    this.post({ kind: 'running', running: true });
    this.post({ kind: 'user', text });
    try {
      const runner = await this.getRunner();
      const result = await runner.run(text, {
        onEvent: (e, merged) => this.render(e, merged),
        onStatus: (t, level = 'info') => this.post({ kind: 'status', text: t, level }),
        onSession: ({ sessionId, model }) => this.post({ kind: 'session', sessionId, model, url: `${this.baseUrl()}/sessions/${sessionId}` }),
        onApproval: this.approve,
      });
      if (result.status === 'cancelled') this.post({ kind: 'status', text: 'Run cancelled. No pending changes were applied; the workspace is unchanged.', level: 'warn' });
      else if (result.status === 'error') this.post({ kind: 'status', text: `Run failed: ${result.error}. The workspace is unchanged.`, level: 'error' });
      else this.post({ kind: 'status', text: `Done (model: ${result.model}).`, level: 'info' });
    } catch (err) {
      this.post({ kind: 'status', text: `Unexpected error: ${(err as Error).message}`, level: 'error' });
    } finally {
      this.running = false;
      this.post({ kind: 'running', running: false });
    }
  }

  private render(e: TrueForgeApi.TurnStreamingEvent, merged?: TrueForgeApi.TurnStreamingEvent): void {
    const thread = (e as { threadId?: string | null }).threadId ?? 'main';
    switch (e.type) {
      case 'model.message': {
        const content = typeof e.content === 'string' ? e.content : '';
        if (content) this.post({ kind: 'text', id: e.id, thread, text: content });
        for (const tc of e.toolCalls ?? []) {
          this.post({ kind: 'tool', id: tc.id, thread, name: (tc.toolInfo as { name?: string }).name ?? tc.function.name, args: tc.function.arguments ?? '' });
        }
        if (e.usage) {
          const u = e.usage as { inputTokens?: number; outputTokens?: number };
          this.post({ kind: 'usage', text: `context: ${u.inputTokens ?? '?'} in / ${u.outputTokens ?? '?'} out tokens` });
        }
        break;
      }
      case 'model.message.delta': {
        const m = merged as TrueForgeApi.ModelMessageEvent | undefined;
        const content = m && typeof m.content === 'string' ? m.content : (typeof e.content === 'string' ? e.content : '');
        this.post({ kind: 'text', id: e.id, thread, text: content });
        if (m?.toolCalls?.length) {
          for (const tc of m.toolCalls) this.post({ kind: 'tool', id: tc.id, thread, name: (tc.toolInfo as { name?: string })?.name ?? tc.function.name, args: tc.function.arguments ?? '' });
        }
        break;
      }
      case 'tool.response':
        this.post({ kind: 'toolResult', id: e.toolCallId, text: e.content });
        break;
      case 'thread.created':
        this.post({ kind: 'thread', thread, title: (e as { title?: string }).title ?? 'subagent' });
        break;
      case 'thread.done':
        this.post({ kind: 'thread', thread, title: (e as { title?: string }).title ?? 'subagent', done: true });
        break;
      case 'tool.approval_required':
        this.post({ kind: 'status', text: 'Waiting for your review of proposed changes…', level: 'info' });
        break;
      default:
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'panel.js'));
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<header><span id="model">no session</span><a id="session" href="#" hidden>TrueForge session ↗</a><button id="new" title="New session">New</button></header>
<main id="log"></main>
<div id="status"></div>
<footer><textarea id="input" rows="3" placeholder="Ask Forge to change the code… (@file:path, @symbol:name). Enter to send, Shift+Enter for newline"></textarea>
<div class="row"><span id="usage"></span><button id="cancel" disabled>Cancel</button><button id="send">Send</button></div></footer>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
