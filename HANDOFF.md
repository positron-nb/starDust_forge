# Handoff

## State (2026-11-06)
- TrueForge running locally from npx on :8790, started with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'` (required so it can reach our loopback MCP server — see TECHNICAL_RESEARCH.md).
- `poc/poc.mjs`: registers a localhost Streamable-HTTP MCP server via `client.settings.mcpServers.createOrUpdate` → **VERIFIED** TrueForge lists its `read_file` tool (`GET /api/v1/mcp-servers/forge-poc/tools`).
- Flask cloned at `flask/`, tag 3.1.3, HEAD `22d924701a6ae2e4cd01e9a15bbaf3946094af65` (VERIFIED).
- TrueForge source for reference at `research/trueforge` @ 9900d65.

## Pending human actions
1. ~~PDF~~ done (problem_statement.pdf, gitignored).
2. ~~Model~~ done: google-gemini (free tier) configured.

## Commands
```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx -y @truefoundry/trueforge@latest
cd poc && node poc.mjs <provider/model>      # full PoC turn
```

## Next steps
1. Run PoC turn with real model → verify streaming + tool call + turn.done.
2. Probe failure surface with invalid key / unreachable custom endpoint.
3. Scaffold `extension/` (Phase 2).
