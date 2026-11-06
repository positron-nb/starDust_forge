/**
 * Headless smoke test of the real extension modules (no VS Code UI):
 *   1) fallback: primary model is the dead `broken/dead-model` → must switch to Gemini automatically
 *   2) discovery: agent uses our MCP tools on the Flask repo
 *   3) cancellation: cancel mid-run returns 'cancelled' promptly
 * Usage: node out/smoke.js <workspace> <fallback-model>
 */
import { EditorMcpServer } from '../src/mcp/server';
import { installReadTools } from '../src/mcp/tools';
import { Workspace } from '../src/mcp/workspace';
import { AgentRunner } from '../src/trueforge/agentRunner';
import { loadAgentSpec } from '../src/trueforge/agentSpec';

const [root, model] = process.argv.slice(2);
const ws = new Workspace(root);
const calls: string[] = [];
const mcp = new EditorMcpServer(s => installReadTools(s, { ws, rgPath: 'rg', onToolCall: (n, a) => calls.push(`${n} ${JSON.stringify(a)}`) }));

async function main() {
  await mcp.start();
  const runner = new AgentRunner({ baseUrl: 'http://localhost:8790', models: ['broken/dead-model', ...model.split(',')], spec: loadAgentSpec('forge-workspace') });
  await mcp.registerWithTrueForge(runner.sdk, 'forge-workspace');

  console.log('--- 1+2: fallback + discovery');
  let text = '';
  const r1 = await runner.run('Which function in this repository decides whether debug mode is on from the environment, and in which file is it defined? Answer in one sentence.', {
    onStatus: (m, l) => console.log(`[status:${l}] ${m}`),
    onSession: s => console.log(`[session] ${s.sessionId} on ${s.model}`),
    onEvent: (e, merged) => { if (e.type === 'model.message.delta' && merged && typeof (merged as { content?: unknown }).content === 'string') text = (merged as { content: string }).content; },
  });
  console.log('result:', r1.status, r1.model, '|', (r1.output || text).slice(0, 300));
  console.log('tool calls:', calls);

  console.log('--- 3: cancellation');
  runner.reset();
  const t0 = Date.now();
  const p = runner.run('List every Python file under src/flask and summarise each in a paragraph.', { onStatus: (m) => console.log(`[status] ${m}`) });
  setTimeout(() => void runner.cancel(), 4000);
  const r3 = await p;
  console.log('cancel result:', r3.status, `after ${Date.now() - t0}ms`);
  await mcp.stop();
  process.exit(r1.status === 'done' && r3.status === 'cancelled' ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
