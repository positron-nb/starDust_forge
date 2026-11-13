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

## 5. Batch verification (`run_commands`) and the existing-test guard (9 Nov, later)
- **`run_commands`:** up to 8 commands per call. Each command is an argv list (no shell), runs in a validated cwd with its own timeout and exit code, and is summarised briefly. Full logs go to a file and `fail_fast` is optional. The user approves the whole batch and sees every command; it is auto-approved only if **every** command matches `forge.autoApproveCommands`. In the lean profile the single `run_command` is deferred, so the preloaded way to verify is the batch.
- **Local check:** on the mini task, Ornith verified with one `run_commands` call, and the whole task took **4 requests**.
- **Gemini Task B (2nd run that day):**
  - 3.5 Flash hit its quota, so Flash-Lite did the work: 86 requests, and it called `run_commands` 27 times with mostly one command each.
  - It **rewrote an existing test**, which the removal guard did not catch because the name still existed.
  - Fix: a new guard. In test files, the text of every test that existed before the run must stay identical; the agent may add tests and rework its own. A replay on the real before/after files flags `test_prepare_import`.
- **Status:** the target of <40 requests on Task B with batch verification is **not yet measured on a capable model**. The OpenRouter Nemotron quota was used up by the passing run earlier that day. Next run: after the 05:30 IST reset, using `bench/preflight.sh` and then `bench/run.sh taskb openrouter/nemotron-ultra lean 100000`.

## 6. TrueForge 0.185 and the verification-loop brake (13 Nov)
- **Breaking server change:** `npx @truefoundry/trueforge@latest` became **0.185.0**. That release pauses the same turn for approvals (`turn.update {status:"paused"}`) and adds new event types, so SDK 0.184.1 failed with `Expected "mcp.auth_required". Received "turn.update"`.
  - Fix: SDK 0.185.0. Approvals are now posted to the paused turn with `createTurnEvents`, and the stream resumes with `subscribeToTurn(afterEventId)`. The old new-turn resume path is kept for older servers.
  - Verified on 0.185: local mini (an edit plus a `run_commands` approval, 6 requests), and Task A+C on Gemini (dead endpoint → fallback, then a 56 s provider wait, then done). All six Task A values are correct and `test_helpers` has 35 passed.
- **Nemotron Task B with `run_commands`** (`bench/results/1113-151015-*`): ❌ not completed.
  - Counts: 37 requests, 0 compactions, 0 duplicate reads.
  - `cli.py` was edited correctly. Then the model wrote a scratch `test_app.py` and spent **18 `run_commands` calls** probing it (`python -c …`, `flask --app test_app config`), despite the "verify once" rule.
  - The daily cap ended the run before the test and docs were written. Flask was restored clean.
- **Fix (generic):** a verification-loop brake. After **4 command calls in a row without an applied edit**, further `run_commands`/`run_command` calls are refused, with guidance to read the failure and edit, or to finish and report. The counter resets on the next applied edit. It is unit-tested but **not yet measured on Task B**, because the quota is used up for today.
- Recommendation for the demo day: pin TrueForge (`npx @truefoundry/trueforge@0.185.0`) so that a new release cannot change the protocol mid-recording.

## 7. Plan-driven gates and fallback handoff (13 Nov, later)
Three mechanism changes, all generic and all driven by the extension-held task ledger:
1. **Structured plan + edits-before-verify gate.** `task_state` takes `planned_files` (every file the agent will change). After the first applied edit, command calls are refused while planned files are still unedited ("finish your planned edits first"). This targets the 13 Nov Nemotron failure, where one file was edited and the quota then went on probing.
2. **Completion check.** When the agent ends its turn, the editor checks the ledger: every planned file has an applied edit, a test command ran after the last edit, and it passed. If not, the runner sends one automatic follow-up turn naming what is missing (max 2 per run). Inline edits are exempt.
3. **Fallback handoff.** When a model fails and the next one starts a fresh TrueForge session, that session receives the original task plus the ledger (plan, files found, edits already on disk, test status), so work is not restarted from zero and quotas of different providers add up.

**Verified run** (`bench/results/1113-152730-taskb-groq_gpt-oss-120b-lean.*`), chain Groq gpt-oss-120b → Gemini 3.1 Flash-Lite:
- Groq made 2 tool calls, then failed on its per-minute token limit (429, 429, 413). The handoff text reached the Gemini session (confirmed in the stored `turn.created` input: task + "HANDOFF …" + ledger).
- Flash-Lite, the weakest model we use, finished Task B: **3 files, `test_cli.py` 59 passed, full suite 490 passed + the 1 pre-existing failure, masked output correct, 0 lines removed from the test file.**
- The existing-test guard refused 3 attempts to modify `test_no_command_echo_loading_error`; the model then inserted a new test instead.
- 40 requests in total (38 on Gemini), 0 compactions, 11 command batches, 2 provider waits (34 s, 19 s) survived. The ledger ended with `planned=cli.py,test_cli.py,docs/cli.rst pending=none`.
- Not yet measured with these gates: Nemotron (daily quota used up on 13 Nov).
