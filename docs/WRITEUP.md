# Forge Agent — TrueFoundry Forge-a-thon Round 1 write-up

> Draft. Fields marked **TODO** must be filled from the final recording/team details — never invented.

## 1. Team
TODO: team name, members, college/employer, GitHub handles.

## 2. Starting point
From scratch — no upstream fork. Third-party code is limited to ordinary dependencies: `@truefoundry/trueforge-sdk` (MIT), `@modelcontextprotocol/sdk` (MIT), `zod` (MIT), `diff`/jsdiff (BSD-3-Clause). Repository: <https://github.com/positron-nb/starDust_forge>.

## 3. Architecture on TrueForge
The VS Code extension is a **TrueForge client**; TrueForge runs the agent loop in local mode (`npx @truefoundry/trueforge@latest`).
- **Sessions & turns:** `@truefoundry/trueforge-sdk` — `sessions.create` with the agent spec from `agent/forge-coder.json` (also saved as agent *forge-coder* by `scripts/setup-trueforge.mjs`), `sessions.createTurnStream`, `isEventDelta/mergeEventDelta` for token streaming, `sessions.cancel` + SSE abort for cancellation.
- **Editor capabilities as MCP tools:** the extension hosts a Streamable-HTTP MCP server on 127.0.0.1 (random port, per-session bearer token) and registers it as a TrueForge connector with header auth. Tools: `get_context`, `find_symbol`, `read_file`, `list_files`, `search_workspace`, `propose_edit`, `run_command`.
- **Tool approval drives the diff review:** `propose_edit` and `run_command` are in `require_approval_for_tools`. On `tool.approval_required` the extension reads the call's arguments, opens a hunk review (diff editor + panel card), and answers with `user.tool_approval`. When TrueForge then executes `propose_edit`, our handler writes **only the accepted hunks**, after checking the file is unchanged since review; unreviewed calls write nothing.
- **TrueForge features actually used in the recorded runs (lean profile):** MCP connector with header auth. `require_approval_for_tools` for `propose_edit`, `run_command` and `run_commands`; each approval opens the hunk review or the command modal. **Deferred tool loading:** `preload: false`, with frequently used tools listed in `preload_tools`, while `find_symbol`, `list_files` and the single `run_command` are reached through TrueForge's `list_tools`/`get_tool_info`/`call_tool` (we unwrap `call_tool` so a deferred edit still goes through review). **Explicit compaction** (`compaction.trigger.input_tokens`; Task B ran with 0 compaction events, and a short run with trigger 3000 produced events with `threshold_tokens: 3000`). Sessions and turn streaming via the SDK. Dynamic sub-agents and ask-user exist only in the `full` profile and were **not** used in the recorded Task B runs. The sandbox is off on purpose, so no file can change outside our reviewed tool.
- **Profiles and context control (generic, measured):** the `lean` profile preloads only frequently used tools and turns off sub-agents and ask-user. Before this, tool discovery for always-needed tools was 32% of calls in a measured Gemini run. TrueForge compaction is set explicitly through `compaction.trigger` (`input_tokens`), and TrueForge's own `compaction_started` events confirm the value is used. `model.params.reasoning_effort` is passed through, so `none` turns thinking off on local models.
- **Task ledger (survives compaction and model fallback):** tool handlers record the original task, file ranges read, the agent's plan with its `planned_files`, edits applied or refused and the last test result, without extra model calls; `task_state` returns it. The ledger drives three generic gates: commands are refused while planned files are unedited (edits first, verify once); at most 4 command calls in a row without an edit; and a **completion check** that sends the agent back (max 2 follow-up turns) if a planned file has no edit or tests did not pass after the last edit. On fallback, the next model's fresh session receives the ledger as a **handoff**. Measured: Task B ran with 0 compactions and 0 duplicate reads (before: 4 and 29 reads), and a run where Groq failed after 2 calls was finished by Gemini Flash-Lite from the handoff (59 tests passed).
- **Edit guards before review:** an edit is refused if it would delete a definition that existed before the run (function, class or module-level assignment), **rewrite an existing test**, or make a Python file invalid (`ast.parse`). Verification runs as one approval-gated `run_commands` batch: argv lists without a shell, per-command exit codes and timeouts, and full logs saved to a file. Tolerant matching accepts unique matches only, and a file that changed after review is never written.
- **Resilience:** model failures arrive as `turn.done{status:"error","[Model Error] …"}`. The runner retries transient errors with exponential backoff (honouring provider wait hints such as "retry in N s" and "try again in N s"; up to 8 waits when the provider states a wait of 65 s or less) and then **falls back automatically** to the next model in `forge.models` on a fresh session; errors are summarised in one line.

- **Testing:** 65 unit tests; 10 integration tests that run inside a real VS Code extension host and drive the review UI (diff editor, per-hunk accept/reject, apply, undo, cancel, stale file, guards); and a headless benchmark harness on the real TrueForge pipeline. The integration tests found a real bug (the stale-file check trusted a lagging editor buffer), now fixed.

## 4. How context is selected
Retrieval is lexical + structural, budgeted, and explained (`extension/src/context/`):
1. Incremental index of code and docs into symbol chunks (Python by indentation, C-like by braces, rst/md by section); Flask: 165 files / 2,084 symbols in ≈210 ms.
2. BM25 over identifier-aware tokens (`routes_command` → routes, command) with field weights (name 4 > doc 2 > path 1.5 > body 1).
3. Boosts: exact code identifiers from the request (×2.5; plain English words excluded), nested helpers ×0.4, "hot files" ranked by their 3 best chunks.
4. Graph expansion: Python/JS import graph, test counterparts (`tests/test_<module>.py`), importers **and dependencies** of hot files.
5. Budget packing (default 3,000 tokens, max 12,000): outlines of the 3 hottest files first (≤35 %), then snippets ≤60 lines, ≤5 per file, no overlaps; dropped candidates listed with the reason.
6. Every item carries a reason; the panel shows a live "Context selected" table with a budget bar (visible in Task B).
Explicit context: `@file:path` (full ≤250 lines, otherwise an outline) and `@symbol:name` → `<pinned_context>` block with its own 5k budget.
*Trade-off:* no embeddings — they would need a second provider (breaking "any configured model"), add indexing latency, and lexical+structural signals already surface every file the fixed tasks need.

## 5. Model setup
Every model below is free; no paid model was used.

| Model (TrueForge name → provider model) | Where | Role | Verified result |
|---|---|---|---|
| `openrouter/nemotron-ultra` → `nvidia/nemotron-3-ultra-550b-a55b:free` | OpenRouter free tier (20 req/min, 50 req/day, no token limit) | Agent mode (Task B) | Task B: 3 files, 61 passed in `test_cli.py`, 54 requests, 270 s |
| `google-gemini/gemini-3-5-flash` (→ `gemini-3-1-flash-lite` fallback) | Google AI Studio free tier | Inline edit (Task A); agent mode alternative | Task A: 19 s after the fallback. Task B: 3 files, 59 passed, 47 requests, after 429/503 → automatic fallback |
| `broken/dead-model` (custom → `http://127.0.0.1:9/v1`) | unreachable on purpose | Task C | "Model endpoint unreachable" → automatic fallback |
| `probe/ornith`, `probe/mimo` (9B, Ollama, RTX 5060 8 GB) | local, offline | small edits only | pass a 3-file bug fix; fail Task B (loops) |

How to switch: edit `forge.models` (an ordered fallback list); any provider configured in TrueForge works. Rejected options, with evidence: Groq free (8K tokens/min is smaller than one useful request) and Cerebras (needs a payment method). See `FREE_MODEL_RESEARCH.md` and `MODEL_BENCHMARK.md`.

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
| B4 TrueForge depth | TODO | MCP connector; approvals drive review and command batches; deferred tools; explicit compaction |
| C1 Video | — | Tasks A, B, C in order, verified on screen |

## 7. Tools used
Claude Code (Claude Opus 5.5) as an AI coding assistant for research, implementation and tests; VS Code; TrueForge local mode; ripgrep; vitest; esbuild.

## 8. Known limitations and what we would do with another month
- Test counts: Task B passes when **all of `tests/test_cli.py`** passes, meaning the 58 baseline tests plus the agent's new ones (61 in the Nemotron run, 59 in the Gemini run). The whole Flask suite is **not** fully green: `tests/test_reqctx.py::test_bad_environ_raises_bad_request` already fails on clean 3.1.3 (`22d92470`: 489 passed, 1 failed) and is unrelated to our change.
- Task B on the free Nemotron tier took 54 requests against a 50/day cap. The work was finished by about request 50; extra verification probes (23 `run_command` calls) made up most of the overrun. Next: a test-command budget and a single "verify" step.
- Without compaction, the run's input reached 1.7M tokens (largest request 47.6k). That is fine on free OpenRouter, but costly on a paid model. Next: prompt caching where the provider supports it.
- Results vary between runs of the same free model (Nemotron: one pass in 54 requests, one run cut off by the daily cap at 37). The gates and the handoff reduce this, but do not remove it.
- Commands are approval-gated, but a command the user approves could still modify files outside the review path.
- Symbol parsing is heuristic (indentation and braces). A tree-sitter index would handle more edge cases and languages.
- Local 8–9B models pass small tasks but loop on Task B, even with all guards on.
- Next month: embeddings as an optional re-ranker, TrueForge skills for repo conventions, and a Round-2 PR to TrueForge adding native model fallback and a hook for compaction state.
