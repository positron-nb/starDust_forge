/** task_state: returns (and optionally updates) the extension-held task ledger, which survives context compaction. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TaskLedger } from '../agent/ledger';

export function installStateTool(server: McpServer, d: { ledger: TaskLedger; onToolCall?: (n: string, a: unknown) => void }): void {
  server.registerTool('task_state', {
    title: 'Task state',
    description: 'Your working memory, kept outside the conversation so it survives context summaries: the original task, files and line ranges you already read (still current unless edited), files/symbols found, edits applied or refused, the last test result, and your plan/next step. ' +
      'Call it once after a context summary instead of re-reading files. Optionally record your plan and next step.',
    inputSchema: {
      plan: z.string().max(1500).optional().describe('Your multi-file plan (which files, what changes) — saved for later'),
      next: z.string().max(400).optional().describe('The next concrete step — saved for later'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ plan, next }) => {
    d.onToolCall?.('task_state', { plan: !!plan, next: !!next });
    if (plan) d.ledger.plan = plan;
    if (next) d.ledger.next = next;
    return { content: [{ type: 'text' as const, text: d.ledger.render() }] };
  });
}
