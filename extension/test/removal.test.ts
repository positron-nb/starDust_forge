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
