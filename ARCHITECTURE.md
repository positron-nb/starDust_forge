# Architecture

```
┌──────────────────────── VS Code extension host (TypeScript) ────────────────────────┐
│ UI layer: Agent panel (webview) · Inline-edit command (Ctrl+Shift+I) · Diff review  │
│            ▲ streamed events                     │ user turns / cancel              │
│ TrueForge client: session mgr · turn streaming · cancel · model fallback chain      │
│            │ HTTP/SSE (SDK)                                                         │
│ MCP server (Streamable HTTP, 127.0.0.1:random, bearer token)                        │
│   read_file · list_files · search_workspace · find_symbol · get_context ·          │
│   propose_edit · run_command · get_diagnostics                                      │
│            │ calls                                                                  │
│ Context engine: file index · symbol index (regex/AST-lite) · import graph ·         │
│                 ripgrep · BM25-style ranking · token budget packer · explanations   │
│ Change manager: ChangeSet (pending, in memory) · hunk diff · apply accepted ·       │
│                 WorkspaceEdit (undoable) · snapshot rollback · cancel = discard     │
└─────────────────────────────────────────────────────────────────────────────────────┘
                 ▲ MCP tool calls                       │ model calls
          ┌──────┴───────────────────────────────────────▼──────┐
          │ TrueForge (local npx, :8790) — agent loop, models,   │
          │ deferred tools, compaction, approvals, sessions      │
          └──────────────────────────────────────────────────────┘
```

## Key decisions
- **TrueForge is the only loop.** The extension never calls a model API; it only creates sessions/turns and serves MCP tools.
- **No silent writes.** `propose_edit` only records intent. Disk changes happen exclusively via the Diff Review after explicit accept, applied as a single `WorkspaceEdit` (undoable with one command; snapshot kept for "Undo agent changes").
- **Cancellation** = `sessions.cancel` + abort SSE + discard the pending ChangeSet. Because nothing was on disk, the workspace is unchanged.
- **Inline edit** reuses the same pipeline: a dedicated session with instructions to call `propose_edit` for the selected range; result shown as diff with hunk accept/reject.
- **Fallback:** ordered model list in settings (`forge.models`). On error, the turn is retried on a new session with the next model; UI shows which model answered.
- **Security:** all paths resolved and checked inside workspace root; `.env`, keys, `.git/` denied; `run_command` uses an allow/deny policy and asks for confirmation in VS Code unless allow-listed.

## Approval-driven diff review (from PDF criterion B4)
1. Agent calls `propose_edit(path, edits)` → TrueForge pauses the turn with `tool.approval_required` (tool is in `require_approval_for_tools`).
2. Extension reads the tool-call arguments from the matching `model.message`, computes hunks, and opens the diff review.
3. User accepts/rejects individual hunks → decision stored by `tool_call_id`.
4. Extension sends a `user.tool_approval` turn (allow if any hunk accepted, deny otherwise).
5. TrueForge executes `propose_edit`; our MCP handler applies **only the accepted hunks** as one undoable `WorkspaceEdit` and returns a summary of what was applied/rejected, so the agent knows.
Cancel at any point → `sessions.cancel`; unapproved proposals never touch disk.

## Context engine (Phase 3/4, implemented)
`get_context(query, budget_tokens)` — the agent's first call (preloaded tool, instructions say "START HERE").
1. **Index** (`context/index.ts`): incremental (mtime) parse of code + docs into symbol chunks — Python by indentation, C-like by brace balance, `.rst/.md` by section. Flask: 165 files / 2084 symbols in ~210 ms.
2. **Lexical recall**: BM25 over identifier-aware tokens (`routes_command` → routes, command), field-weighted name ×4 > doc ×2 > path ×1.5 > body ×1.
3. **Structural signals**: exact code-identifier hits ×2.5 (only snake/camel/dotted/quoted — plain English words don't count), nested helpers ×0.4, "hot files" = sum of a file's 3 best chunks.
4. **Graph expansion**: Python/JS import graph (relative imports resolved), test counterparts (`tests/test_<module>.py`), importers of the hottest files.
5. **Budget packing**: outlines of the 3 hottest files first (≤35 % of budget), then greedy snippets ≤60 lines, ≤5 per file, no overlapping ranges; class chunks render as header + method list. Dropped candidates are listed with the reason (budget / cap).
6. **Explainability**: every item carries reasons; the panel renders a live "Context selected" table with a budget bar.
Explicit context: `@file:path` (full if ≤250 lines else outline) and `@symbol:name` resolved locally into a `<pinned_context>` block (own 5k budget); unresolved mentions are reported.
Semantic embeddings were deliberately not used: they need a second model/provider (breaks "works with any configured model"), add indexing latency, and lexical+structural retrieval already finds every file Task B needs.
