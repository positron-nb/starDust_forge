// Phase-1 PoC: TrueForge drives the loop; we serve a localhost MCP tool (read_file).
// Usage: node poc.mjs <model-fqn>   e.g. anthropic/claude-sonnet-4-6
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { z } from 'zod';

const BASE = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const MODEL = process.argv[2];
const ROOT = path.resolve('fixture');
const PORT = 8799;

function makeServer() {
  const s = new McpServer({ name: 'forge-poc', version: '0.0.1' });
  s.registerTool('read_file', {
    description: 'Read a UTF-8 file from the workspace by relative path.',
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ path: rel }) => {
    const abs = path.resolve(ROOT, rel);
    if (!abs.startsWith(ROOT)) return { content: [{ type: 'text', text: 'outside workspace' }], isError: true };
    console.log(`\n[mcp] read_file(${rel})`);
    return { content: [{ type: 'text', text: await fs.readFile(abs, 'utf8') }] };
  });
  return s;
}

// Stateless streamable-HTTP MCP endpoint
http.createServer(async (req, res) => {
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => t.close());
  await makeServer().connect(t);
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => t.handleRequest(req, res, body ? JSON.parse(body) : undefined));
}).listen(PORT, '127.0.0.1');

await fs.mkdir(ROOT, { recursive: true });
await fs.writeFile(path.join(ROOT, 'secret_plan.txt'), 'The launch codeword is BLUE-HERON-42.\n');

const client = new TrueForge({ baseUrl: BASE, timeoutInSeconds: 600 });
const manifest = { type: 'remote', name: 'forge-poc', description: 'PoC workspace tools', url: `http://127.0.0.1:${PORT}/mcp` };
await client.settings.mcpServers.createOrUpdate({ manifest });
console.log('registered MCP server forge-poc');
if (!MODEL) { console.log('serving for 15s'); setTimeout(() => process.exit(0), 15000); await new Promise(()=>{}); }

const { data: session } = await client.sessions.create({
  agent: { spec: {
    model: { name: MODEL },
    instructions: 'Use the read_file tool to answer. Be brief.',
    mcp_servers: [{ name: 'forge-poc', preload: true }],
  } },
});
console.log('session', session.id);
const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: 'user.message', content: 'What is the codeword in secret_plan.txt?' }],
});
const ev = new Map();
for await (const { data: e } of stream.withMetadata()) {
  if (isEventDelta(e)) { const b = ev.get(e.id); if (b) mergeEventDelta(b, e); process.stdout.write(e.content ?? ''); continue; }
  ev.set(e.id, e);
  console.log(`\n<${e.type}>`, e.type === 'turn.done' ? JSON.stringify(e.state).slice(0, 400) : '');
}
process.exit(0);
