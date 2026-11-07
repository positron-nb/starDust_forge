# Free model research (verified 7 Nov 2026)

Workload this has to serve (measured, see TOKEN_OPTIMIZATION.md): one Task B run makes about 15–30 model requests. In the `lean` profile each request carries a fixed ≈2.7k tokens (system prompt and tool schemas) plus history. With compaction left at the TrueForge default, a request on a 1M-context model grows to 40k+ tokens.
The question for each provider is therefore not the context window. It is whether the **per-request size × the number of requests** fits under its per-minute, per-day and request-count limits.

Every number below was read from the provider's own page on 7 Nov 2026, with the URL given. **UNKNOWN** means the page did not state it. Nothing below is guessed.

## Summary

| Provider | Free model(s) with tool calling | Binding free limit | Fits our workload? |
|---|---|---|---|
| **Groq** (`https://api.groq.com/openai/v1`) | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` | **8K TPM**, 200K TPD, 30 RPM, 1K RPD | **Yes, only in lean profile with early compaction.** Requests must stay ≲6k tokens, giving ≈1–2 requests/min. See benchmark. |
| **OpenRouter** (`https://openrouter.ai/api/v1`) | 13 `:free` models with `tools` (list below) | **50 requests/day** (no credits bought), 20 RPM, **no token limit** | **Yes, for ~1 Task B attempt/day.** Failed requests also count. |
| Google AI Studio (Gemini) | Gemini 3.x Flash / Flash-Lite, Gemma 4 | per-project RPM/TPM/RPD shown only in the AI Studio UI; resets midnight Pacific | Measured: strong Flash models returned 429/503 with 0 tool calls in 6 runs; only Flash-Lite did work |
| Cerebras | `gpt-oss-120b`, `qwen-3.8-27b` | $5 one-time credit, **needs a payment method** | **Not free** (excluded) |
| NVIDIA NIM (`https://integrate.api.nvidia.com/v1`) | many (Kimi K2, DeepSeek V4, GLM 5.x, gpt-oss, Nemotron) | free-tier RPM/TPM/credits **UNKNOWN** (FAQ 404; trial terms PDF not read) | Unverified, so not recommended yet |
| Hugging Face Inference Providers | — | free accounts get **$0** credits ("credits purchase required") | **No** |
| Mistral La Plateforme | `mistral-medium-3-5`, Codestral 25.08 | tier page 404, limits **UNKNOWN** | Unverified |
| SambaNova | — | docs returned 403, **UNKNOWN** | Unverified |

## Groq — details
Sources: console.groq.com/docs/rate-limits, /docs/prompt-caching, /docs/models, /docs/reasoning, /docs/errors. The actual numbers were confirmed by Groq's own 429 responses to our account.
- **Limits:** for `openai/gpt-oss-120b`, the rate-limits table shows 30 RPM / 1K RPD / **8K TPM** / 200K TPD. Our account's 429 body confirms it: "tokens per minute (TPM): Limit 8000". `gpt-oss-20b` and `qwen/qwen3.8-27b` show the same 8K / 200K.
- **Unavailable models:** `llama-3.3-70b-versatile` is listed as Enterprise ("Contact sales") and returned 404 for us. Kimi K2 is not offered on Groq.
- **Pricing:** paid gpt-oss-120b is $0.15 in / $0.60 out per 1M tokens. We use only the free tier.
- **Prompt caching:** "Cached tokens do not count towards your rate limits. However, cached tokens are subtracted from your limits after processing…". Caching is automatic prefix matching, supported only on the gpt-oss models. In our 40 captured Groq requests the reported `cached_tokens` was **0**, so caching gave no measurable relief here.
- **Request bigger than the limit:** if a request asks for more than 8K, it fails with HTTP 413 ("Request too large … on tokens per minute"), which we saw on 6 Nov with a ~11k-token request. Waiting cannot fix that, so **every single request must stay below ~7k tokens**. With 8K TPM, the sustainable pace is about one 5k-token request every 40 seconds.
- **Reasoning replay:** TrueForge replays `reasoning_content` on assistant messages, and Groq rejects it with 400. `scripts/reasoning-shim.mjs` strips that field and forwards everything else unchanged. It never stores the key.
- **Context window:** 131,072 tokens; max output 65,536 tokens.

## OpenRouter — details
Sources: openrouter.ai/docs/api-reference/limits, /docs/faq, /pricing, the free-variant guide and the prompt-caching page. The model list comes from `GET https://openrouter.ai/api/v1/models` (public JSON), pulled 7 Nov 2026.
- **Limits:** "Free models are capped at 20 requests per minute and 50 per day, rising to 1,000 per day once your account has bought at least $10 of credits." "Failed attempts count toward that daily cap."
- **Tokens and payment:** no tokens-per-minute or per-request token limit is stated. The Free plan shows "Payment options: No".
- **Prompt caching:** "No" on the Free plan.
- **Data policy:** "We do not train on your data". Each upstream provider's own logging policy was not checked.

Free models that advertise `tools` in `supported_parameters` (context length as listed by the API):

| Model ID | Context | Note |
|---|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 | exists ✔. Its page lists DeepInfra/Baseten/Venice as providers. Free-variant availability not yet tested. |
| `nvidia/nemotron-3.5-super-vl:free` | 1,000,000 | |
| `nvidia/nemotron-3.5-lightning:free` | 1,000,000 | 30B-A3B MoE |
| `dots-studio/dots-3-note-preview:free` | 512,000 | |
| `google/gemma-4-31b-it:free`, `google/gemma-4-26b-a4b-it:free` | 262,144 | |
| `recursive/flint-v1.0:free` | 262,144 | exists ✔, but the page says "no public standard endpoint right now" |
| `xingchen-agi/xing4.0-29b-a4b:free` | 262,144 | exists ✔, same "no public endpoint" note |
| `cohere/north-mini-code:free` | 256,000 | same "no public endpoint" note |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256,000 | |
| `stealth/crouton-alpha` (price 0) | 1,048,576 | stealth model, terms unclear |
| `openrouter/free` (router) | 200,000 | picks a free model for you; not reproducible, so avoid |
| `liquid/lfm-3-1.7b:free`, `liquid/lfm-2.5-2.6b:free` | — | too small for this task |
| ~~`qwen/qwen3.8-27b:free`~~ | — | **does not exist** on OpenRouter (it exists on Groq as `qwen/qwen3.8-27b`) |

## Google AI Studio (Gemini)
Source: ai.google.dev/gemini-api/docs/rate-limits, which redirects to aistudio.google.com/docs/rate-limits.
- **Limits:** "Rate limits are applied per project, not per API key. Requests per day (RPD) quotas reset at midnight Pacific time." The per-model free numbers appear only in the logged-in AI Studio UI, so they are **UNKNOWN** here.
- **Our measurement (6 runs, 6–7 Nov):** `gemini-3-5-flash`, `3-6`, `3-7` and `3-8-flash` hit 429/503 before making any tool call. `gemini-3-1-flash-lite` and `3-5-flash-lite` did all the work, with 28 requests and 836k input tokens in one session (no compaction).

## Excluded, and why
- **Cerebras:** "Is there a permanently free tier? No. … $5 in credits that expire 30 days after they're granted", and the credit needs "a verified payment method".
- **Hugging Face:** "Free users can use Inference Providers by purchasing credits".
- **NVIDIA, Mistral, SambaNova:** their free limits could not be verified from official pages (404/403). They are not recommended until verified.
