# Handoff

## State (2026-11-06, end of Phase 2)
- TrueForge running locally (npx, :8790) with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`.
- Models configured in TrueForge: google-gemini (free tier, 5 RPM). Test provider `broken/dead-model` → `http://127.0.0.1:9/v1` (for Task C).
- `extension/` builds (`npm run build`), typechecks, 8 unit tests pass (`npx vitest run`).
- Headless smoke (`extension/scripts/smoke.ts`) VERIFIED: automatic fallback broken→gemini, 429 retry honouring hint, agent discovers get_debug_flag via our MCP tools on Flask, cancel → 'cancelled' in ~4s.
- Agent definition: `agent/forge-coder.json` (snake_case HTTP format; converted in `src/trueforge/agentSpec.ts`).
- Flask at `flask/` @ 22d92470.

## Not yet done / unverified
- Extension never launched inside VS Code yet (panel UI unverified visually).
- Tools still read-only: no find_symbol/get_context/propose_edit/run_command; approvals are auto-denied.

## Commands
```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx -y @truefoundry/trueforge@latest
cd extension && npm run build && npx vitest run
npx esbuild scripts/smoke.ts --bundle --platform=node --format=cjs --outfile=out/smoke.js && node out/smoke.js ../flask google-gemini/gemini-3-5-flash,google-gemini/gemini-3-1-flash-lite
```

## Next steps
1. Human: launch extension (F5 / Extension Development Host) on flask/ and check the panel.
2. Phase 3: find_symbol, run_command (approval-gated). Phase 4: get_context engine. Phase 5: propose_edit + hunk review driven by tool.approval_required.
