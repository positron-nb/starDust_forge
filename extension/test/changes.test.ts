import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { ChangeManager, proposalKey, type FileIO } from '../src/changes/changeManager';
import { prepareProposal } from '../src/changes/prepare';
import { Workspace } from '../src/mcp/workspace';

class MemIO implements FileIO {
  files = new Map<string, string>();
  writes = 0;
  async read(abs: string) { return this.files.get(abs); }
  async write(abs: string, t: string) { this.writes++; this.files.set(abs, t); }
  async remove(abs: string) { this.files.delete(abs); }
}

const ws = new Workspace(path.join(os.tmpdir(), 'forge-cm'));
const abs = (p: string) => ws.resolve(p).abs;
const SRC = 'line1\nold A\nline3\nline4\nold B\nline6\n';
const EDITS = [{ old_string: 'old A', new_string: 'new A' }, { old_string: 'old B', new_string: 'new B' }];

describe('ChangeManager safety', () => {
  let io: MemIO, cm: ChangeManager;
  beforeEach(() => { io = new MemIO(); io.files.set(abs('a.py'), SRC); cm = new ChangeManager(io); cm.beginRun('t'); });

  it('writes only accepted hunks, and only after approval', async () => {
    const r = await prepareProposal(ws, cm, io, { path: 'a.py', edits: EDITS });
    if (!r.ok) throw new Error(r.reason);
    expect(r.proposal.set.hunks).toHaveLength(2);
    expect(io.writes).toBe(0); // reviewing: nothing on disk
    cm.setHunk(r.proposal.id, 0, 'accepted');
    cm.setHunk(r.proposal.id, 1, 'rejected');
    cm.finish(r.proposal.id, 'apply');
    expect(io.writes).toBe(0); // approved, but not executed yet
    const res = await cm.applyApproved(proposalKey('a.py', EDITS));
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/REJECTED 1/);
    expect(io.files.get(abs('a.py'))).toBe('line1\nnew A\nline3\nline4\nold B\nline6\n');
  });

  it('refuses unreviewed or rejected edits (no silent writes)', async () => {
    expect((await cm.applyApproved(proposalKey('a.py', EDITS))).ok).toBe(false);
    const r = await prepareProposal(ws, cm, io, { path: 'a.py', edits: EDITS });
    if (!r.ok) throw new Error();
    cm.setAll(r.proposal.id, 'rejected');
    cm.finish(r.proposal.id, 'apply');
    expect((await cm.applyApproved(r.proposal.key)).ok).toBe(false);
    expect(io.writes).toBe(0);
  });

  it('cancellation drops approved-but-unexecuted edits', async () => {
    const r = await prepareProposal(ws, cm, io, { path: 'a.py', edits: EDITS });
    if (!r.ok) throw new Error();
    cm.setAll(r.proposal.id, 'accepted');
    cm.finish(r.proposal.id, 'apply');
    cm.cancelAll();
    expect((await cm.applyApproved(r.proposal.key)).ok).toBe(false);
    expect(io.files.get(abs('a.py'))).toBe(SRC);
  });

  it('refuses to write if the file changed after review', async () => {
    const r = await prepareProposal(ws, cm, io, { path: 'a.py', edits: EDITS });
    if (!r.ok) throw new Error();
    cm.setAll(r.proposal.id, 'accepted'); cm.finish(r.proposal.id, 'apply');
    io.files.set(abs('a.py'), SRC + 'user typed\n');
    const res = await cm.applyApproved(r.proposal.key);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/changed on disk/);
  });

  it('undoes a whole run, including created files', async () => {
    const r1 = await prepareProposal(ws, cm, io, { path: 'a.py', edits: EDITS });
    const r2 = await prepareProposal(ws, cm, io, { path: 'new.py', edits: [{ old_string: '', new_string: 'x = 1\n' }] });
    if (!r1.ok || !r2.ok) throw new Error();
    for (const p of [r1.proposal, r2.proposal]) { cm.setAll(p.id, 'accepted'); cm.finish(p.id, 'apply'); await cm.applyApproved(p.key); }
    expect(io.files.get(abs('new.py'))).toBe('x = 1\n');
    const u = await cm.undo('run');
    expect(u.undone.sort()).toEqual(['a.py', 'new.py']);
    expect(io.files.get(abs('a.py'))).toBe(SRC);
    expect(io.files.has(abs('new.py'))).toBe(false);
  });

  it('key ignores property order in edits', () => {
    expect(proposalKey('a.py', [{ old_string: 'x', new_string: 'y' }])).toBe(proposalKey('./a.py', [{ new_string: 'y', old_string: 'x' }]));
  });

  it('reports bad edits back to the model', async () => {
    const r = await prepareProposal(ws, cm, io, { path: 'a.py', edits: [{ old_string: 'nope', new_string: 'x' }] });
    expect(r.ok === false && r.reason).toMatch(/not found/);
  });
});
