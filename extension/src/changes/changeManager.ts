/**
 * ChangeManager — the only component allowed to write workspace files.
 *
 * Lifecycle of an agent edit:
 *   propose_edit tool call → TrueForge pauses (tool.approval_required)
 *   → createProposal() + hunk review in the editor
 *   → approve(): the accepted-hunk text is stored under the call's key → TrueForge "allow"
 *   → TrueForge executes propose_edit → applyApproved(): verifies the file is unchanged
 *     since review, writes ONLY the accepted hunks, records an undo entry.
 * A propose_edit execution with no matching approval writes nothing. cancelAll() drops
 * every approval that has not been executed yet, so a cancelled run cannot half-apply.
 */
import crypto from 'node:crypto';
import { computeHunks, applyHunks, summarize, type HunkSet, type Hunk } from './hunks';

export interface FileIO {
  /** Current text of the file, or undefined if it does not exist. */
  read(abs: string): Promise<string | undefined>;
  /** Write full text (create when missing). Must go through the editor so it is undoable. */
  write(abs: string, text: string): Promise<void>;
  /** Delete a file that the agent created (undo of a creation). */
  remove(abs: string): Promise<void>;
}

export type ProposalStatus = 'reviewing' | 'approved' | 'rejected' | 'applied' | 'cancelled' | 'stale';

export interface Proposal {
  id: string;
  key: string;
  runId: string;
  path: string;          // workspace-relative
  abs: string;
  isNew: boolean;
  original: string;
  proposed: string;
  description: string;
  set: HunkSet;
  status: ProposalStatus;
  finalText?: string;
}

export interface UndoEntry { runId: string; path: string; abs: string; before: string | undefined; after: string; at: number }

/** Stable identity of a propose_edit call (same at approval time and at execution time). */
export function proposalKey(path: string, edits: unknown): string {
  const norm = Array.isArray(edits) ? edits.map(e => { const x = e as { old_string?: unknown; new_string?: unknown; start_line?: unknown; end_line?: unknown };
    return [String(x.old_string ?? ''), String(x.new_string ?? ''), x.start_line ?? null, x.end_line ?? null]; }) : edits;
  return crypto.createHash('sha256').update(JSON.stringify([path.replace(/\\/g, '/').replace(/^\.?\//, ''), norm])).digest('hex').slice(0, 24);
}

export class ChangeManager {
  private proposals = new Map<string, Proposal>();
  private approved = new Map<string, Proposal>();
  private undoStack: UndoEntry[] = [];
  private seq = 0;
  runId = 'run-0';
  listeners = new Set<(p: Proposal) => void>();

  constructor(private readonly io: FileIO) {}

  beginRun(label: string): string { this.runId = `${label}-${++this.seq}`; return this.runId; }

  createProposal(a: { key: string; path: string; abs: string; original: string | undefined; proposed: string; description: string }): Proposal {
    const original = a.original ?? '';
    const p: Proposal = { id: `p${++this.seq}`, key: a.key, runId: this.runId, path: a.path, abs: a.abs, isNew: a.original === undefined,
      original, proposed: a.proposed, description: a.description, set: computeHunks(original, a.proposed), status: 'reviewing' };
    this.proposals.set(p.id, p);
    return p;
  }

  get(id: string): Proposal | undefined { return this.proposals.get(id); }

  setHunk(id: string, index: number, state: Hunk['state']): void {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'reviewing' || !p.set.hunks[index]) return;
    p.set.hunks[index].state = state;
    this.emit(p);
  }
  setAll(id: string, state: Hunk['state']): void {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'reviewing') return;
    for (const h of p.set.hunks) h.state = state;
    this.emit(p);
  }

  /** Finish review. Returns counts; pending hunks are treated as rejected. */
  finish(id: string, outcome: 'apply' | 'cancel'): { accepted: number; rejected: number; total: number } {
    const p = this.proposals.get(id)!;
    for (const h of p.set.hunks) if (h.state === 'pending') h.state = 'rejected';
    const s = summarize(p.set);
    if (outcome === 'cancel') p.status = 'cancelled';
    else if (s.accepted === 0) p.status = 'rejected';
    else {
      p.status = 'approved';
      p.finalText = applyHunks(p.set, h => h.state === 'accepted', p.original === '' ? p.proposed.endsWith('\n') : /\r?\n$/.test(p.original));
      this.approved.set(p.key, p);
    }
    this.emit(p);
    return { accepted: s.accepted, rejected: s.rejected, total: s.total };
  }

  /** Called by the propose_edit tool when TrueForge executes the approved call. */
  async applyApproved(key: string): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    const p = this.approved.get(key);
    if (!p) return { ok: false, message: 'This edit was not approved in diff review (rejected, cancelled or never reviewed). Nothing was written.' };
    this.approved.delete(key);
    const current = await this.io.read(p.abs);
    if ((current ?? '') !== p.original || (current === undefined) !== p.isNew) {
      p.status = 'stale'; this.emit(p);
      return { ok: false, message: `${p.path} changed on disk after it was reviewed; nothing was written. Re-read the file and propose the edit again.` };
    }
    await this.io.write(p.abs, p.finalText!);
    this.undoStack.push({ runId: p.runId, path: p.path, abs: p.abs, before: current, after: p.finalText!, at: Date.now() });
    p.status = 'applied'; this.emit(p);
    const rejected = p.set.hunks.filter(h => h.state === 'rejected');
    const s = summarize(p.set);
    return { ok: true, message: `Applied ${s.accepted} of ${s.total} hunk(s) to ${p.path}.` + (rejected.length
      ? ` The user REJECTED ${rejected.length} hunk(s); they are NOT in the file: ` + rejected.map(h => `hunk at original line ${h.origStart} (-${h.removed.length}/+${h.added.length} lines)`).join(', ') + '. Do not re-propose them unless the user asks.'
      : '') };
  }

  /** Drop all approvals not yet executed (cancellation). */
  cancelAll(): number {
    const n = this.approved.size;
    for (const p of this.approved.values()) { p.status = 'cancelled'; this.emit(p); }
    this.approved.clear();
    for (const p of this.proposals.values()) if (p.status === 'reviewing') { p.status = 'cancelled'; this.emit(p); }
    return n;
  }

  appliedInRun(runId: string): UndoEntry[] { return this.undoStack.filter(u => u.runId === runId); }
  get lastRunWithChanges(): string | undefined { return this.undoStack[this.undoStack.length - 1]?.runId; }
  get undoDepth(): number { return this.undoStack.length; }

  /** Undo the most recent applied change, or every change of one run (newest first). */
  async undo(scope: 'last' | 'run'): Promise<{ undone: string[]; skipped: string[] }> {
    const last = this.undoStack[this.undoStack.length - 1];
    if (!last) return { undone: [], skipped: [] };
    const entries = scope === 'last' ? [last] : this.undoStack.filter(u => u.runId === last.runId);
    const undone: string[] = [], skipped: string[] = [];
    for (const u of [...entries].reverse()) {
      const cur = await this.io.read(u.abs);
      if (cur !== u.after) { skipped.push(`${u.path} (modified since the agent's change)`); continue; }
      if (u.before === undefined) await this.io.remove(u.abs); else await this.io.write(u.abs, u.before);
      this.undoStack.splice(this.undoStack.indexOf(u), 1);
      undone.push(u.path);
    }
    return { undone, skipped };
  }

  private emit(p: Proposal): void { for (const l of this.listeners) l(p); }
}
