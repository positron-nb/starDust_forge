# Architecture

```
┌──────────────────────── VS Code extension host (TypeScript) ────────────────────────┐
│ UI:  Agent panel (webview) · Inline edit (Ctrl+Alt+E) · Diff review (native diff)   │
│        ▲ streamed events                         │ user turns / approvals / cancel  │
│ TrueForge client (AgentRunner): sessions · turn streaming · approvals on the paused │
│        turn · retry on provider hints · model fallback + handoff · completion check │
│        │ HTTP/SSE (@truefoundry/trueforge-sdk)                                      │
│ MCP server (Streamable HTTP, 127.0.0.1:random port, bearer token)                   │
│   get_context · read_file · read_files · search_workspace · propose_edit ·          │
│   task_state   (deferred: run_commands · run_command · find_symbol · list_files)    │
│        │                                                                            │
│ Context engine     symbol index · BM25 · import graph · budget packer · reasons     │
│ Change manager     proposals · hunks · apply accepted only · undo · cancel=discard  │
│ Edit guards        unique match · no deleted definitions · no rewritten tests ·     │
│                    Python syntax · stale-file check                                 │
│ Task ledger        task · plan + planned files · reads · edits · test status        │
└─────────────────────────────────────────────────────────────────────────────────────┘
               ▲ MCP tool calls                          │ model calls
        ┌──────┴────────────────────────────────────────▼───────┐
        │ TrueForge 0.185 (local, :8790): agent loop, model      │
        │ providers, deferred tools, approvals, compaction       │
        └────────────────────────────────────────────────────────┘
```

## Key decisions
- **TrueForge is the only agent loop.** The extension never calls a model provider. It creates sessions and turns, answers approvals and serves MCP tools.
- **No silent writes.** `propose_edit` is in `require_approval_for_tools`. TrueForge pauses; the extension shows the diff; the tool handler later writes only the hunks the user accepted, and only if the file is unchanged since review.
- **Cancellation** aborts the SSE stream, cancels the TrueForge turn, closes open reviews and drops every approved-but-unapplied edit. Nothing was on disk, so the workspace is unchanged.
- **Inline edit** uses the same pipeline with a short-lived session and inline-specific instructions. The ledger gates are off in inline mode.
- **Security:** paths are resolved inside the workspace; `.git/`, `.env*` and key files are denied. Commands are approval-gated, have a hard deny-list, and the batch tool runs argv lists without a shell.

## Approval-driven diff review
1. The agent calls `propose_edit(path, edits)`. TrueForge emits `tool.approval_required` and pauses the turn (`turn.update {status: "paused"}`).
2. The extension reads the call's arguments from the matching `model.message`, applies the edit guards, computes hunks and opens a native diff editor (both sides are virtual documents).
3. The user accepts or rejects each hunk (CodeLens, Alt+Y / Alt+N, or the panel card) and applies the decisions.
4. The extension posts `user.tool_approval` to the paused turn (`createTurnEvents`) and resumes the stream (`subscribeToTurn`, `afterEventId`). Servers older than 0.185 ended the turn instead; that path is still supported.
5. TrueForge executes `propose_edit`. The handler writes only the accepted hunks as one undoable `WorkspaceEdit` and tells the agent what was applied or rejected.

## Deferred tool loading (TrueForge context engineering)
`preload: false` with `preload_tools` for the tools used throughout a task. The verification tools (`run_commands`, `run_command`) and the rarely needed `find_symbol`/`list_files` stay deferred: their schemas are not resent with every exploration and edit request, and the agent reaches them at the end of the task through TrueForge's `list_tools` → `get_tool_info` → `call_tool` (visible in the session). Approvals see through `call_tool`, so a deferred command still needs the user's OK. Earlier measurement: deferring always-needed tools cost 32% of calls, so only end-of-task and rare tools are deferred.

## Loop detector
If the model makes the same failing tool call (same tool, same arguments) 3 times in a row, the runner stops the turn and sends a corrective message (max 2 per run), instead of letting it burn requests. Seen before the fix: a small local model repeated one invalid `call_tool` 90 times.

## Edit guards (before any diff is shown)
An edit is refused, with a reason the agent can act on, if it:
- does not match uniquely (tolerant matching: exact, then without line-number prefixes, then whitespace-insensitive);
- deletes a function, class or module-level assignment that existed before the run (unless `confirm_removal` names it);
- changes the text of a test that existed before the run;
- makes a Python file fail `ast.parse`.

## Task ledger and gates (`src/agent/ledger.ts`)
Tool handlers fill the ledger without extra model calls; `task_state` returns it and stores the plan with `planned_files`.
- **Survives compaction:** after a context summary the agent calls `task_state` instead of re-reading files.
- **Edits before verification:** after the first applied edit, commands are refused while planned files are unedited.
- **Loop brake:** at most 4 command calls in a row without an applied edit.
- **Completion check:** when the agent ends its turn, the runner sends one follow-up turn (max 2) if a planned file has no edit or tests did not pass after the last edit.
- **Fallback handoff:** when a model fails, the next model's fresh session receives the task plus the ledger.

## Context engine
`get_context(query, budget_tokens)` is the agent's first call.
1. **Index:** incremental parse of code and docs into symbol chunks (Python by indentation, C-like by braces, rst/md by section). Flask: 165 files / 2,084 symbols in about 210 ms.
2. **Lexical recall:** BM25 over identifier-aware tokens, weighted name ×4 > doc ×2 > path ×1.5 > body ×1.
3. **Structural signals:** exact code identifiers from the request ×2.5, nested helpers ×0.4, "hot files" scored by their 3 best chunks.
4. **Graph expansion:** import graph (importers and dependencies of hot files) and test counterparts.
5. **Budget packing:** outlines of the 3 hottest files first (≤35% of the budget), then snippets ≤60 lines, ≤5 per file, no overlaps. Dropped candidates are listed with the reason.
6. **Explainability:** every item carries reasons; the panel shows a "Context selected" table with a budget bar.

Explicit context: `@file:path` and `@symbol:name` are resolved locally into a pinned block with its own budget.
Embeddings were not used: they need a second provider, add indexing latency, and lexical plus structural retrieval already finds the files the fixed tasks need.

## Testing
- `npm test`: 70 unit tests (vitest).
- `npm run test:ui`: 10 integration tests inside a real VS Code extension host (diff editor, hunk commands, apply, undo, cancel, stale file, guards).
- `bench/run.sh`: the real TrueForge pipeline headless, with provider-reported usage, test results and diffs saved under `bench/results/`.
