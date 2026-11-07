/**
 * One-request provider connectivity check THROUGH TrueForge (no tools, tiny prompt).
 *   node out/ping.js <provider/model>
 */
import { AgentRunner } from '../src/trueforge/agentRunner';

const model = process.argv[2];
if (!model) { console.error('usage: node out/ping.js <provider/model>'); process.exit(2); }
(async () => {
  const runner = new AgentRunner({ baseUrl: 'http://localhost:8790', models: [model],
    spec: { instructions: 'Reply with exactly: OK', mcpServers: [], config: { contextManagement: { compaction: { enabled: false } } } } });
  const t0 = Date.now();
  const r = await runner.run('ping', { onStatus: (s, l) => console.log(`[${l}] ${s}`), onApproval: async () => ({ allow: false }) });
  console.log(`PING ${model}: ${r.status} in ${Date.now() - t0} ms; reply=${JSON.stringify((r.output ?? r.error ?? '').slice(0, 80))}`);
  process.exit(r.status === 'done' ? 0 : 1);
})();
