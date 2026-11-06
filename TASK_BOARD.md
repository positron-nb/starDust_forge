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
| P5 | Inline edit + diff review (hunks, undo, rollback) | IMPLEMENTED (32 unit tests; NOT yet run in VS Code or E2E) |
| P6 | Fallback, errors, consistency checks | NOT STARTED |
| P7a | Task A headless E2E through TrueForge | VERIFIED (FLASK_DEBUG=off → False; demo/task-a-headless.diff) |
| P7b | Task B headless | FAILED on free tier (attempt 1: weak edits + quota). Edit tool hardened; rerun needs stronger model/quota |
| P7c | Task C | fallback verified headlessly (smoke + Task A run); in-editor demo pending |
| P8 | Submission: README, LICENSE, setup script, write-up draft, demo script | IMPLEMENTED (PDF, video, timestamps pending) |
