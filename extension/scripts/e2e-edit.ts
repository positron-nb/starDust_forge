/**
 * Headless E2E of the edit path with the REAL modules: TrueForge agent → propose_edit →
 * approval pause → ChangeManager review (auto-accept all hunks, as a stand-in for the
 * human) → TrueForge executes → accepted hunks written to disk.
 * Usage: node out/e2e-edit.js <workspace> <models,comma,sep> <task-file.txt>
 *   task file: first line "inline:<path>:<start>-<end>" for inline mode, else agent mode.
 */
import fs from 'node:fs/promises';
import { EditorMcpServer } from '../src/mcp/server';
import { installReadTools } from '../src/mcp/tools';
import { installContextTools } from '../src/mcp/contextTools';
import { installCommandTool } from '../src/mcp/commandTool';
import { installEditTool } from '../src/mcp/editTool';
import { Workspace } from '../src/mcp/workspace';
import { ContextIndex } from '../src/context/index';
import { ChangeManager, type FileIO } from '../src/changes/changeManager';
import { prepareProposal } from '../src/changes/prepare';
import { AgentRunner } from '../src/trueforge/agentRunner';
import { loadAgentSpec } from '../src/trueforge/agentSpec';
import { INLINE_INSTRUCTIONS } from '../src/trueforge/inlinePrompt';

const [root, models, taskFile] = process.argv.slice(2);
const ws = new Workspace(root);
const io: FileIO = {
  read: p => fs.readFile(p, 'utf8').catch(() => undefined),
  write: (p, t) => fs.writeFile(p, t, 'utf8'),
  remove: p => fs.rm(p),
};
const changes = new ChangeManager(io);
const index = new ContextIndex(ws);
const onToolCall = (n: string, a: unknown) => console.log(`  [tool] ${n} ${JSON.stringify(a).slice(0, 140)}`);
const mcp = new EditorMcpServer(s => {
  installContextTools(s, { index, onToolCall, onContext: r => console.log(`  [context] ${r.used}/${r.budget} tok → ${[...new Set(r.items.map(i => i.file))].join(', ')}`) });
  installReadTools(s, { ws, rgPath: 'rg', onToolCall });
  installEditTool(s, { changes, onToolCall });
  installCommandTool(s, { ws, onToolCall });
});

(async () => {
  const task = (await fs.readFile(taskFile, 'utf8')).trim();
  let message = task, extra = '';
  const m = /^inline:(.+?):(\d+)-(\d+)\n([\s\S]+)$/.exec(task);
  if (m) {
    const lines = (await fs.readFile(ws.resolve(m[1]).abs, 'utf8')).split(/\r?\n/).slice(+m[2] - 1, +m[3]).join('\n');
    message = `File: ${m[1]} (lines ${m[2]}-${m[3]}, python)\nInstruction: ${m[4].trim()}\n\nSelected code:\n\`\`\`python\n${lines}\n\`\`\``;
    extra = INLINE_INSTRUCTIONS;
  }
  await mcp.start();
  const runner = new AgentRunner({ baseUrl: 'http://localhost:8790', models: models.split(','), spec: loadAgentSpec('forge-workspace', extra) });
  await mcp.registerWithTrueForge(runner.sdk, 'forge-workspace');
  changes.beginRun('e2e');
  const t0 = Date.now();
  const r = await runner.run(message, {
    onStatus: (s, l) => console.log(`[${l}] ${s}`),
    onSession: s => console.log(`[session] http://localhost:8790/sessions/${s.sessionId} (${s.model})`),
    onApproval: async req => {
      if (req.toolName === 'run_command') { console.log(`  [approve cmd] ${JSON.stringify(req.args)}`); return { allow: true }; }
      const p = await prepareProposal(ws, changes, io, req.args);
      if (!p.ok) { console.log(`  [review] cannot show: ${p.reason}`); return { allow: false, reason: p.reason }; }
      console.log(`  [review] ${p.proposal.path}: ${p.proposal.set.hunks.length} hunk(s) → accept all`);
      changes.setAll(p.proposal.id, 'accepted');
      changes.finish(p.proposal.id, 'apply');
      return { allow: true };
    },
  });
  const files = [...new Set(changes.appliedInRun(changes.runId).map(u => u.path))];
  console.log(`\nRESULT ${r.status} on ${r.model} in ${Math.round((Date.now() - t0) / 1000)}s; files written: ${files.join(', ') || 'none'}\n${(r.output ?? r.error ?? '').slice(0, 800)}`);
  await mcp.stop();
  process.exit(r.status === 'done' ? 0 : 1);
})();
