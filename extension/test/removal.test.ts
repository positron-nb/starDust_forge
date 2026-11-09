import { describe, it, expect } from 'vitest';
import { removedDefinitions, pythonSyntaxError } from '../src/changes/prepare';

const BEFORE = 'def a():\n    return 1\n\n\ndef test_old():\n    assert a() == 1\n';

describe('removed-definition guard', () => {
  it('flags a definition replaced by a different one', () => {
    const after = 'def a():\n    return 1\n\n\ndef test_new():\n    assert True\n';
    expect(removedDefinitions('tests/t.py', BEFORE, after)).toEqual(['test_old']);
  });
  it('allows pure additions and body edits', () => {
    const after = BEFORE.replace('return 1', 'return 2') + '\n\ndef test_new():\n    assert True\n';
    expect(removedDefinitions('tests/t.py', BEFORE, after)).toEqual([]);
  });
  it('flags a removed module-level assignment', () => {
    const before = 'import x\n\ncli = Group(\n    name="flask",\n)\n\n\ndef main():\n    cli()\n';
    const after = 'import x\n\n\ndef main():\n    cli()\n';
    expect(removedDefinitions('src/cli.py', before, after)).toEqual(['cli']);
  });
  it('reports Python syntax errors with a line number', () => {
    expect(pythonSyntaxError('.', 'def f():\n    return 1\n    return 2"\n')).toMatch(/^line 3:/);
    expect(pythonSyntaxError('.', 'def f():\n    return 1\n')).toBeUndefined();
  });
  it('ignores docs files', () => {
    expect(removedDefinitions('docs/cli.rst', 'Title\n=====\n', '')).toEqual([]);
  });
});

describe('removal guard baseline', () => {
  it('lets the agent rework a definition it added earlier in the same run', async () => {
    const { ChangeManager } = await import('../src/changes/changeManager');
    const { prepareProposal } = await import('../src/changes/prepare');
    const files = new Map<string, string>([['/w/a.py', 'def keep():\n    return 1\n']]);
    const io = { read: async (p: string) => files.get(p), write: async (p: string, t: string) => { files.set(p, t); } };
    const ws = { root: '.', resolve: (p: string) => ({ abs: '/w/' + p, rel: p }) } as never;
    const cm = new ChangeManager(io as never);
    cm.beginRun('t');
    const add = await prepareProposal(ws, cm, io as never, { path: 'a.py', edits: [{ start_line: 3, end_line: 2, new_string: '\n\ndef mine():\n    return 2' }] });
    expect(add.ok).toBe(true);
    if (add.ok) { cm.setAll(add.proposal.id, 'accepted'); cm.finish(add.proposal.id, 'apply'); await cm.applyApproved(add.proposal.key); }
    const rework = await prepareProposal(ws, cm, io as never, { path: 'a.py', edits: [{ old_string: 'def mine():\n    return 2', new_string: 'def mine2():\n    return 3' }] });
    expect(rework.ok).toBe(true);
    const bad = await prepareProposal(ws, cm, io as never, { path: 'a.py', edits: [{ old_string: 'def keep():\n    return 1', new_string: 'def other():\n    return 1' }] });
    expect(bad.ok === false && bad.reason).toMatch(/delete existing definition\(s\) keep/);
  });
});

describe('existing tests are protected', () => {
  it('refuses rewriting a pre-existing test but allows adding new ones', async () => {
    const { modifiedExistingTests } = await import('../src/changes/prepare');
    const base = '@pytest.mark.parametrize("v", [1])\ndef test_old(v):\n    assert v\n';
    const changed = '@pytest.mark.parametrize("v", [1])\n\ndef test_old(v, monkeypatch):\n    assert v\n';
    const added = base + '\n\ndef test_new():\n    assert True\n';
    expect(modifiedExistingTests('tests/test_x.py', base, base, changed)).toEqual(['test_old']);
    expect(modifiedExistingTests('tests/test_x.py', base, base, added)).toEqual([]);
    expect(modifiedExistingTests('src/x.py', base, base, changed)).toEqual([]);
  });
  it('lets the agent rework a test it added in this run', async () => {
    const { modifiedExistingTests } = await import('../src/changes/prepare');
    const base = 'def test_old():\n    assert 1\n';
    const mid = base + '\n\ndef test_new():\n    assert 0\n';
    expect(modifiedExistingTests('tests/test_x.py', base, mid, mid.replace('assert 0', 'assert 1'))).toEqual([]);
  });
});
