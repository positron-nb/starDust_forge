/** Turns propose_edit arguments (from a TrueForge approval pause) into a reviewable Proposal. */
import type { Workspace } from '../mcp/workspace';
import { applyEdits } from './hunks';
import { ChangeManager, proposalKey, type FileIO, type Proposal } from './changeManager';

export async function prepareProposal(ws: Workspace, changes: ChangeManager, io: FileIO, args: unknown):
  Promise<{ ok: true; proposal: Proposal } | { ok: false; reason: string }> {
  const a = args as { path?: string; edits?: Array<{ old_string: string; new_string: string }>; description?: string };
  if (!a?.path || !Array.isArray(a.edits) || a.edits.length === 0) return { ok: false, reason: 'propose_edit needs "path" and a non-empty "edits" array.' };
  let abs: string, rel: string;
  try { ({ abs, rel } = ws.resolve(a.path)); } catch (e) { return { ok: false, reason: (e as Error).message }; }
  const original = await io.read(abs);
  const applied = applyEdits(original ?? '', a.edits);
  if (!applied.ok) return { ok: false, reason: `Edit could not be applied to ${rel}: ${applied.error}` };
  const eolText = original && /\r\n/.test(original) ? applied.text.replace(/\n/g, '\r\n') : applied.text;
  if ((original ?? '').replace(/\r\n/g, '\n') === applied.text) return { ok: false, reason: `The edit to ${rel} does not change anything.` };
  const proposal = changes.createProposal({ key: proposalKey(a.path, a.edits), path: rel, abs, original, proposed: eolText, description: a.description ?? '' });
  return { ok: true, proposal };
}
