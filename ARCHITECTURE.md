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
          │ deferred tools, subagents, compaction, sessions      │
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
