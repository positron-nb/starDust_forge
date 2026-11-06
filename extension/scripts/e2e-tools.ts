/** Headless E2E: TrueForge agent uses get_context + approval-gated run_command on a real repo. */
import { EditorMcpServer } from '../src/mcp/server';
import { installReadTools } from '../src/mcp/tools';
import { installContextTools } from '../src/mcp/contextTools';
import { installCommandTool } from '../src/mcp/commandTool';
import { Workspace } from '../src/mcp/workspace';
import { ContextIndex } from '../src/context/index';
import { AgentRunner } from '../src/trueforge/agentRunner';
import { loadAgentSpec } from '../src/trueforge/agentSpec';

const [root, models] = process.argv.slice(2);
const ws = new Workspace(root);
const index = new ContextIndex(ws);
const log: string[] = [];
const mcp = new EditorMcpServer(s => {
  const onToolCall = (n: string, a: unknown) => { log.push(`${n} ${JSON.stringify(a)}`); console.log(`  [tool] ${n} ${JSON.stringify(a).slice(0, 120)}`); };
  installContextTools(s, { index, onToolCall, onContext: r => console.log(`  [context] ${r.items.length} items ${r.used}/${r.budget} tok: ${[...new Set(r.items.map(i => i.file))].join(', ')}`) });
  installReadTools(s, { ws, rgPath: 'rg', onToolCall });
  installCommandTool(s, { ws, onToolCall });
});

(async () => {
  await mcp.start();
  const runner = new AgentRunner({ baseUrl: 'http://localhost:8790', models: models.split(','), spec: loadAgentSpec('forge-workspace') });
  await mcp.registerWithTrueForge(runner.sdk, 'forge-workspace');
  let approvals = 0;
  const r = await runner.run('Find the code that implements the built-in "flask routes" command and its tests, then run only the CLI test module and report how many tests passed. Do not modify any files.', {
    onStatus: (m, l) => console.log(`[${l}] ${m}`),
    onSession: s => console.log(`[session] http://localhost:8790/sessions/${s.sessionId} (${s.model})`),
    onApproval: async req => { approvals++; console.log(`  [approval] ${req.toolName} ${JSON.stringify(req.args)} → allow`); return { allow: true }; },
  });
  console.log(`\nRESULT ${r.status} on ${r.model}; approvals=${approvals}\n${r.output}`);
  await mcp.stop();
  process.exit(r.status === 'done' ? 0 : 1);
})();
