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
    old_string: z.string().describe('Exact current text to replace (copy it from read_file without line-number prefixes; include enough lines to be unique). Empty string only when creating a new file.'),
    new_string: z.string().describe('Replacement text'),
  })).min(1),
  description: z.string().default('').describe('One line: what this change does and why'),
};

export function installEditTool(server: McpServer, d: { changes: ChangeManager; onToolCall?: (n: string, a: unknown) => void }): void {
  server.registerTool('propose_edit', {
    title: 'Propose file edit',
    description: 'Propose changes to ONE file as exact search/replace edits. The user reviews the diff hunk by hunk and the change is applied ' +
      'only if (and only as far as) they accept it; the result tells you what was applied or rejected. Group all edits for a file into one call. ' +
      'For a new file use a single edit with old_string "" and the full content as new_string.',
    inputSchema: proposeEditSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ path, edits }) => {
    d.onToolCall?.('propose_edit', { path, edits: edits.length });
    const r = await d.changes.applyApproved(proposalKey(path, edits));
    return { content: [{ type: 'text' as const, text: r.message }], isError: !r.ok };
  });
}
