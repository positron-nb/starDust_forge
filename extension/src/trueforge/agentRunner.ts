/**
 * AgentRunner: the extension's only path to a model. It is a *client* of a
 * TrueForge agent — it opens sessions, sends turns, renders streamed events and
 * answers approval pauses. The agent loop itself runs inside TrueForge.
 *
 * Resilience: model failures surface as `turn.done {status:"error"}` with a
 * "[Model Error]" message (verified in poc/fail.mjs). Transient errors are
 * retried with exponential backoff; persistent ones fail over to the next model
 * in `forge.models`, on a fresh session, with no user action.
 */
import { TrueForge, TrueForgeApi, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';

type Ev = TrueForgeApi.TurnStreamingEvent;
type Input = NonNullable<TrueForgeApi.CreateTurnSessionsStreamRequest['input']>;

export interface AgentSpec {
  instructions: string;
  mcpServers: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
}

export interface ApprovalRequest {
  threadId: string;
  toolCallId: string;
  toolName: string;
  serverName?: string;
  args: unknown;
}
export type ApprovalDecision = { allow: true } | { allow: false; reason?: string };

export interface RunHooks {
  /** Every non-delta event, plus each delta after it is merged into its base event. */
  onEvent?(e: Ev, merged?: Ev): void;
  onStatus?(msg: string, level?: 'info' | 'warn' | 'error'): void;
  onSession?(info: { sessionId: string; model: string }): void;
  /** Called when TrueForge pauses for tool approval. Resolve to decide. */
  onApproval?(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface RunResult {
  status: 'done' | 'cancelled' | 'error';
  output?: string;
  model?: string;
  sessionId?: string;
  error?: string;
}

const TRANSIENT = /(429|rate.?limit|overloaded|503|502|timeout|ECONNRESET|temporar)/i;
const MAX_RETRIES_PER_MODEL = 2;
const MAX_HINTED_RETRIES = 8;

export class AgentRunner {
  private client: TrueForge;
  private sessionId?: string;
  private modelIndex = 0;
  private abort?: AbortController;
  private cancelled = false;

  constructor(private readonly opts: { baseUrl: string; models: string[]; spec: AgentSpec; sleep?: (ms: number) => Promise<void> }) {
    if (opts.models.length === 0) throw new Error('forge.models is empty: configure at least one model FQN.');
    this.client = new TrueForge({ baseUrl: opts.baseUrl, timeoutInSeconds: 900 });
  }

  get currentModel(): string { return this.opts.models[this.modelIndex]; }
  get currentSessionId(): string | undefined { return this.sessionId; }
  get sdk(): TrueForge { return this.client; }

  /** Start fresh: the next run opens a new session on the primary model. */
  reset(): void { this.sessionId = undefined; this.modelIndex = 0; }

  /** Immediate cancellation: abort the SSE stream and cancel the TrueForge turn. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    this.abort?.abort();
    if (this.sessionId) {
      try { await this.client.sessions.cancel(this.sessionId); } catch { /* turn may already be finished */ }
    }
  }

  async run(userMessage: string, hooks: RunHooks = {}): Promise<RunResult> {
    this.cancelled = false;
    const firstInput: Input = [{ type: 'user.message', content: userMessage }];

    for (; this.modelIndex < this.opts.models.length; this.modelIndex++) {
      const model = this.currentModel;
      for (let attempt = 0; attempt <= MAX_HINTED_RETRIES; attempt++) {
        if (this.cancelled) return { status: 'cancelled', model };
        let result: RunResult;
        try {
          let input = firstInput;
          if (!this.sessionId) {
            const { data } = await this.client.sessions.create({
              agent: { spec: { model: { name: model }, instructions: this.opts.spec.instructions,
                mcpServers: this.opts.spec.mcpServers, config: this.opts.spec.config } as never },
            });
            this.sessionId = data.id;
            hooks.onSession?.({ sessionId: data.id, model });
          } else if (attempt > 0) {
            // Same session after a transient error: the request and any tool results are already in
            // the session history, so ask the agent to continue instead of repeating the request.
            input = [{ type: 'user.message', content: 'The previous attempt was interrupted by a transient model/provider error. Continue the task from where you left off; do not redo completed steps.' }];
          }
          result = await this.driveTurns(input, hooks);
        } catch (err) {
          if (this.cancelled) return { status: 'cancelled', model };
          result = { status: 'error', error: describe(err) };
        }
        if (result.status !== 'error') return { ...result, model, sessionId: this.sessionId };

        const msg = result.error ?? 'unknown error';
        // A provider that states how long to wait (per-minute token/request limits) gets more
        // patience: waiting is the correct fix there, falling back would only burn other quotas.
        const maxRetries = providerWaitHintMs(msg) !== undefined ? MAX_HINTED_RETRIES : MAX_RETRIES_PER_MODEL;
        if (TRANSIENT.test(msg) && attempt < maxRetries) {
          const delay = retryDelayMs(msg, attempt);
          hooks.onStatus?.(`${model}: ${summarizeError(msg)} Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 2}/${maxRetries + 1}).`, 'warn');
          await (this.opts.sleep ?? sleep)(delay);
          continue;
        }
        const next = this.opts.models[this.modelIndex + 1];
        hooks.onStatus?.(next
          ? `${model} failed: ${summarizeError(msg)} Falling back to ${next} automatically.`
          : `${model} failed: ${summarizeError(msg)} No more fallback models configured.`, next ? 'warn' : 'error');
        this.sessionId = undefined; // a fallback model gets a fresh TrueForge session
        if (!next) return { status: 'error', error: summarizeError(msg), model };
        break;
      }
    }
    return { status: 'error', error: 'all models failed' };
  }

  /** Runs one user turn plus any approval-resume turns until the agent is done. */
  private async driveTurns(input: Input, hooks: RunHooks): Promise<RunResult> {
    let nextInput: Input | undefined = input;
    while (nextInput) {
      const events = new Map<string, Ev>();
      const approvals: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
      let done: TrueForgeApi.TurnDoneEvent | undefined;

      this.abort = new AbortController();
      const stream = await this.client.sessions.createTurnStream(this.sessionId!, { input: nextInput },
        { abortSignal: this.abort.signal, timeoutInSeconds: 900 });
      for await (const { data: e } of stream.withMetadata()) {
        if (isEventDelta(e)) {
          const base = events.get(e.id);
          if (base) mergeEventDelta(base, e);
          hooks.onEvent?.(e, base);
          continue;
        }
        events.set(e.id, e);
        hooks.onEvent?.(e);
        if (e.type === 'tool.approval_required') approvals.push(e);
        if (e.type === 'turn.done') done = e;
      }
      if (this.cancelled) return { status: 'cancelled' };
      if (!done) return { status: 'error', error: 'stream ended without turn.done' };

      const state = done.state as { status: string; message?: string; output?: { content?: unknown } };
      if (state.status === 'error') return { status: 'error', error: state.message ?? 'model error' };
      if (state.status === 'cancelled') return { status: 'cancelled' };
      if (approvals.length === 0) {
        return { status: 'done', output: typeof state.output?.content === 'string' ? state.output.content : '' };
      }

      // Paused for approval: ask the editor (diff review) for each call, then resume.
      const decisions: Input = [];
      for (const pause of approvals) {
        for (const ref of pause.toolCalls) {
          const src = events.get(ref.sourceEventId) as TrueForgeApi.ModelMessageEvent | undefined;
          const call = src?.toolCalls?.find(tc => tc.id === ref.id);
          let args: unknown = {};
          try { args = JSON.parse(call?.function.arguments || '{}'); } catch { args = call?.function.arguments; }
          const info = call?.toolInfo as { name?: string; serverName?: string } | undefined;
          const u = unwrapDeferred(info?.name ?? call?.function.name ?? 'unknown', info?.serverName, args);
          const req: ApprovalRequest = { threadId: pause.threadId, toolCallId: ref.id, toolName: u.name, serverName: u.server, args: u.args };
          const d: ApprovalDecision = hooks.onApproval ? await hooks.onApproval(req) : { allow: false, reason: 'no approval handler' };
          if (this.cancelled) return { status: 'cancelled' };
          decisions.push({ type: 'user.tool_approval', threadId: pause.threadId, toolCallId: ref.id,
            approval: d.allow ? { status: 'allow' } : { status: 'deny', reason: d.reason ?? 'Rejected by the user in diff review.' } });
        }
      }
      nextInput = decisions;
    }
    return { status: 'done' };
  }
}

/**
 * TrueForge deferred tool loading routes non-preloaded tools through the meta-tool
 * `call_tool {mcp_server, tool_name, input}`. Unwrap it so approvals and the UI see the real tool.
 */
export function unwrapDeferred(name: string, server: string | undefined, args: unknown): { name: string; server?: string; args: unknown; deferred: boolean } {
  const a = args as { mcp_server?: string; tool_name?: string; input?: unknown } | undefined;
  if (name === 'call_tool' && a?.tool_name) return { name: a.tool_name, server: a.mcp_server, args: a.input ?? {}, deferred: true };
  return { name, server, args, deferred: false };
}

/** Turns a raw provider error into one short, human-readable line. */
export function summarizeError(msg: string): string {
  const retry = /retry (?:in|after) ([\d.]+)\s*s/i.exec(msg);
  if (/429|quota|rate.?limit/i.test(msg)) return `Rate limit / quota exceeded at the provider (429)${retry ? `; provider asks to wait ${Math.ceil(+retry[1])}s` : ''}.`;
  if (/cannot connect|ECONNREFUSED|ENOTFOUND|bad port|fetch failed/i.test(msg)) return 'Model endpoint unreachable (connection failed).';
  if (/401|403|invalid.*key|unauthori[sz]ed|permission/i.test(msg)) return 'Model provider rejected the API key (auth error).';
  if (/Unknown model/i.test(msg)) return `Model is not configured in TrueForge (${/"([^"]+)"/.exec(msg)?.[1] ?? 'unknown'}).`;
  const first = msg.replace(/^\[Model Error\]\s*/, '').split(/\n/)[0];
  return first.length > 160 ? first.slice(0, 157) + '…' : first;
}

/** Provider-stated wait ("retry in 26s", "Please try again in 13.8s", "retry after 2m0.5s"), if ≤ 65 s. */
export function providerWaitHintMs(msg: string): number | undefined {
  const m = /(?:retry|try again) (?:in|after) (?:(\d+)m)?([\d.]+)\s*s/i.exec(msg);
  if (!m) return undefined;
  const ms = Math.ceil(((m[1] ? +m[1] * 60 : 0) + parseFloat(m[2])) * 1000) + 500;
  return ms <= 65_000 ? ms : undefined;
}

/** Exponential backoff (2s, 4s, …), but honour a provider's wait hint. */
export function retryDelayMs(msg: string, attempt: number): number {
  return providerWaitHintMs(msg) ?? 2000 * 2 ** attempt;
}

function describe(err: unknown): string {
  const e = err as { statusCode?: number; body?: unknown; message?: string };
  if (e?.body) return `HTTP ${e.statusCode ?? ''} ${JSON.stringify(e.body)}`.trim();
  return e?.message ?? String(err);
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
