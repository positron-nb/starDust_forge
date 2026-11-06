# Technical Research (Phase 0)

Sources inspected: `truefoundry/trueforge` @ `9900d65e0a0f1af20004f1d42e1ca07facb3f416` (2026-11-05), its `docs/` (mdx + `openapi.json`) and `packages/trueforge-core` source. Every claim below was read from those files, not assumed.

## TrueForge facts that shape the design

| Topic | Finding | Source |
|---|---|---|
| Run locally | `npx @truefoundry/trueforge@latest` → server + UI on `http://localhost:8790`, SQLite, no login | README, docs/quickstart.mdx |
| SDK | `@truefoundry/trueforge-sdk`: `new TrueForge({baseUrl, timeoutInSeconds})`, `sessions.create({agent:{spec}\|{name}})`, `sessions.createTurnStream(id,{input:[{type:'user.message',content}]})`, `stream.withMetadata()`, `isEventDelta`/`mergeEventDelta`, `sessions.cancel`, `getTurn`, `subscribeToTurn({afterSequenceNumber})`, `listTurnEvents` | docs/api/*.mdx |
| Event types | `turn.created`, `mcp.initialize`, `model.message`, `model.message.delta` (merged by `id`), `tool.response`, `tool.approval_required`, `tool.response_required`, `thread.created`/`thread.done` (subagents), `mcp.auth_required`, `turn.done` (`state.status`, `state.output`, `required_actions`) | docs/api/overview.mdx, use-agent.mdx |
| Agent spec | `model{name,params}`, `instructions`, `mcp_servers[{name,enable_tools,disable_tools,preload_tools,require_approval_for_tools,preload}]`, `skills`, `config{sandbox,dynamic_sub_agents,context_management{compaction,large_tool_response},iteration_limit,...}` | docs/create-agent/overview.mdx |
| MCP | Remote (HTTP) MCP servers only, registered by name. Programmatic registration: `POST/PUT /api/v1/settings/mcp-servers` | docs/mcp-servers.mdx, openapi.json |
| SSRF guard | Outbound fetches deny private/loopback IPs unless host listed in env `OUTBOUND_URL_ALLOWED_HOSTS` (JSON array) or `NETWORK_POLICY_ENABLED=false` | core/util/ssrfGuard.ts, trueforge/src/main.ts |
| Models | Providers `openai`, `anthropic`, `google-gemini`, `fireworks`, `together`, …, `custom` (OpenAI-compatible). Configured in Settings or `POST /api/v1/settings/model-providers`. Model FQN `provider/model`. | docs/models.mdx |
| Fallback | **No native multi-model fallback** ("Planned" note in models.mdx). → implement client-side: on failed turn, open a new TrueForge session with the next configured model. Still 100% TrueForge-driven. | docs/models.mdx |
| Context features | Deferred tool loading (default, `preload:false`), subagents (default on), compaction, large-tool-response offloading, Code Mode (needs sandbox) | docs/key-features/* |
| Approvals | `require_approval_for_tools` pauses with `tool.approval_required`; resume with `user.tool_approval` turn | use-agent.mdx |

## Design consequences
1. The extension hosts a **Streamable-HTTP MCP server on 127.0.0.1:<port>** inside the extension host process and registers it with TrueForge via the settings API. TrueForge drives the loop and calls back into our tools.
2. Write tools never touch disk: `propose_edit` stores a pending change in the extension's ChangeSet; disk is only written after user approval in the diff review. This gives cancellation safety for free.
3. Fallback = client-side session re-creation on `turn.done` with error status / transport error.
4. Advanced features used meaningfully: deferred tool loading for the large toolset, `preload_tools` for core tools, compaction, and subagents for repo exploration in Agent Mode.

## Open items to verify in the PoC
- Exact MCP server registration payload (read from openapi.json schema).
- Whether TrueForge marks tool annotations (`readOnlyHint`) → affects `@write` approvals.
- Error surface when model key is invalid (turn.done status vs. HTTP error).

## Findings from the official PDF (read in full, 13 pages) that go beyond the brief
- **B4 = 7 needs "TrueForge tool approval driving the diff review".** → `propose_edit` is annotated as a write tool and listed in `require_approval_for_tools`. The `tool.approval_required` event opens our hunk-level diff review; the user's hunk choices are stored per tool-call; we resume with `user.tool_approval` (allow if ≥1 hunk accepted, deny otherwise); when TrueForge then executes `propose_edit`, only the accepted hunks get applied. B4 = 10 also needs a context-engineering feature that is **visible in the session** (deferred tools / subagents).
- **B1 = 15:** retrieval with a size budget, *visibly at work in Task B* ("the agent shows which files it chose and why").
- **B3 = 10:** automatic fallback to a 2nd model with no user action, workspace unchanged.
- **Fairness:** organisers may re-run Task A live with *their* model → nothing may depend on one provider; prompts/tools must work with weaker models.
- **Repo must contain the agent definition** used; README must say how to load it; example model config; no secrets.
- Video ≤ 4 min, order A → B → C, no cut between instruction and diff appearing; TrueForge session shown in B.
- Write-up: 1–3 pages, 8 fixed headings; scorecard with timestamps per criterion.
- Judges read git history from the fork point → commit in small, meaningful steps. We're starting **from scratch** (and reusing only small, attributed pieces if needed).

## PoC results (2026-11-06, VERIFIED)
- `poc/poc.mjs` with `google-gemini/gemini-3-5-flash`: turn.created → mcp.initialize → model.message (tool call) → **our localhost MCP `read_file` executed** → tool.response → model.message + deltas → turn.done(status=done). Usage breakdown is reported per turn (harness/instructions/toolDefinitions/messages tokens) — useful for the context-budget UI.
- `poc/fail.mjs`: custom provider `broken` → `http://127.0.0.1:9/v1` produces `turn.done {status:"error", message:"[Model Error] Cannot connect to API: …"}` in ~40 ms, no exception. → Fallback trigger: `status==="error"` with a `[Model Error]` prefix → re-run on a new session with the next model.
- The SDK uses **camelCase** request fields (`baseUrl`, `apiKey`, `modelId`, `contextLength`, `maxOutputTokens`); the raw HTTP API uses snake_case.
- Private IPs other than allow-listed hosts are rejected at provider creation (`Outbound URL blocked`).
