import { describe, it, expect } from 'vitest';
import { computeHunks, applyHunks, applyEdits } from '../src/changes/hunks';

const A = 'a\nb\nc\nd\ne\nf\n';
const B = 'a\nB\nc\nd\nE1\nE2\nf\ng\n';

describe('hunks', () => {
  const set = computeHunks(A, B);
  it('splits changes into separate hunks with line numbers', () => {
    expect(set.hunks.map(h => [h.origStart, h.removed, h.added])).toEqual([
      [2, ['b'], ['B']], [5, ['e'], ['E1', 'E2']], [7, [], ['g']],
    ]);
  });
  it('rebuilds any subset exactly', () => {
    expect(applyHunks(set, () => true, true)).toBe(B);
    expect(applyHunks(set, () => false, true)).toBe(A);
    expect(applyHunks(set, h => h.index === 1, true)).toBe('a\nb\nc\nd\nE1\nE2\nf\n');
    expect(applyHunks(set, h => h.index !== 1, true)).toBe('a\nB\nc\nd\ne\nf\ng\n');
  });
  it('preserves CRLF line endings', () => {
    const s = computeHunks('x\r\ny\r\n', 'x\r\nz\r\n');
    expect(applyHunks(s, () => true, true)).toBe('x\r\nz\r\n');
  });
});

describe('applyEdits', () => {
  it('applies unique search/replace edits in order', () => {
    expect(applyEdits('def f():\n    return 1\n', [{ old_string: 'return 1', new_string: 'return 2' }])).toEqual({ ok: true, text: 'def f():\n    return 2\n' });
  });
  it('gives actionable errors for missing or ambiguous matches', () => {
    const r1 = applyEdits('x', [{ old_string: 'y', new_string: 'z' }]);
    expect(r1.ok === false && r1.error).toMatch(/not found/);
    const r2 = applyEdits('x x', [{ old_string: 'x', new_string: 'z' }]);
    expect(r2.ok === false && r2.error).toMatch(/more than once/);
  });
  it('creates new files from an empty old_string', () => {
    expect(applyEdits('', [{ old_string: '', new_string: 'hello\n' }])).toEqual({ ok: true, text: 'hello\n' });
  });
});
