# VS Code UI checklist (manual verification)

Headless tests UI ko verify nahi karte, isliye yeh 13 checks aapko VS Code mein khud karne hain. Har check ke saamne ✅/❌ likho, aur ❌ wale ka screenshot bhejo.

## Setup (ek baar)
1. **TrueForge chalao.** PowerShell mein, repo folder se:
   `$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'; npx @truefoundry/trueforge@latest`
   Yeh window khuli rehne do.
2. **Extension build karo.** Dusre terminal mein: `cd extension; npm run build`
3. **Extension Development Host kholo.** VS Code mein `extension` folder kholo → **F5** dabao (ya Run → Start Debugging). Ek nayi VS Code window khulegi. Usme **File → Open Folder → `flask`** kholo.
4. **Settings set karo.** Nayi window mein Ctrl+, dabao aur `forge` search karo:
   - `forge.models` = `["google-gemini/gemini-3-5-flash", "openrouter/nemotron-ultra"]`
   - `forge.profile` = `lean`, `forge.compactAtTokens` = `100000`
5. **Flask clean check karo.** Terminal mein `git status --short` chalao. Output khaali hona chahiye.

## Checks
| # | Kya karna hai | Expected | Screenshot |
|---|---|---|---|
| 1 | `src/flask/helpers.py` kholo, `get_debug_flag` function (lines 28–33) select karo, **Ctrl+Alt+E** dabao, Task A instruction paste karke Enter | Ek input box aata hai, phir progress notification | — |
| 2 | Kuch seconds ruko | **Diff editor** khulta hai (left: original, right: proposed). Hunks highlighted hain. Forge panel mein review card dikhta hai. | diff editor |
| 3 | Pehle hunk pe cursor rakh ke **Alt+N** (reject), dusre pe **Alt+Y** (accept) | Hunk ka colour/label "rejected" ya "accepted" badalta hai; panel card update hota hai | card |
| 4 | **Ctrl+Alt+Enter** (Apply) | Sirf accepted hunk file mein jaata hai; `git diff` mein sirf woh dikhta hai | git diff |
| 5 | Command Palette (Ctrl+Shift+P) → **Forge: Undo Last Applied Change** | File wapas original; `git status --short` khaali | — |
| 6 | Forge panel mein koi bhi sawaal likho (jaise "explain get_debug_flag") | Jawab **token-by-token stream** hota hai, ek saath nahi aata | short screen recording |
| 7 | Panel mein Task B instruction bhejo, aur 5–10 second baad **Cancel** button (ya Ctrl+Alt+C) dabao | Panel mein "cancelled" status; stream ruk jata hai | panel |
| 8 | Cancel ke turant baad `git status --short` | **Khaali** (koi aadha edit nahi) | terminal |
| 9 | Task B dobara bhejo (pura chalne do) | Panel mein **"📚 Context selected"** table aata hai: files, symbols, har row ka *reason* | table |
| 10 | Usi table ke upar | **Budget bar** (used/budget tokens) dikhta hai | — |
| 11 | Panel mein **"TrueForge session ↗"** link dabao (ya Command Palette → Forge: Open TrueForge Session) | Browser mein TrueForge session: turns, tool calls (`get_context`, `read_files`, `propose_edit`, `run_commands` …) | TrueForge page |
| 12 | Settings: `forge.models` = `["broken/dead-model", "google-gemini/gemini-3-5-flash"]` (pehle `node scripts/setup-trueforge.mjs --only-broken` chalao agar `broken` provider nahi hai). Task A dobara | Panel: "Model endpoint unreachable… Falling back to google-gemini/gemini-3-5-flash automatically", phir diff aata hai. Aapne model khud nahi badla. | panel message |
| 13 | Us diff ko **reject** karo (Alt+N sab pe, phir Apply) ya review band karo; phir `git status --short` | **Khaali** | terminal |

## Mujhe kya bhejna hai
- 13 checks ki ✅/❌ list.
- ❌ wale ka screenshot, aur VS Code ke **Output → Forge Agent** channel ki last ~30 lines.
- Kuch bhi ajeeb dikhe (jaise button kaam na kare, ya diff khaali ho), toh woh bhi likhna.
