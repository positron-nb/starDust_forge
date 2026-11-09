# Model benchmark (7 Nov 2026)

Every number below comes from the real TrueForge pipeline. `bench/run.sh` runs the extension's MCP tools, TrueForge sessions, approval-gated `propose_edit` with a simulated accept-all review, and all guards. Request and token counts are the **provider-reported usage** from TrueForge session events (`scripts/session-metrics.mjs`). Raw logs, metrics, diffs and test output are in `bench/results/`.

```bash
bench/run.sh <mini|taskb> <provider/model[,fallback]> [full|lean] [compactAt]
# env: FORGE_REASONING=none  FORGE_CONTEXT_MAX=1500
```

**Stages**
- **mini** (stages A+B): `bench/fixtures/shop`, a 3-file repo. The instruction does not name a file. The model must find the bug in `shop/pricing.py` (it is imported by `cart.py`), read it, propose a safe edit and run pytest. Pass means `2 passed`. It costs about 5 requests.
- **taskb** (stage C): the official Flask 3.1.3 Task B. Pass means 59 passed, ≥3 files changed and no pre-existing definition deleted.

## Results

| Model (provider) | Stage | Outcome | Requests | Input tok | Output tok | Tool calls / errors | Time | Tests |
|---|---|---|---|---|---|---|---|---|
| qwen3:8b (local) full | mini | ✅ | 6 | 21k | 3.5k | 5 / 1 | 75 s | 2 passed |
| qwen3:8b (local) lean | mini | ❌ duplicated line with a stray quote (now blocked by the syntax guard) | 11 | 37k | 11k | 10 / 4 | 239 s | collection error |
| qwen2.5-coder:7b (local) | mini | ❌ never called a tool | 1 | 2.5k | 39 | 0 / 0 | 23 s | 1 failed |
| **mimo-v2.6 9B (local)** | mini | ✅ | 5 | 17k | 0.5k | 6 / 0 | 51 s | 2 passed |
| **ornith 9B (local)**, thinking off | mini | ✅ | 5 | 18k | 0.4k | 4 / 0 | **12 s** | 2 passed |
| **nemotron-3-ultra-550b:free (OpenRouter)** | mini | ✅ | 6 | 26k | 1.0k | 6 / 0 | 19 s | 2 passed |
| nemotron-3.5-lightning:free (OpenRouter) | mini | ✅ | 8 | 41k | 1.8k | 9 / 0 | 25 s | 2 passed |
| gemma-4-31b-it:free (OpenRouter) | mini | ❌ provider error ×3, 0 requests served | 0 | – | – | – | 22 s | – |
| gpt-oss-120b (Groq free) | mini | ⚠ fix applied and tests pass, then 429 TPM | 3–5 | 8–14k | 0.5k | 3–5 / 0–1 | 20–38 s | 2 passed |
| gpt-oss-120b (Groq free) | taskb ×3 | ❌ 413 (single request > 8K TPM), then 9× 429 with "Used ≈5k, Requested ≈6.2k" | 1–2 | ≤6k | – | – | – | 58 (unchanged) |
| nemotron-3-ultra-550b:free | taskb | ❌ ran out of the **50 requests/day**: 29 of 39 calls were `read_file` re-reads after early compaction (trigger 24k) | 39 | 499k | 4.9k | 40 / 7 | 258 s | 58 (unchanged) |
| mimo-v2.6 9B (local) | taskb | ❌ compacted 15× (threshold = 16k ctx − 8k max output = 8k); summaries lost the task and it drifted to `git log` | 73 | 410k | 8.3k | 103 / 55 | 31 min | 58 (unchanged) |
| ornith 9B (local), thinking on | taskb | ❌ thinking used all 4,096 output tokens | 3 | 21k | 4.3k | 2 / 0 | 126 s | – |
| ornith 9B (local), thinking off | taskb | ❌ loop of 131 edits; broke `add_command` usage; guards blocked invalid Python and deletions | 240 | 1.94M | 43k | 239 / 153 | 26 min | import error |
| **nemotron-3-ultra-550b:free, after fixes (9 Nov)** | **taskb** | ✅ **PASS**: 3 files, 61 passed in test_cli.py, 0 deletions, 0 compactions, 0 duplicate reads | 54 | 1.70M | 9.5k | 54 / 4 | 270 s | 61 passed |
| gemini-3-8-flash / 3-7-flash (free) | mini | ❌ 503 "high demand" and connection failures | 0 | – | – | – | – | – |

No run deleted a pre-existing definition. `deleted-defs = 0` in every run, and the Flask tree was restored after each run.

## What this shows
1. **Tool calling works on every model that reached the provider** except qwen2.5-coder 7B. The pipeline is not the bottleneck.
2. **Small local models (8–9B) solve the 3-file task but not Task B.** Task B needs consistent multi-file reasoning across about 20 steps. Each local model either drifted or looped, even with guards and thinking off.
3. **Groq's free tier cannot hold this agent.** The smallest useful request (system prompt + tool schemas + one 1.5k-token code read) is ≈6.2k tokens by Groq's count, against an 8K-per-minute budget.
4. **OpenRouter Nemotron 3 Ultra is the strongest free candidate.** It finished mini cleanly and made correct edits on Task B. The run failed only because early compaction made it re-read files until the 50/day cap ran out. Its next run will use TrueForge's default compaction (≈105k for a 131k context), which removes the re-read cause.
