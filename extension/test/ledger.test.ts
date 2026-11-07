import { describe, it, expect } from 'vitest';
import { TaskLedger } from '../src/agent/ledger';
import { loadAgentSpec } from '../src/trueforge/agentSpec';

describe('task ledger', () => {
  it('detects re-reads of unchanged ranges, forgets them after an edit', () => {
    const l = new TaskLedger();
    l.reset('do X');
    const f = 'a\nb\nc\nd\n';
    expect(l.recordRead('x.py', f, 1, 4)).toBe(false);
    expect(l.recordRead('x.py', f, 2, 3)).toBe(true);  // inside an already-read range
    expect(l.recordRead('x.py', f + 'e\n', 2, 3)).toBe(false); // content changed → new revision
    l.recordEdit('x.py', 'added e');
    expect(l.recordRead('x.py', f, 1, 4)).toBe(false);
    expect(l.duplicateReads).toBe(1);
  });
  it('renders the original task, ranges, edits and last test', () => {
    const l = new TaskLedger();
    l.reset('Add a config command');
    l.recordRead('src/m.py', 'x\n'.repeat(50), 1, 20);
    l.recordRead('src/m.py', 'x\n'.repeat(50), 15, 40);
    l.recordEdit('src/m.py', 'add command');
    l.recordCommand('python -m pytest tests/t.py -q', 0, '....\n59 passed in 0.3s\n');
    l.plan = 'edit m.py, add test, add docs';
    const r = l.render();
    expect(r).toContain('ORIGINAL TASK:\nAdd a config command');
    expect(r).toContain('1. src/m.py: add command');
    expect(r).toContain('59 passed');
    expect(r).toContain('PLAN: edit m.py, add test, add docs');
  });
  it('merges overlapping ranges in the rendering', () => {
    const l = new TaskLedger();
    l.recordRead('a.py', 'x\n'.repeat(100), 1, 20);
    l.recordRead('a.py', 'x\n'.repeat(100), 15, 40);
    l.recordRead('a.py', 'x\n'.repeat(100), 60, 70);
    expect(l.render()).toContain('a.py (101 lines, rev');
    expect(l.render()).toMatch(/: 1-40, 60-70/);
  });
});

describe('compaction modes in the spec sent to TrueForge', () => {
  const cm = (n?: number) => (loadAgentSpec('w', '', { compactAt: n }).config as Record<string, any>).contextManagement.compaction;
  it('explicit trigger', () => expect(cm(100000)).toEqual({ enabled: true, trigger: { type: 'input_tokens', value: 100000 } }));
  it('disabled', () => expect(cm(-1)).toEqual({ enabled: false }));
  it('default leaves TrueForge default', () => expect(cm(0)).toEqual({ enabled: true }));
});
