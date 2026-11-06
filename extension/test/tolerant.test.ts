import { describe, it, expect } from 'vitest';
import { applyEdits } from '../src/changes/hunks';

describe('tolerant edits (weak-model friendly)', () => {
  const F = 'def f():\n    x = 1\n    return x\n\ncli = Group()\n';
  it('strips read_file line-number prefixes', () => {
    const r = applyEdits(F, [{ old_string: '    2|     x = 1', new_string: '    2|     x = 2' }]);
    expect(r).toEqual({ ok: true, text: F.replace('x = 1', 'x = 2') });
  });
  it('tolerates trailing whitespace and re-indents on indentation mismatch', () => {
    expect(applyEdits(F, [{ old_string: 'x = 1   \nreturn x', new_string: 'x = 3\nreturn x' }]))
      .toEqual({ ok: true, text: 'def f():\n    x = 3\n    return x\n\ncli = Group()\n' });
  });
  it('applies line-range edits bottom-up on original numbering', () => {
    const r = applyEdits(F, [{ start_line: 2, end_line: 2, new_string: '    x = 5' }, { start_line: 5, end_line: 4, new_string: '# inserted' }]);
    expect(r).toEqual({ ok: true, text: 'def f():\n    x = 5\n    return x\n\n# inserted\ncli = Group()\n' });
  });
  it('hints where the first line was found when the rest differs', () => {
    const r = applyEdits(F, [{ old_string: 'cli = Group()\nmore', new_string: '' }]);
    expect(r.ok === false && r.error).toMatch(/line\(s\) 5/);
  });
  it('rejects out-of-range line edits', () => {
    const r = applyEdits(F, [{ start_line: 99, end_line: 99, new_string: 'x' }]);
    expect(r.ok === false && r.error).toMatch(/outside the file/);
  });
  it('still refuses ambiguous matches', () => {
    const r = applyEdits('a\n  b\nc\n  b\n', [{ old_string: 'b', new_string: 'z' }]);
    expect(r.ok === false && r.error).toMatch(/more than once|matches 2/);
  });
});
