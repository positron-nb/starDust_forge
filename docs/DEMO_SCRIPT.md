# 4-minute demo script (A → B → C)

Before recording:
- TrueForge running (allow-list env var), Flask at 3.1.3 with `.venv`, `git status` clean.
- VS Code: Flask open in the Extension Development Host, Forge panel visible, Git Bash terminal open.
- Use a model with enough quota (free tier causes long waits; you may cut **model waiting time only**, never between instruction and diff appearing).

| Time | Show | Say / caption |
|---|---|---|
| 0:00–0:10 | Title, VS Code + TrueForge running | "Coding agent in VS Code; agent loop on TrueForge" |
| **Task A** 0:10–0:55 | Open `src/flask/helpers.py`, select `get_debug_flag`, Ctrl+Alt+E, paste instruction | "Inline edit" |
| | Streaming in notification/panel → diff editor opens with hunks | "Proposed diff, nothing on disk yet" |
| | Alt+Y on each hunk (or Accept in panel card) → Apply | "Per-hunk accept" |
| | Terminal: `FLASK_DEBUG=off .venv/Scripts/python -c "…"` → `False` | verification |
| **Task B** 0:55–2:40 | Panel: paste Task B instruction (no file names) | "Agent mode" |
| | `📚 Context selected` table: cli.py, test_cli.py, docs/cli.rst + reasons, budget bar | "Retrieval with budget, explained" |
| | Tool cards (⟨deferred⟩ tag), subagent thread if any | "TrueForge deferred tools / subagents" |
| | Review cards per file; **reject one hunk** deliberately, accept the rest | "Per-hunk review" |
| | `↶ Undo agent run` once → files revert → re-run / re-accept (or show undo on a separate small change) | "Undo" |
| | Click "TrueForge session ↗": turns + tool calls in TrueForge UI | required by rules |
| | `pytest tests/test_cli.py -q` passes; `flask --app <demo app> config` shows `***` | verification |
| **Cancel** 2:40–3:00 | Start a run, press Cancel mid-stream → `git status` clean | "Cancellation safe" |
| **Task C** 3:00–3:50 | Settings: `forge.models` = `broken/dead-model` first; repeat Task A | |
| | Panel: "Model endpoint unreachable… Falling back to …" → diff → reject/cancel | "Automatic fallback" |
| | `git status` → no changes | verification |
| 3:50–4:00 | Close | |

After recording: fill the scorecard timestamps in `docs/WRITEUP.md` from the actual video.
