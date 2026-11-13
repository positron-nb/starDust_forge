# Implementation Plan (deadline 20 Nov 2026 23:59 IST)

| Dates | Phase | Exit criterion |
|---|---|---|
| Nov 6 | P0 research, P1 PoC | SDK turn streams; TrueForge calls our localhost MCP `read_file` |
| Nov 7–8 | P2 extension foundation + P3 tools | Agent panel streams, cancel works, agent reads/searches Flask |
| Nov 9–10 | P4 context engine | `get_context` returns ranked, budgeted snippets with reasons; @mentions |
| Nov 11–12 | P5 inline edit + diff review | Task A passes end-to-end; hunk accept/reject; undo |
| Nov 13 | P6 resilience | Task C: fallback + clear error, `git status` clean |
| Nov 14–15 | P7 rehearsal | Task B passes (3+ files, pytest green); logs saved |
| Nov 16–18 | P8 write-up, README, video | Clean-clone setup verified |
| Nov 19–20 | Buffer | Submit |

Repo layout:
```
extension/            VS Code extension (TypeScript)
  src/trueforge/      client, sessions, fallback
  src/mcp/            MCP server + tools
  src/context/        index, symbols, ranking, budget
  src/changes/        ChangeSet, hunks, apply/undo
  src/ui/             webview panel, inline edit, diff review
  test/               unit tests (vitest/mocha)
poc/                  phase-1 scripts
config/               models.example.json, agent spec
docs/                 write-up, demo script, scorecard
```

## Status on 13 Nov
P0–P7 are done and verified headless (see TASK_BOARD.md and HANDOFF.md). Remaining: on-screen UI checklist, team details, the video and its scorecard timestamps (P8), then submission.
