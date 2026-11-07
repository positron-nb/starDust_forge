# Implementation notes: free-model reliability work (7 Nov 2026)

TrueForge is still the only agent loop. None of these changes call a model provider directly, and none contain anything specific to Flask or Task B.

## Configuration surface (new)
| Setting (VS Code) | Env (headless/bench) | Meaning |
|---|---|---|
| `forge.profile` = `full` \| `lean` | `FORGE_PROFILE` | `lean`: workspace tools preloaded (no deferred-discovery prompt), no sub-agents, no ask-user. ≈700 fewer prompt tokens per request and no `list_tools`/`call_tool` round trips. |
| `forge.compactAtTokens` | `FORGE_COMPACT_AT` | TrueForge `compaction.trigger = {type: input_tokens, value}` |
| `forge.reasoningEffort` | `FORGE_REASONING` | sent as TrueForge `model.params.reasoning_effort`; `none` turns thinking off on Ollama models (verified in the request dump: `reasoning_effort="none"`) |
| — | `FORGE_CONTEXT_MAX` | hard cap on the `get_context` budget, for providers with tiny per-request limits |

Model properties in TrueForge must list `reasoning_efforts: ["none", …]`, or TrueForge drops the value.
Local models need `max_output_tokens` ≤ 4096 on a 16k context. TrueForge's compaction threshold is `min(0.8·context, context − max_output)`, and 16k − 8k = 8k caused 15 compactions in one run.

## Safety additions (all in `extension/src/changes/prepare.ts`, used by the UI and the bench harness alike)
1. **Removal guard:** refuses an edit that deletes a **pre-existing** top-level function, class, method or module-level assignment, unless `confirm_removal` names it. Definitions the agent added earlier in the same run may be reworked. The baseline is the file as it was before the run first touched it (`ChangeManager.baselineOf`).
2. **Python syntax guard:** the proposed file is parsed with `ast.parse` before review. If the edit would make the file invalid, it is refused, and the model is told the line and message. Nothing is executed. The guard is skipped if no interpreter is found, or if the original file was already invalid.
3. Unchanged and still in force: tolerant matching that only accepts unique matches; stale-file check at apply time (`applyApproved` refuses if the file changed since review); per-hunk review; undo.

## Integration fixes
- `npm run build` now also builds the headless scripts. Earlier, a stale `out/e2e-edit.js` meant some runs used old guard code.
- Provider wait hints are honoured in both formats ("retry in Ns" and Groq's "Please try again in 13.8s"), with up to 8 hinted waits. Waits over 65 s (daily quota) fall back instead. Also fixed the retry loop bound that previously capped this at 3.
- Retrieval now pulls in the dependencies of hot files.
- Agent instructions now include efficiency rules, the safe-insert pattern (`end_line = start_line − 1`), and a `## Compact Instructions` section. TrueForge's summariser follows that section, so summaries keep the original request, files, edits, tests and next step.

## Tools added for measurement
- `scripts/reasoning-shim.mjs [upstream] [port] [--dump dir]`: pass-through proxy. It strips `reasoning_content` and can optionally dump requests (no auth header is dumped).
- `scripts/prompt-breakdown.mjs <dumpDir> [--tools]`: token share per part of each request.
- `scripts/session-metrics.mjs <log|session…>`: provider-reported usage per TrueForge session.
- `bench/run.sh`: the repeatable benchmark (see MODEL_BENCHMARK.md).

## Unit tests
46 tests (vitest). New ones cover: wait-hint parsing, reporting of Python syntax errors, removed module-level assignments, and the baseline rule (the agent may rework its own additions but not pre-existing code).
