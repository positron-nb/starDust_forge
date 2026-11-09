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
- **Harness features used:** *Deferred tool loading* (`preload: false` + `preload_tools` for the four core tools; the rest are reached via TrueForge's `call_tool`, shown as ⟨deferred⟩ in the panel and unwrapped so a deferred `propose_edit` still goes through review); *dynamic subagents* (enabled; their threads render nested in the panel); *compaction* (enabled for long Task-B-style runs). Sandbox disabled on purpose so no file can change outside our reviewed tool.
- **Profiles and context control (generic, measured):** a `lean` profile preloads all workspace tools and turns off sub-agents and ask-user. That saves ≈700 prompt tokens per request and removes tool-discovery round trips, which were 32% of calls in a measured Gemini run. TrueForge compaction is set explicitly through `compaction.trigger` (`input_tokens`), and TrueForge's own `compaction_started` events confirm the value is used. `model.params.reasoning_effort` is passed through, so `none` turns thinking off on local models.
- **Task ledger (survives compaction):** tool handlers record the original task, file ranges read (with content hash), edits applied or refused and the last test result, without any extra model calls. A `task_state` tool returns this record after a summary instead of re-reading files. With this and the explicit compaction setting, the Task B run had 0 compactions and 0 duplicate reads, against 4 compactions and 29 reads before. A `## Compact Instructions` section tells TrueForge's summariser what to keep.
- **Edit guards before review:** an edit is refused if it would delete a definition that existed before the run (function, class or module-level assignment) or make a Python file invalid (`ast.parse`). Tolerant matching accepts unique matches only, and a file that changed after review is never written.
- **Resilience:** model failures arrive as `turn.done{status:"error","[Model Error] …"}`. The runner retries transient errors with exponential backoff (honouring provider wait hints such as "retry in N s" and "try again in N s"; up to 8 waits when the provider states a wait of 65 s or less) and then **falls back automatically** to the next model in `forge.models` on a fresh session; errors are summarised in one line.

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
| `google-gemini/gemini-3-5-flash` | Google AI Studio free tier | Inline edit (Task A), fallback target | Task A: 19 s after the fallback |
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
| B4 TrueForge depth | TODO | MCP tools; approval drives review; deferred tools + subagents in session |
| C1 Video | — | Tasks A, B, C in order, verified on screen |

## 7. Tools used
Claude Code (Claude Opus 5.5) as an AI coding assistant for research, implementation and tests; VS Code; TrueForge local mode; ripgrep; vitest; esbuild.

## 8. Known limitations and what we would do with another month
- Task B on the free Nemotron tier took 54 requests against a 50/day cap. The work was finished by about request 50; extra verification probes (23 `run_command` calls) made up most of the overrun. Next: a test-command budget and a single "verify" step.
- Without compaction, the run's input reached 1.7M tokens (largest request 47.6k). That is fine on free OpenRouter, but costly on a paid model. Next: prompt caching where the provider supports it.
- Fallback restarts the task in a fresh session. Edits already applied stay in place and can be undone as a run. Next: hand the task ledger to the fallback session.
- Commands are approval-gated, but a command the user approves could still modify files outside the review path.
- Symbol parsing is heuristic (indentation and braces). A tree-sitter index would handle more edge cases and languages.
- Local 8–9B models pass small tasks but loop on Task B, even with all guards on.
- Next month: embeddings as an optional re-ranker, TrueForge skills for repo conventions, and a Round-2 PR to TrueForge adding native model fallback and a hook for compaction state.
