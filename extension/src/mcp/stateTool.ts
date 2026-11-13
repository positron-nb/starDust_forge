/** task_state: returns (and optionally updates) the extension-held task ledger, which survives context compaction and model fallback. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TaskLedger } from '../agent/ledger';

export function installStateTool(server: McpServer, d: { ledger: TaskLedger; onToolCall?: (n: string, a: unknown) => void }): void {
  server.registerTool('task_state', {
    title: 'Task state',
    description: 'Your working memory, kept outside the conversation so it survives context summaries: the original task, files and line ranges you already read (still current unless edited), files/symbols found, edits applied or refused, the last test result, and your plan/next step. ' +
      'After discovery, record your plan here WITH planned_files (every file you will change: code, tests, docs). The editor uses that list: commands are refused while planned files are still unedited, and the task is not accepted as finished until each planned file has an applied edit and the tests ran after the last edit. ' +
      'Call it once after a context summary instead of re-reading files.',
    inputSchema: {
      plan: z.string().max(1500).optional().describe('Your multi-file plan (which files, what changes) — saved for later'),
      planned_files: z.array(z.string()).max(12).optional().describe('Workspace-relative paths of ALL files you will change (code, tests, docs). Replaces the previous list.'),
      next: z.string().max(400).optional().describe('The next concrete step — saved for later'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ plan, planned_files, next }) => {
    d.onToolCall?.('task_state', { plan: !!plan, planned_files, next: !!next });
    if (plan) d.ledger.plan = plan;
    if (planned_files) d.ledger.setPlannedFiles(planned_files);
    if (next) d.ledger.next = next;
    return { content: [{ type: 'text' as const, text: d.ledger.render() }] };
  });
}
