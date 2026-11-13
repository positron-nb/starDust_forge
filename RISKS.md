# Risks

| # | Risk | Status | Mitigation |
|---|---|---|---|
| R1 | TrueForge blocks loopback MCP servers (SSRF guard) | Handled | Start with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'` |
| R2 | TrueForge has no native model fallback | Handled | Client-side fallback chain with task-state handoff |
| R3 | TrueForge releases change the protocol (0.185 changed approvals) | Handled, still a risk | Version pinned to 0.185.0 in all docs; both approval protocols supported |
| R4 | Free-tier limits: OpenRouter 50 requests/day, Gemini 429/503 spikes | **Open** | Chain Nemotron → Gemini Flash → Flash-Lite; provider wait hints honoured; record after the 05:30 IST reset and run nothing else on OpenRouter that day |
| R5 | Free models vary run to run on Task B (pass, or cut off by quota) | **Open** | Plan gates, loop brake, completion check and handoff reduce it; allow 1–2 attempts for the video |
| R6 | Weak models damage code (delete definitions, rewrite tests, invalid syntax) | Handled | Guards refuse these edits before review; verified in real runs |
| R7 | Agent writes outside the reviewed path | Handled | Sandbox off; only `propose_edit` writes; commands approval-gated with a deny-list |
| R8 | UI paths seen only by tests, not by a person | **Open** | 10 integration tests in real VS Code cover review/apply/undo/cancel; `docs/UI_CHECKLIST.md` covers the rest |
| R9 | Windows shell differences (`FLASK_DEBUG=off cmd` is POSIX) | Handled | Demo commands use Git Bash; `run_commands` uses argv lists |
| R10 | Secrets in the repo | Handled | Keys only in TrueForge or gitignored `config/models.json`; logs scanned and an org id redacted before pushing |
