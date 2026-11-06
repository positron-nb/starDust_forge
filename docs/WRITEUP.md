# Forge Agent — TrueFoundry Forge-a-thon Round 1 write-up

> Draft. Fields marked **TODO** must be filled from the final recording/team details — never invented.

## 1. Team
TODO: team name, members, college/employer, GitHub handles.

## 2. Starting point
From scratch — no upstream fork. Third-party code is limited to ordinary dependencies: `@truefoundry/trueforge-sdk` (MIT), `@modelcontextprotocol/sdk` (MIT), `zod` (MIT), `diff`/jsdiff (BSD-3-Clause). Repository: TODO public URL.

## 3. Architecture on TrueForge
The VS Code extension is a **TrueForge client**; TrueForge runs the agent loop in local mode (`npx @truefoundry/trueforge@latest`).
- **Sessions & turns:** `@truefoundry/trueforge-sdk` — `sessions.create` with the agent spec from `agent/forge-coder.json` (also saved as agent *forge-coder* by `scripts/setup-trueforge.mjs`), `sessions.createTurnStream`, `isEventDelta/mergeEventDelta` for token streaming, `sessions.cancel` + SSE abort for cancellation.
- **Editor capabilities as MCP tools:** the extension hosts a Streamable-HTTP MCP server on 127.0.0.1 (random port, per-session bearer token) and registers it as a TrueForge connector with header auth. Tools: `get_context`, `find_symbol`, `read_file`, `list_files`, `search_workspace`, `propose_edit`, `run_command`.
- **Tool approval drives the diff review:** `propose_edit` and `run_command` are in `require_approval_for_tools`. On `tool.approval_required` the extension reads the call's arguments, opens a hunk review (diff editor + panel card), and answers with `user.tool_approval`. When TrueForge then executes `propose_edit`, our handler writes **only the accepted hunks**, after checking the file is unchanged since review; unreviewed calls write nothing.
- **Harness features used:** *Deferred tool loading* (`preload: false` + `preload_tools` for the four core tools; the rest are reached via TrueForge's `call_tool`, shown as ⟨deferred⟩ in the panel and unwrapped so a deferred `propose_edit` still goes through review); *dynamic subagents* (enabled; their threads render nested in the panel); *compaction* (enabled for long Task-B-style runs). Sandbox disabled on purpose so no file can change outside our reviewed tool.
- **Resilience:** model failures arrive as `turn.done{status:"error","[Model Error] …"}`. The runner retries transient errors with exponential backoff (honouring "retry in N s" hints) and then **falls back automatically** to the next model in `forge.models` on a fresh session; errors are summarised in one line.

## 4. How context is selected
Retrieval is lexical + structural, budgeted, and explained (`extension/src/context/`):
1. Incremental index of code and docs into symbol chunks (Python by indentation, C-like by braces, rst/md by section); Flask: 165 files / 2,084 symbols in ≈210 ms.
2. BM25 over identifier-aware tokens (`routes_command` → routes, command) with field weights (name 4 > doc 2 > path 1.5 > body 1).
3. Boosts: exact code identifiers from the request (×2.5; plain English words excluded), nested helpers ×0.4, "hot files" ranked by their 3 best chunks.
4. Graph expansion: Python/JS import graph, test counterparts (`tests/test_<module>.py`), importers of hot files.
5. Budget packing (default 6,000 tokens, max 24,000): outlines of the 3 hottest files first (≤35 %), then snippets ≤60 lines, ≤5 per file, no overlaps; dropped candidates listed with the reason.
6. Every item carries a reason; the panel shows a live "Context selected" table with a budget bar (visible in Task B).
Explicit context: `@file:path` (full ≤250 lines, otherwise an outline) and `@symbol:name` → `<pinned_context>` block with its own 5k budget.
*Trade-off:* no embeddings — they would need a second provider (breaking "any configured model"), add indexing latency, and lexical+structural signals already surface every file the fixed tasks need.

## 5. Model setup
| Model | Where | Role | Cost |
|---|---|---|---|
| `google-gemini/gemini-3-5-flash` | Google AI Studio API, free tier | primary | ₹0 (free tier, 5 req/min) |
| `google-gemini/gemini-3-1-flash-lite` | same | automatic fallback | ₹0 |
| `broken/dead-model` (custom → `http://127.0.0.1:9/v1`) | unreachable on purpose | Task C | — |
TODO: add any paid model used for the final recording, with cost.
Switching models: edit `forge.models` (ordered fallback list) in VS Code settings; any provider configured in TrueForge works.

## 6. Scorecard
TODO after recording — one row per criterion with the real video timestamp.

| Criterion | Timestamp | Claim |
|---|---|---|
| A1 Inline edit | TODO | Diff in editor with per-hunk accept/reject |
| A2 Agent mode | TODO | Task B: ≥3 files discovered and edited unprompted |
| A3 Streaming & cancellation | TODO | Tokens stream; cancel mid-run leaves `git status` clean |
| B1 Context assembly | TODO | Budgeted retrieval with reasons visible in Task B |
| B2 Diff safety | TODO | Per-hunk review + undo of an applied change |
| B3 Resilience | TODO | Unreachable endpoint → automatic fallback, workspace unchanged |
| B4 TrueForge depth | TODO | MCP tools; approval drives review; deferred tools + subagents in session |
| C1 Video | — | Tasks A, B, C in order, verified on screen |

## 7. Tools used
Claude Code (Claude Opus 5.5) as an AI coding assistant for research, implementation and tests; VS Code; TrueForge local mode; ripgrep; vitest; esbuild.

## 8. Known limitations and what we would do with another month
- Fallback restarts the task on a fresh session; edits already applied in the run stay (and are undoable as a run) but the new model re-reads them. Next: replay the transcript into the fallback session.
- Commands are approval-gated but a user-approved command could still modify files outside the review path.
- Symbol parsing is heuristic (indentation/braces); a tree-sitter index would handle edge cases and more languages.
- Diff CodeLens inside VS Code's diff editor requires `diffEditor.codeLens`; we rely on decorations, title-bar actions, Alt+Y/Alt+N and the panel card instead.
- Free-tier rate limits (5 req/min) make Task B slow; retries and fallback keep it correct, not fast.
- Next month: embeddings as an optional re-ranker, TrueForge skills for repo conventions, multi-file atomic "apply all at end" mode, and a Round-2 PR to TrueForge adding native model fallback.
