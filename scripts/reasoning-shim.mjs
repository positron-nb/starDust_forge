#!/usr/bin/env node
/**
 * Tiny OpenAI-compatible pass-through used between TrueForge and a provider.
 *  - strips replayed `reasoning_content` from assistant messages (providers such as
 *    Groq gpt-oss reject it: HTTP 400 "property 'reasoning_content' is unsupported");
 *  - optionally dumps every request body (minus auth) to a folder so the prompt-token
 *    breakdown (system / tools / history) can be measured.
 * It stores no credentials: the Authorization header set by TrueForge is forwarded as-is
 * and never written to disk.
 *
 *   node scripts/reasoning-shim.mjs [upstream] [port] [--dump <dir>]
 *   default upstream https://api.groq.com/openai/v1, port 8791
 *
 * Point a TrueForge custom provider's base URL at http://127.0.0.1:<port>/v1
 * (TrueForge must run with OUTBOUND_URL_ALLOWED_HOSTS including 127.0.0.1).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dumpIdx = args.indexOf('--dump');
const dumpDir = dumpIdx >= 0 ? args.splice(dumpIdx, 2)[1] : undefined;
const upstream = (args[0] ?? 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const port = Number(args[1] ?? 8791);
if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });
let seq = 0;

export function stripReasoning(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  for (const m of body.messages) {
    if (m && typeof m === 'object') {
      delete m.reasoning_content;
      delete m.reasoning;
      delete m.thinking_blocks;
    }
  }
  return body;
}

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let raw = Buffer.concat(chunks);
    if (raw.length && (req.headers['content-type'] ?? '').includes('json')) {
      const body = stripReasoning(JSON.parse(raw.toString('utf8')));
      if (dumpDir && Array.isArray(body.messages)) {
        fs.writeFileSync(path.join(dumpDir, `req-${String(++seq).padStart(3, '0')}.json`), JSON.stringify(body));
      }
      raw = Buffer.from(JSON.stringify(body));
    }
    const p = (req.url ?? '/').replace(/^\/v1/, '');
    const headers = {};
    for (const h of ['authorization', 'content-type', 'accept']) if (req.headers[h]) headers[h] = req.headers[h];
    const r = await fetch(upstream + p, { method: req.method, headers, body: raw.length ? raw : undefined });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
    if (r.body) for await (const c of r.body) res.write(c);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `shim: ${err.message}` } }));
  }
});

server.listen(port, '127.0.0.1', () => console.log(`reasoning-shim → ${upstream} on http://127.0.0.1:${port}/v1${dumpDir ? ` (dumping to ${dumpDir})` : ''}`));
