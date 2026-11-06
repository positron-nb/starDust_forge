# Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Official PDF not yet in workspace — requirements taken from the user's brief | High | Human action: place PDF in repo root; re-audit against it |
| R2 | No model API key yet | Blocks PoC | Human action (key via TrueForge Settings UI, never in repo) |
| R3 | TrueForge SSRF guard blocks loopback MCP server | Blocks tools | Start TrueForge with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'` (verified in source) |
| R4 | No native model fallback | Resilience score | Client-side fallback chain via new sessions |
| R5 | Windows env: `FLASK_DEBUG=off python ...` syntax is POSIX | Demo | Use Git Bash, or PowerShell `$env:FLASK_DEBUG='off'` |
| R6 | Agent may write via its own sandbox instead of our tools | Diff safety | Sandbox disabled in agent spec; only our MCP tools can modify |
| R7 | Model quality on Task B (3+ files) | Score | Strong instructions + get_context tool; rehearse with Claude/GPT |
| R8 | TrueForge is fast-moving (`@latest`) | Breakage | Pin the version we test with in README |
