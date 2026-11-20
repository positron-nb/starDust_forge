# Handoff

## State (18 Nov 2026)
- **Repo:** <https://github.com/positron-nb/starDust_forge> (public, branch `master`). Commits are authored by `positron-nb`; no co-author trailers.
- **TrueForge:** local, verified on 0.185.0 and 0.185.1 (`@latest` on 18 Nov), started with the loopback allow-list (see README). SDK 0.185.0.
- **Providers configured in TrueForge (keys live only there):** `google-gemini`, `openrouter` (Nemotron models), `groq` (via local shim), `local-ollama`, `probe` (local Ollama via proxy on 8792), `broken` (dead endpoint for Task C).
- **Flask:** `flask/` at `22d92470`, `.venv` with pytest 8.4.2. Baseline: `tests/test_cli.py` 58 passed; whole suite 489 passed, 1 failed (`test_reqctx::test_bad_environ_raises_bad_request`, pre-existing).

## Verified
| What | Evidence |
|---|---|
| Unit tests | `npm test`: 70 passed |
| Review UI in real VS Code | `npm run test:ui`: 10/10 (`demo/ui-tests-report.json`) |
| Clean clone | `npm ci`, build, tests and typecheck pass on a fresh clone |
| VSIX | `npm run package` builds `forge-agent.vsix` (341 KB); installs with `code --install-extension` |
| Task A (headless) | off/OFF/n/N/0 → False, 1 → True; docstring lists the false values; `test_helpers.py` 35 passed |
| Task B (headless) | passes on Nemotron Ultra (61 passed), Gemini (59 passed) and Groq→Gemini handoff (59 passed); 3 files each, no deletions |
| Task C (headless) | dead endpoint → automatic fallback → edit; Flask restored clean |

## Recorded (20 Nov 2026)
- Demo video (3:50): Task A on Gemini 3.5 Flash, Task B on Gemini 3.1 Flash-Lite (3 files, 59 passed, masked `flask config`), cancellation, Task C (dead endpoint → Flash-Lite fallback). Scorecard timestamps are in `docs/WRITEUP.md`; diffs in `demo/task-a-video.diff`, `demo/task-b-video.diff`.
- Clicks were scripted (`extension/test-ui/demo.ts`); everything else is live. The extension test host cannot show modal dialogs, so the demo profile auto-approved commands.

## Commands
```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx -y @truefoundry/trueforge@latest
cd extension && npm ci && npm run build && npm test && npm run test:ui
bench/preflight.sh openrouter/nemotron-ultra 100000
bench/run.sh taskb openrouter/nemotron-ultra,google-gemini/gemini-3-5-flash,google-gemini/gemini-3-1-flash-lite lean 100000
python scripts/writeup-pdf.py
```

## Known traps
- `npx @truefoundry/trueforge@latest` can change the protocol (0.185 did). For the recording, pin 0.185.1.
- OpenRouter free: 50 requests/day, reset at 05:30 IST; failed requests count.
- Do not write TS/JS through shell heredocs: `\n` and `\b` get mangled. Use the editor tools.
- The GitHub token has no `workflow` scope, so the CI file lives in `docs/github-ci.yml`.
