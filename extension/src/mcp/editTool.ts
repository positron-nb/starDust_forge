/**
 * propose_edit — the agent's ONLY way to change files. Declared as a write tool and
 * listed in require_approval_for_tools, so TrueForge pauses before running it; the
 * extension shows the hunk review during that pause. When TrueForge finally executes
 * the call, this handler writes only what the user accepted (via ChangeManager).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ChangeManager } from '../changes/changeManager';
import { proposalKey } from '../changes/changeManager';

export const proposeEditSchema = {
  path: z.string().describe('Workspace-relative file path (new files are allowed)'),
  edits: z.array(z.object({
    old_string: z.string().optional().describe('Exact current text to replace (copy from read_file WITHOUT the "  123| " prefixes; include enough lines to be unique). Empty string only when creating a new file.'),
    new_string: z.string().describe('Replacement text'),
    start_line: z.number().int().min(1).optional().describe('Alternative to old_string: first line to replace (1-based, as shown by read_file)'),
    end_line: z.number().int().min(0).optional().describe('Last line to replace (inclusive). Use end_line = start_line - 1 to insert before start_line.'),
  })).min(1),
  confirm_removal: z.array(z.string()).optional().describe('Names of existing functions/classes this edit deletes. Only when the user explicitly asked for the removal; otherwise edits that delete existing definitions are refused.'),
  description: z.string().default('').describe('One line: what this change does and why'),
};

export function installEditTool(server: McpServer, d: { changes: ChangeManager; onToolCall?: (n: string, a: unknown) => void; ledger?: import('../agent/ledger').TaskLedger }): void {
  server.registerTool('propose_edit', {
    title: 'Propose file edit',
    description: 'Propose changes to ONE file, as search/replace edits (old_string → new_string) or line-range edits (start_line/end_line → new_string). The user reviews the diff hunk by hunk and the change is applied ' +
      'only if (and only as far as) they accept it; the result tells you what was applied or rejected. Group all edits for a file into one call. ' +
      'For a new file use a single edit with old_string "" and the full content as new_string.',
    inputSchema: proposeEditSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ path, edits, description }) => {
    d.onToolCall?.('propose_edit', { path, edits: edits.length });
    const r = await d.changes.applyApproved(proposalKey(path, edits));
    if (r.ok) d.ledger?.recordEdit(path, `${description || 'edit'} (${r.message.split('.')[0]})`);
    else d.ledger?.recordRejected(path, r.message);
    return { content: [{ type: 'text' as const, text: r.message }], isError: !r.ok };
  });
}
