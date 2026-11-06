# Forge Agent — an editor-native coding agent on TrueForge

A VS Code extension whose agent loop runs on **[TrueForge](https://github.com/truefoundry/trueforge)**. The extension is a TrueForge client: it opens sessions, streams turns and renders events, and it exposes the editor (context retrieval, file reading/search, proposed edits, terminal) as **MCP tools**. The agent decides what to read and change; **TrueForge tool approval drives the hunk-by-hunk diff review**, so nothing reaches disk without the user accepting it.

Built for the IIT Bombay Techfest 2026 TrueFoundry Forge-a-thon.

**Starting point:** from scratch (no fork). Dependencies: `@truefoundry/trueforge-sdk` (MIT), `@modelcontextprotocol/sdk` (MIT), `zod` (MIT), `diff`/jsdiff (BSD-3-Clause).

| Capability | Where |
|---|---|
| Inline edit (Ctrl+Alt+E) → diff with per-hunk accept/reject | `extension/src/ui/inlineEdit.ts`, `ui/review.ts` |
| Agent mode panel (tool loop on TrueForge, subagents, streaming) | `ui/agentView.ts`, `media/panel.js` |
| Context assembly (@file/@symbol, BM25 + import graph, token budget, reasons) | `src/context/*`, MCP tool `get_context` |
| Diff review (hunks, apply accepted only, undo per change / per run) | `src/changes/*`, `ui/review.ts` |
| Streaming + cancellation (no half-applied edits) | `trueforge/agentRunner.ts`, `changes/changeManager.ts` |
| Resilience (retry honouring provider hints, automatic model fallback) | `trueforge/agentRunner.ts` |
| Agent definition | [`agent/forge-coder.json`](agent/forge-coder.json) |

Design details: [ARCHITECTURE.md](ARCHITECTURE.md) · research notes: [TECHNICAL_RESEARCH.md](TECHNICAL_RESEARCH.md).

## Setup from a clean clone

Requirements: Node ≥ 22.14, VS Code ≥ 1.95, Git. Python 3.10+ only for the Flask demo.

### 1. Start TrueForge locally
The extension's MCP server listens on `127.0.0.1`; TrueForge's outbound SSRF guard blocks loopback unless it is allow-listed:

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest
```
PowerShell:
```powershell
$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'; npx @truefoundry/trueforge@latest
```
TrueForge UI/API: <http://localhost:8790>. Tested with TrueForge @ `9900d65` (2026-11-05) and SDK `0.184.1`.

### 2. Configure models and load the agent definition
Either add a provider in the TrueForge UI (**Settings → Models**), or:
```bash
cp config/models.example.json config/models.json   # put your key(s) here; this file is gitignored
node scripts/setup-trueforge.mjs                     # registers providers + saves agent "forge-coder" in TrueForge
```
Any TrueForge provider works (OpenAI, Anthropic, Gemini, OpenAI-compatible `custom`, …). The extension never calls a model provider directly.

### 3. Build and run the extension
```bash
cd extension
npm install
npm run build
npx vitest run          # unit tests
code --extensionDevelopmentPath="$PWD" /path/to/your/repo
```
Open the **Forge Agent** view in the activity bar. Settings:

| Setting | Default | Meaning |
|---|---|---|
| `forge.baseUrl` | `http://localhost:8790` | TrueForge server |
| `forge.models` | `["google-gemini/gemini-3-5-flash", "google-gemini/gemini-3-1-flash-lite"]` | Model FQNs **in fallback order**. Switching model = editing this list. |
| `forge.autoApproveCommands` | pytest / `flask --help` / `git status` | Regexes of commands run without a confirmation prompt |

### Keys
| Key | Action |
|---|---|
| Ctrl+Alt+E | Inline edit selection |
| Alt+Y / Alt+N | Accept / reject the hunk at the cursor (in a Forge review diff) |
| Ctrl+Alt+Enter | Apply review decisions |
| Ctrl+Shift+Esc | Cancel the agent run |
| Commands | `Forge: Undo Last Applied Change`, `Forge: Undo Agent Run`, `Forge: Open TrueForge Session` |

## Fixed tasks (Flask 3.1.3, commit 22d92470)
```bash
git clone https://github.com/pallets/flask && cd flask && git checkout 3.1.3
python -m venv .venv && .venv/Scripts/python -m pip install -e . "pytest==8.4.2" asgiref greenlet python-dotenv   # bin/ on Linux/macOS
printf '.venv/\n.pytest_cache/\n' >> .git/info/exclude   # keep `git status` clean for Task C
```
- **A** – select `get_debug_flag` in `src/flask/helpers.py`, Ctrl+Alt+E, give the instruction, review, apply. Verify (Git Bash): `FLASK_DEBUG=off .venv/Scripts/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False`.
- **B** – paste the Task B instruction in the panel (no files named). Verify: `pytest tests/test_cli.py -q`, then `flask --app <app> config`.
- **C** – `node scripts/setup-trueforge.mjs --only-broken`, set `forge.models` to `["broken/dead-model", "google-gemini/gemini-3-5-flash"]`, repeat A: the panel reports the unreachable endpoint and falls back automatically; `git status` shows no changes if you reject or cancel.

Headless rehearsals (same modules, no UI): `extension/scripts/e2e-edit.ts`, logs in `demo/`.

## Security
- Tools are confined to the workspace; `.git/`, `.env*`, keys/certs are denied.
- The MCP server binds to 127.0.0.1 and requires a random per-session bearer token (registered with TrueForge as header auth).
- Writes only via `propose_edit` after review; commands are approval-gated with a hard deny-list (`rm -rf /`, `git push`, `reset --hard`, `curl | sh`, …).
- No API keys in this repository; `config/models.json` is gitignored.

## License
MIT — see [LICENSE](LICENSE).
