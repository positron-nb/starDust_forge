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

## 4. Comparison
| Metric | Previous run (7 Nov) | New run |
|---|---|---|
| Total requests | 39 (stopped by the daily cap) | _pending (after 05:30 IST quota reset)_ |
| Input tokens | 498,665 | |
| Output tokens | 4,858 | |
| Max single request | 23.3k | |
| Compaction events | 4 | |
| Duplicate read calls (exact range) | 7 (plus about 20 overlapping re-reads) | |
| read_file / read_files calls | 29 | |
| Failed tool calls | 7 | |
| Model errors | 6 (3 × 429 at the cap, 3 on fallback) | |
| Tests | 58 (no test added) | |
| Files changed | 1 (`cli.py`, correct) | |
| Time | 258 s | |

Run command:
```bash
bench/preflight.sh openrouter/nemotron-ultra 100000
bench/run.sh taskb openrouter/nemotron-ultra lean 100000
```
