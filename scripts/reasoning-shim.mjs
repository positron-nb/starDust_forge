#!/usr/bin/env node
/**
 * Tiny OpenAI-compatible pass-through for providers that reject replayed
 * `reasoning_content` on assistant messages (e.g. Groq gpt-oss: HTTP 400
 * "property 'reasoning_content' is unsupported"). TrueForge replays it for
 * custom OpenAI-compatible providers; this shim strips it and forwards the
 * request unchanged otherwise. It stores no credentials: the Authorization
 * header set by TrueForge is forwarded as-is.
 *
 *   node scripts/reasoning-shim.mjs [upstream] [port]
 *   default upstream https://api.groq.com/openai/v1, port 8791
 *
 * Then point the TrueForge custom provider's base URL at http://127.0.0.1:8791/v1
 * (TrueForge must run with OUTBOUND_URL_ALLOWED_HOSTS including 127.0.0.1).
 */
import http from 'node:http';

const upstream = (process.argv[2] ?? 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const port = Number(process.argv[3] ?? 8791);

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
      raw = Buffer.from(JSON.stringify(stripReasoning(JSON.parse(raw.toString('utf8')))));
    }
    const path = (req.url ?? '/').replace(/^\/v1/, '');
    const headers = {};
    for (const h of ['authorization', 'content-type', 'accept']) if (req.headers[h]) headers[h] = req.headers[h];
    const r = await fetch(upstream + path, { method: req.method, headers, body: raw.length ? raw : undefined });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
    if (r.body) for await (const c of r.body) res.write(c);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `shim: ${err.message}` } }));
  }
});

server.listen(port, '127.0.0.1', () => console.log(`reasoning-shim → ${upstream} on http://127.0.0.1:${port}/v1`));
