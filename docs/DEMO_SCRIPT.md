# 4-minute demo script (A → B → C)

## Before recording (checklist)
1. **TrueForge running** (PowerShell, from the repo root):
   `$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'; npx @truefoundry/trueforge@0.185.1`
   Leave this window open.
2. **Flask clean:** `git -C flask status --short` prints nothing, and `git -C flask rev-parse --short=8 HEAD` prints `22d92470`.
3. **Quota:** record after 05:30 IST, because OpenRouter's 50 requests/day reset at 00:00 UTC. Task B needs about 50 requests, so **do not run any other test on OpenRouter that day**. Task A uses Gemini.
4. **VS Code settings** (Extension Development Host → Settings → search "forge"):
   - `forge.models` = `["openrouter/nemotron-ultra", "google-gemini/gemini-3-5-flash"]`
   - `forge.profile` = `lean`, `forge.compactAtTokens` = `100000`
5. VS Code layout: Flask open in the Extension Development Host, Forge panel visible, Git Bash terminal open, TrueForge UI (<http://localhost:8790>) in a browser tab.
6. Screen-record at 1080p. You may cut **model waiting time only**, and never the stretch between an instruction and its diff appearing.

## Shot list
| Time | Show | Say / caption |
|---|---|---|
| 0:00–0:10 | Title; VS Code + TrueForge running | "Coding agent in VS Code; agent loop on TrueForge" |
| **Task A** 0:10–0:50 | `forge.models` first entry = `google-gemini/gemini-3-5-flash`. Open `src/flask/helpers.py`, select `get_debug_flag`, Ctrl+Alt+E, paste the Task A instruction | "Inline edit" |
| | Diff editor opens with hunks | "Proposed diff, nothing on disk yet" |
| | Alt+Y on each hunk (or Accept in the panel card) → Ctrl+Alt+Enter | "Per-hunk accept" |
| | Git Bash: `FLASK_DEBUG=off .venv/Scripts/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False` | verification |
| **Task B** 0:50–2:40 | Switch `forge.models` back to Nemotron first. Panel: paste the Task B instruction (no file names) | "Agent mode" |
| | `📚 Context selected` table: cli.py, test_cli.py, docs/cli.rst + reasons, budget bar | "Retrieval with budget, explained" |
| | Review cards per file; **reject one hunk** deliberately, accept the rest (the agent re-proposes) | "Per-hunk review" |
| | Click "TrueForge session ↗": scroll to the end and show the turns, the tool calls, the `task_state` plan and the **deferred tool discovery** (`list_tools` → `get_tool_info` → `call_tool` for `run_commands`) | required by the rules; B4 evidence |
| | `.venv/Scripts/python -m pytest tests/test_cli.py -q` → 61 passed; `flask --app ../demo/task_b_app.py config` shows `***` | verification |
| | Forge: Undo Agent Run → `git status` clean (optional; reapply with Ctrl+Z only if time allows) | "Undo" |
| **Cancel** 2:40–3:00 | Start any run, press Cancel (Ctrl+Alt+C or the panel's ■ button) mid-stream → `git status` clean | "Cancellation is safe" |
| **Task C** 3:00–3:50 | Settings: `forge.models` = `["broken/dead-model", "google-gemini/gemini-3-5-flash"]`; repeat Task A | |
| | Panel: "Model endpoint unreachable… Falling back to google-gemini/gemini-3-5-flash automatically" → diff → reject | "Automatic fallback" |
| | `git status` → no changes | verification |
| 3:50–4:00 | Close: repo URL | |

After recording: fill the scorecard timestamps in `docs/WRITEUP.md`, then run `python scripts/writeup-pdf.py`.
