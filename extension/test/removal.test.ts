import { describe, it, expect } from 'vitest';
import { removedDefinitions } from '../src/changes/prepare';

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
  it('ignores docs files', () => {
    expect(removedDefinitions('docs/cli.rst', 'Title\n=====\n', '')).toEqual([]);
  });
});
