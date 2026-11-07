# Token and request optimisation

## How it was measured
1. **Exact prompts.** `scripts/reasoning-shim.mjs --dump <dir>` sits between TrueForge and the provider and saves every request body. It drops the auth header and stores no secrets. `scripts/prompt-breakdown.mjs <dir>` then splits each request into system prompt, tool schemas, user turns, assistant turns and tool results, at chars/4 (the same estimate TrueForge uses).
2. **Provider-reported usage.** `scripts/session-metrics.mjs <e2e log>` reads the real `usage` of every `model.message` event from the TrueForge session API. It reports requests, input/output tokens, the largest single input, tool calls by name, failed tool results and model errors.

## Findings (before any change)
| Measurement | Value | Source |
|---|---|---|
| Fixed part of every request, `full` profile | ≈3.3k tokens: system 885 + **12 tool schemas 2,433** | dump of 20 requests (qwen3 via Ollama) |
| Largest tool schemas | `ask_user_question` 494, `propose_edit` 443, `create_sub_agent` 217, deferred-loading meta-tools (`call_tool`, `get_tool_info`, `get_tool_output_schema`, `list_tools`) 555 together | same |
| Gemini flash-lite session (run 5) | 28 requests, **836k input tokens**, largest request **40.6k**, output only 4.3k | TrueForge usage |
| Wasted calls | **9 of 28 calls (32%)** were tool discovery (`list_tools`×3, `call_tool`×6). The cause is TrueForge's deferred-loading prompt: "The Agent MUST use list_tools and get_tool_info to discover tools before calling them". | same |
| Why requests reached 40k | TrueForge compacts at 80% of the context window by default. For a 1M-token model that is 800k tokens, so history was never compacted. | TrueForge `ContextCompaction.ts` (`DEFAULT_CONTEXT_COMPACTION_RATIO = 0.8`) |
| Same task on a 16k-context model | requests stay 3.4–6.9k, because compaction triggers | dump |

**Conclusion:** the 28–40k requests came from history that was never compacted, plus deferred tool-discovery round trips. Tool output volume was not the main driver.

## Changes made (all generic; nothing is Flask-specific)
| Change | Where | Effect (measured) |
|---|---|---|
| **`lean` profile:** all workspace tools preloaded, so the "discover tools first" instruction disappears; no sub-agents; no ask-user | `extension/src/trueforge/agentSpec.ts`, setting `forge.profile`, env `FORGE_PROFILE` | fixed part 3.3k → **2.7k** tokens per request; no `list_tools`/`call_tool` round trips in lean runs. TrueForge still sends its 4 meta-tool schemas. |
| **Configurable compaction trigger:** TrueForge `context_management.compaction.trigger = {type: input_tokens, value}` | same; setting `forge.compactAtTokens`, env `FORGE_COMPACT_AT` | caps the size of every request; required for Groq's 8K TPM |
| `get_context` default budget 6000 → **3000** (max 24000 → 12000) | `extension/src/mcp/contextTools.ts` | smaller first tool result |
| Retrieval pulls in dependencies of hot files | `extension/src/context/retrieve.ts` | the right file is found in one call (mini benchmark: `shop/pricing.py` now included) |
| Agent rules: running checklist, ~15-call budget, never repeat a search or read, one `propose_edit` per file, **insert new code with `end_line = start_line − 1`** | `agent/forge-coder.json` | fewer calls and no overwrites |
| `run_command` preloaded | `agent/forge-coder.json` | no deferred call needed to run tests |
| Provider wait hints honoured ("Please try again in 13.8s"), up to 8 waits instead of 3 when the provider states a wait ≤65 s; longer waits (daily quota) fall back quickly | `extension/src/trueforge/agentRunner.ts` | TPM-limited providers wait instead of failing |

## Not done, on purpose
- **Prompt caching** cannot be controlled from our side. Groq caches automatically, but reported 0 cached tokens on our requests. OpenRouter's free plan has no caching.
- **Splitting a request** across calls would change TrueForge's turn semantics, so we did not do it.
- **Rewriting TrueForge's own system prompt or meta-tools** would require forking TrueForge. Not done.
- **Compound tools** (`inspect_symbol`, `run_test_suite`) were not added. `get_context` already returns outlines, snippets and test counterparts in one call, and `run_command` already returns a concise result.
