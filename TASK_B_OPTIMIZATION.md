# Task B optimisation: Nemotron re-read loop

Model: `openrouter/nemotron-ultra` = `nvidia/nemotron-3-ultra-550b-a55b:free`
- Base URL `https://openrouter.ai/api/v1`, context 131072, max output 16384.
- OpenRouter free limit: 50 requests/day; failed requests also count.

## 1. Root cause, proven from the previous run (7 Nov, 39 requests)
- **Config sent to TrueForge** (read back from the stored session spec): `context_management.compaction = {"enabled":true,"trigger":{"type":"input_tokens","value":24000}}`
- **TrueForge events:** 4 × `thread.context_compaction_started`, with `threshold_tokens: 24000` and `context_tokens` 24.2k–24.8k.
- **Reads after each compaction** (from `model.message` tool calls):
  - After compaction 1, `cli.py` and `docs/cli.rst` were read again.
  - After compaction 2, `cli.py` was read again in seven 100-line slices, plus `docs/cli.rst` twice.
  - The same pattern repeated after compactions 3 and 4.
- **Totals:** 29 of 40 tool calls were `read_file`. The source edit was correct, but the 50-request daily cap was hit before the test and docs were written.

## 2. Fixes
| Fix | Generic? | Verified how |
|---|---|---|
| Explicit compaction modes: `compactAt > 0` sets the trigger, `< 0` sends `{enabled:false}`, `0` keeps the TrueForge default. The Nemotron run uses **trigger 100000**. | yes | Unit tests. Real sessions: trigger 3000 produced 3 events with `threshold_tokens: 3000`; `-1` sent `{"enabled":false}` and produced 0 events. |
| **Task ledger** kept by the extension, outside the model context, so it survives compaction. Tool handlers fill it automatically, with no extra requests: original task, files read (content hash and merged line ranges), files and symbols found, edits applied or refused, last test command and result, plan, next step. | yes | unit tests; mini run recorded "edits=1, last_test=2 passed" |
| **`task_state` tool:** returns the ledger and optionally stores the plan and next step. The instructions and the `## Compact Instructions` say to call it once after a summary instead of re-reading files. | yes | — |
| **`read_files`:** up to 8 files or ranges in one call, capped at 1200 lines in total | yes | — |
| **Duplicate-read note:** a re-read of an unchanged range still returns the full content (safe after compaction) but is flagged "already read earlier; file unchanged since", and the ledger counts it. Ranges are forgotten when the file is edited. | yes | unit test |
| Instructions: write one concise plan after discovery and save it with `task_state`; batch reads; never re-read a range you already have | yes | — |
| Metrics now include `compactions` and `dup_reads` | — | baseline recomputed below |

All earlier safety guarantees are unchanged:
- review before any write, and a stale-file check at apply time;
- unique-match edits only;
- the guard against deleting pre-existing definitions;
- the Python syntax guard.

## 3. Pre-flight (`bench/preflight.sh <model> <compactAt>`)
It checks that Flask is clean at `22d92470`, that 58 baseline tests pass, that TrueForge is up and the model is configured, and it prints the effective compaction. It then sends **one** connectivity request through TrueForge (`out/ping.js`). It was tested locally on 7 Nov and printed "PREFLIGHT OK".

## 4. Comparison (9 Nov 2026, run `bench/results/1109-142510-taskb-openrouter_nemotron-ultra-lean.*`)
| Metric | Previous run (7 Nov) | New run (9 Nov) |
|---|---|---|
| Outcome | ❌ stopped by the daily cap after 1 file | ✅ **Task B done**: 3 files discovered and edited, tests pass |
| Total requests | 39 | 54 (work finished by about #50; #51–54 were extra checks, and the cap's 429 ended the run) |
| Input tokens | 498,665 | 1,696,541 (no compaction, so history grows; free tier has no token limit) |
| Output tokens | 4,858 | 9,512 |
| Max single request | 23.3k | 47.6k (of 131k) |
| Compaction events | 4 | **0** |
| Duplicate read calls (exact range) | 7, plus ~20 overlapping re-reads | **0** |
| read_file / read_files calls | 29 | 20 |
| `task_state` calls | — | 1 (plan saved at request #13) |
| propose_edit calls | 3 | 8 (all reviewed; 0 refused) |
| run_command calls | 0 | 23 (tests plus `python -c` probes) |
| Failed tool calls | 7 | 4 (wrong `cd /workspace` and early test failures, then fixed) |
| Model errors | 6 | 3 (429 at the daily cap, after the work was done) |
| Files changed | 1 | 3: `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst` |
| Deleted pre-existing definitions | 0 | 0 |
| `tests/test_cli.py` | 58 passed (no new test) | **61 passed** (58 + 3 new `TestConfig` tests) |
| Whole Flask suite | — | 492 passed, 1 failed. The failure is `test_reqctx::test_bad_environ_raises_bad_request`, which **fails on clean 3.1.3 too** (baseline 489 passed, 1 failed). |
| `flask --help` | — | lists `config  Show the app config.` |
| `flask --app demo/task_b_app.py config` | — | `SECRET_KEY`, `DATABASE_PASSWORD`, `API_TOKEN` = `"***"`; `NAME` = `"demo"` |
| Time | 258 s | 270 s |

### Second free model (same fixes, plus the "verify once" rule)
`bench/results/1109-143315-taskb-google-gemini_gemini-3-5-flash-lean.*`: Gemini 3.5 Flash hit 429/503 after 9 requests. The runner waited on the provider hints (10 s, 55 s) and then fell back automatically to `gemini-3-1-flash-lite`, which finished.
- Totals: **47 requests**, 839k input tokens, 0 compactions, 0 duplicate reads, 13 failed tool calls (mostly non-unique `old_string`, later fixed).
- Result: 3 files, **`test_cli.py` 59 passed**, full suite 490 passed plus the 1 pre-existing failure. `flask config` masks the secrets.

### Timeline (request numbers)
- #1–12: discovery (one `get_context`, reads, a search).
- #13: plan saved with `task_state`.
- #14–26: edits to `cli.py`, `test_cli.py` and `docs/cli.rst`.
- #27–40: test failures fixed: a wrong working directory, the JSON `default`, and the test fixture. #32–38 were seven `python -c` probes.
- #41: `TestConfig` 3 passed.
- #49–50: wider suites, ending in 86 passed for `test_cli.py` + `test_testing.py`.
- #51–54: extra checks, then the daily cap.

### Verdict and what is left
- **The re-read loop is gone.** Both compactions and duplicate reads are 0.
- **The 20–25 request target was not met.** The new waste is verification probing: 23 `run_command` calls, including seven one-off `python -c` experiments.
- Next generic fix: tell the agent to verify once with the relevant test file and `--help`, not with ad-hoc probes. Budget run_command calls and say so in `task_state`.
- Requests also include the TrueForge turn for each tool approval. Our tool budget was 54 calls for 54 requests.
