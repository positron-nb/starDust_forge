# Task Board

| ID | Task | Status |
|---|---|---|
| P0.1 | Inspect workspace & tools (node 24, git, python 3.12, rg, code 1.143) | VERIFIED |
| P0.2 | Read competition PDF | VERIFIED |
| P0.3 | TrueForge source/docs research | IMPLEMENTED |
| P0.4 | Phase-0 docs | IMPLEMENTED |
| P0.5 | Clone Flask 3.1.3, verify 22d92470 | VERIFIED |
| P1.1 | Run TrueForge locally via npx | VERIFIED |
| P1.2 | Configure model provider (Gemini free tier) | VERIFIED |
| P1.3 | PoC: session + streaming turn via SDK | VERIFIED |
| P1.4 | PoC: TrueForge calls localhost MCP tool | VERIFIED |
| P1.5 | PoC: failure surface for Task C | VERIFIED |
| P2 | Extension foundation (panel, client, streaming, cancel, fallback) | TESTED (headless smoke + 10 unit tests; panel VERIFIED in VS Code by user) |
| P3 | Workspace MCP tools (read/list/search/find_symbol/get_context/run_command) | TESTED (19 unit tests + headless E2E on Flask) |
| P4 | Context engine (@file/@symbol, BM25+graph retrieval, budget, reasons, panel table) | TESTED (headless); panel table not yet seen in VS Code |
| P5 | Inline edit + diff review (hunks, undo, rollback) | TESTED (unit + headless). UI NOT yet verified by user (docs/UI_CHECKLIST.md checks 1–5). |
| P6 | Fallback, errors, consistency checks | VERIFIED headless (dead endpoint, 429/503 wait hints, fallback chain) |
| P7a | Task A headless | VERIFIED 9 Nov (Gemini, after dead-endpoint fallback): off/OFF/n/N/0/no/FALSE/unset → False, 1/yes → True; docstring lists 0/false/no/off/n; test_helpers 35 passed. UI path NOT yet verified (docs/UI_CHECKLIST.md). |
| P7b | Task B headless | VERIFIED 9 Nov on OpenRouter nemotron-3-ultra:free (lean, compaction 100k): 3 files, test_cli 61 passed, full suite 492 passed + 1 pre-existing failure, masked output OK, 0 deletions. 54 requests (target 20–25 not met). Also VERIFIED on Gemini free (3.5 Flash → flash-lite fallback): 3 files, 59 passed, 47 requests. |
| P7c | Task C | VERIFIED headless 9 Nov: broken/dead-model → "Model endpoint unreachable" → automatic fallback → edit; Flask restored clean. In-editor (reject diff → git status clean) NOT yet verified. |
| P8 | Submission: README, LICENSE, setup script, write-up draft, demo script | IMPLEMENTED (PDF, video, timestamps pending) |
| F1 | Prompt-token measurement (proxy dump + breakdown + session metrics) | VERIFIED (TOKEN_OPTIMIZATION.md) |
| F2 | Free provider research with official limits | VERIFIED (FREE_MODEL_RESEARCH.md) |
| F3 | lean profile, compaction trigger, reasoning effort, context cap | TESTED (46 unit tests; verified in request dumps) |
| F4 | Safety: pre-run-definition removal guard, Python syntax guard | TESTED (unit + seen refusing in real runs) |
| F5 | Benchmark harness bench/run.sh (mini + taskb) | VERIFIED (20 runs in bench/results) |
| F6 | Groq free tier | REJECTED with evidence (8K TPM < smallest useful request ≈6.2k + history) |
| F7 | Local 9B models (mimo, ornith) for Task B | FAILED (pass mini, loop/drift on Task B) |
| F8 | run_commands batch verification (argv, approval, per-command exit codes, logs) | TESTED (unit; used in local mini run: 4 requests). Task B request count with it: pending Nemotron run |
| F9 | Existing-test guard (no rewriting pre-run tests) | TESTED (unit + replay on the real failing Gemini edit) |
| F10 | Cancel keybinding moved to Ctrl+Alt+C (Ctrl+Shift+Esc is captured by Windows) | DONE |
| H1 | Team details in write-up | PENDING (user) |
| H2 | UI checklist (13 checks) | PENDING (user), docs/UI_CHECKLIST.md |
| H3 | 4-min video + scorecard timestamps | PENDING (user), docs/DEMO_SCRIPT.md |
| F11 | TrueForge 0.185 approval protocol (paused turn, createTurnEvents, subscribeToTurn) | VERIFIED (mini, Task A+C, Task B) |
| F12 | Plan gates (planned_files, edits-before-verify), completion check, fallback handoff | VERIFIED 13 Nov: Groq→Gemini Flash-Lite Task B pass (59 tests, 40 requests). Nemotron with gates: pending quota |
