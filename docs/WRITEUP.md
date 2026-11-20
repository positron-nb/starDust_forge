# Forge Agent — TrueFoundry Forge-a-thon Round 1 write-up

## 1. Team
**StarDust** (team ID `TM-63CB569D10D`)

| Member | Role |
|---|---|
| Abhishek Kumar Singh | Team leader |
| Abhinav Rai | Member (GitHub: `positron-nb`, repository owner) |
| Gaurav Singh Rajpoot | Member |
| Ansh Pandey | Member |
| Naman Singh | Member |

## 2. Starting point
From scratch — no upstream fork. Third-party code is limited to ordinary dependencies: `@truefoundry/trueforge-sdk` (MIT), `@modelcontextprotocol/sdk` (MIT), `zod` (MIT), `diff`/jsdiff (BSD-3-Clause). Repository: <https://github.com/positron-nb/starDust_forge>.

## 3. Architecture on TrueForge
The VS Code extension is a **TrueForge client**; TrueForge runs the agent loop in local mode (`npx @truefoundry/trueforge@latest`, verified on 0.185.0 and 0.185.1). The extension never calls a model provider.
- **Sessions and streaming:** `@truefoundry/trueforge-sdk` — `sessions.create` with the agent spec from `agent/forge-coder.json` (also saved as agent *forge-coder* by `scripts/setup-trueforge.mjs`), `createTurnStream` with `mergeEventDelta` for token streaming, `sessions.cancel` plus SSE abort for cancellation.
- **Editor capabilities as MCP tools:** a Streamable-HTTP MCP server on 127.0.0.1 (random port, per-activation bearer token), registered as a TrueForge connector with header auth. Tools: `get_context`, `read_file`, `read_files`, `search_workspace`, `propose_edit`, `task_state`, `run_commands`, `run_command`, `find_symbol`, `list_files`.
- **Tool approval drives the diff review:** `propose_edit`, `run_command` and `run_commands` are in `require_approval_for_tools`. On `tool.approval_required` TrueForge pauses the turn; the extension opens the hunk review (or a modal listing every command), posts `user.tool_approval` to the paused turn (`createTurnEvents`) and resumes the stream (`subscribeToTurn`). When TrueForge executes `propose_edit`, our handler writes **only the accepted hunks**, and only if the file is unchanged since review.
- **Context engineering — deferred tool loading (lean profile):** `preload: false`. Tools used throughout the task are listed in `preload_tools`; the verification tools (`run_commands`, `run_command`) plus `find_symbol` and `list_files` stay deferred, so their schemas are not resent with every exploration and edit request. At the end of the task the agent finds them with TrueForge's `list_tools` → `get_tool_info` → `call_tool`, which is visible in the session: in the 18 Nov Nemotron Task B session, `run_commands` was reached through `call_tool` 11 times (the session is also shown in the video). We unwrap `call_tool`, so a deferred call still goes through approval. Measured on the full profile: always-needed tools left deferred cost 32% of calls, which is why only end-of-task and rare tools are deferred.
- **Compaction and the task ledger:** compaction is configured explicitly (`compaction.trigger.input_tokens`; events with `threshold_tokens` confirm the value is used). Because summaries lose detail, tool handlers keep a **task ledger** outside the context window (task, plan with `planned_files`, files and ranges read, edits applied or refused, last test result) at no extra model cost; `task_state` returns it. The ledger drives generic gates: edits before verification, at most 4 command calls without an edit, a **completion check** that sends the agent back if a planned file is unedited or tests did not pass, and a **handoff** of the ledger to the next model on fallback. Before/after on Nemotron: 4 compactions and 29 file reads became 0 and 20.
- **Edit guards before review:** an edit is refused if it would delete a definition that existed before the run, rewrite an existing test, or make a Python file invalid (`ast.parse`). Edits must match uniquely. Verification runs as one approval-gated `run_commands` batch (argv lists, no shell, per-command exit codes and timeouts, full log file).
- **Resilience:** model errors arrive as `turn.done {status: "error"}`. The runner waits on provider hints ("retry in N s", "try again in N s"), retries with backoff, then **falls back automatically** to the next model with the ledger handoff. A loop detector stops a model that repeats the same failing tool call 3 times and redirects it. Sub-agents and ask-user exist only in the `full` profile and were not used in the recorded runs; the sandbox is off so that no file can change outside the reviewed tool.
- **Testing:** 70 unit tests; 10 integration tests inside a real VS Code extension host that drive the review UI (diff editor, per-hunk accept/reject, apply, undo, cancel, stale file, guards); and a benchmark harness on the real TrueForge pipeline. The integration tests found a real bug (the stale-file check trusted a lagging editor buffer), now fixed.

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
| `openrouter/nemotron-ultra` → `nvidia/nemotron-3-ultra-550b-a55b:free` | OpenRouter free tier (20 req/min, 50 req/day, no token limit) | Agent mode (Task B) | Task B: 3 files, `test_cli.py` 59–61 passed; 43 requests with the final design (54 before) |
| `google-gemini/gemini-3-5-flash` (→ `gemini-3-1-flash-lite` fallback) | Google AI Studio free tier | Task A in the video; agent mode alternative | Task A: 2 hunks, verified on screen. Task B (9 Nov): 3 files, 59 passed, 47 requests |
| `google-gemini/gemini-3-1-flash-lite` | Google AI Studio free tier | Task B and the Task C fallback **in the video** | Task B: 5 reviews, 3 files, 59 passed, masked CLI output; survived 503/429 via recovery turns |
| `broken/dead-model` (custom → `http://127.0.0.1:9/v1`) | unreachable on purpose | Task C | "Model endpoint unreachable" → automatic fallback |
| `probe/ornith`, `probe/mimo` (9B, Ollama, RTX 5060 8 GB) | local, offline | small edits only | pass a 3-file bug fix; fail Task B (loops) |

Also used during development and benchmarking (all free, results in `MODEL_BENCHMARK.md`): Groq free `openai/gpt-oss-120b` (one Task B run, where it failed on its per-minute limit and handed over to Gemini Flash-Lite, which passed), OpenRouter free `nvidia/nemotron-3.5-lightning` and `google/gemma-4-31b-it`, Gemini 3.6/3.7/3.8 Flash and 3.5 Flash-Lite, and local Ollama `qwen3:8b`, `qwen2.5-coder:7b`, `mimo-v2.6:9b` and `ornith:9b`. **Approximate cost: ₹0** in API fees (free tiers and a local GPU).

How to switch: edit `forge.models` (an ordered fallback list), or leave it empty to use the models configured in TrueForge (up to 3, in TrueForge's order). Any provider configured in TrueForge works, and the extension never calls a provider directly. Rejected options, with evidence: Groq free (8K tokens/min is smaller than one useful request) and Cerebras (needs a payment method). See `FREE_MODEL_RESEARCH.md` and `MODEL_BENCHMARK.md`.

## 6. Scorecard
Timestamps refer to the submitted video (3:50).

| Criterion | Timestamp | Claim |
|---|---|---|
| A1 Inline edit | 0:17 (diff 0:29, verified 0:44) | Task A: `get_debug_flag` selected, Ctrl+Alt+E, instruction; 2-hunk diff accepted hunk by hunk; off/OFF/n/N/0 → False, 1 → True; `test_helpers.py` 35 passed |
| A2 Agent mode | 1:04 (reviews 1:22–1:51, verified 2:25–2:48) | Task B from the official instruction, no file names: the agent finds and edits `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`; 59 passed; real `flask config` masks secrets |
| A3 Streaming & cancellation | 2:58 (clean at 3:07) | Progress streams in the panel throughout; cancel while a diff waits for review → edits discarded, `git status` clean |
| B1 Context assembly | 1:10 | `get_context` table in the panel: budgeted BM25 + import-graph picks, each with its reason |
| B2 Diff safety | 0:29, 2:48, 3:27 | Per-hunk accept (A); Undo Agent Run reverts all 3 files → clean (B); per-hunk reject → nothing written (C) |
| B3 Resilience | 3:12–3:45 (also 2:07) | Dead endpoint first → "unreachable, falling back" → Flash-Lite diff → rejected → `git status` clean; provider 503/429 → automatic recovery turn |
| B4 TrueForge depth | 1:55–2:25 | TrueForge session of the Task B run: MCP tools, approval pauses as diff reviews, recovery turns, deferred tools (`Listing tools` → `get_tool_info` → `call_tool`) |
| C1 Video | 0:00–3:50 | Tasks A, B, C in order, each verified on screen |
| C2 Write-up | — | This document: architecture, context strategy, model setup, trade-offs, scorecard, limitations |

## 7. Tools used
AI coding assistants: Claude Code (models Claude Opus 5.5, Claude Fable 5.2 and Claude Haiku 5.5) for research, implementation, tests and documentation; ChatGPT for reviewing the plan and benchmark reports. Other tools: VS Code, TrueForge in local mode, Ollama, ripgrep, vitest, esbuild, @vscode/test-electron, @vscode/vsce.

## 8. Known limitations and what you would do with another month
- Test counts: Task B passes when **all of `tests/test_cli.py`** passes, meaning the 58 baseline tests plus the agent's new ones (61 in the Nemotron run, 59 in the Gemini run). The whole Flask suite is **not** fully green: `tests/test_reqctx.py::test_bad_environ_raises_bad_request` already fails on clean 3.1.3 (`22d92470`: 489 passed, 1 failed) and is unrelated to our change.
- The video is a live run, but its clicks and keystrokes are scripted (`extension/test-ui/demo.ts` drives the same commands as the keybindings inside VS Code's extension test host). That host cannot show modal dialogs, so the demo profile auto-approves agent commands (`.*`; the hard deny-list still applies). Free-tier caps shaped it: Nemotron's 50 requests/day went on two attempts (one stalled on provider timeouts), so Task B runs on Flash-Lite. An earlier Flash-Lite take passed its own test but failed the real CLI (no app context); our on-screen check caught it, and the video shows a clean re-run.
- Task B on the free Nemotron tier took 54 requests against a 50/day cap. The work was finished by about request 50; extra verification probes (23 `run_command` calls) made up most of the overrun. Next: a test-command budget and a single "verify" step.
- Without compaction, the run's input reached 1.7M tokens (largest request 47.6k). That is fine on free OpenRouter, but costly on a paid model. Next: prompt caching where the provider supports it.
- Results vary between runs of the same free model (Nemotron: one pass in 54 requests, one run cut off by the daily cap at 37). The gates and the handoff reduce this, but do not remove it.
- Commands are approval-gated, but a command the user approves could still modify files outside the review path.
- Symbol parsing is heuristic (indentation and braces). A tree-sitter index would handle more edge cases and languages.
- Local 8–9B models pass small tasks but loop on Task B, even with all guards on.
- Next month: embeddings as an optional re-ranker, TrueForge skills for repo conventions, and a Round-2 PR to TrueForge adding native model fallback and a hook for compaction state.
