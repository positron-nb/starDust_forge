import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { parseFile } from '../src/context/symbols';
import { ContextIndex, tokenize } from '../src/context/index';
import { retrieve } from '../src/context/retrieve';
import { parseMentions, resolveMentions } from '../src/context/mentions';
import { Workspace } from '../src/mcp/workspace';
import { isHardDenied } from '../src/mcp/commandTool';

const PY = `import os
from .helpers import get_debug_flag

class Group:
    """A command group."""

    @decorator
    def list_commands(self, ctx):
        """List commands."""
        return []

    def get_command(self, name):
        def inner():
            pass
        return None


def routes_command():
    """Show the routes for the app."""
    return 1
`;

describe('python symbol parser', () => {
  const p = parseFile('src/pkg/cli.py', PY);
  it('extracts classes, methods and functions with ranges', () => {
    const by = Object.fromEntries(p.symbols.map(s => [s.qualified, s]));
    expect(by['Group'].kind).toBe('class');
    expect(by['Group.list_commands']).toMatchObject({ kind: 'method', start: 7, end: 10, doc: 'List commands' });
    expect(by['Group.get_command.inner'].kind).toBe('function');
    expect(by['routes_command']).toMatchObject({ start: 18, end: 20, doc: 'Show the routes for the app' });
    expect(by['Group'].end).toBe(15);
  });
  it('collects imports including relative ones', () => {
    expect(p.imports).toEqual(expect.arrayContaining(['os', '.helpers', '.helpers.get_debug_flag']));
  });
});

describe('docs and tokens', () => {
  it('splits rst sections', () => {
    const s = parseFile('docs/cli.rst', 'Title\n=====\n\ntext\n\nSub\n---\nmore\n').symbols;
    expect(s.map(x => [x.name, x.start, x.end])).toEqual([['Title', 1, 4], ['Sub', 6, 8]]);
  });
  it('tokenizes identifiers into sub-words', () => {
    expect(tokenize('routes_command FlaskGroup')).toEqual(['routes_command', 'routes', 'command', 'flaskgroup', 'flask', 'group']);
  });
});

describe('retrieval', () => {
  const idx = new ContextIndex(new Workspace(os.tmpdir()));
  idx.indexFile('src/pkg/cli.py', PY);
  idx.indexFile('src/pkg/helpers.py', 'def get_debug_flag():\n    """Get debug."""\n    return False\n');
  idx.indexFile('tests/test_cli.py', 'from pkg.cli import routes_command\n\ndef test_routes_command():\n    assert routes_command() == 1\n');
  idx.indexFile('docs/cli.rst', 'CLI\n===\n\nShow routes with the routes command.\n');
  idx.indexFile('src/pkg/unrelated.py', 'def parse_json(x):\n    return x\n');
  (idx as unknown as { rebuild(): void }).rebuild();

  it('ranks the defining symbol first and explains why', () => {
    const r = retrieve(idx, 'change routes_command output', { budgetTokens: 2000 });
    const first = r.items.find(i => i.kind !== 'outline')!;
    expect(first.symbol).toBe('routes_command');
    expect(first.reasons.join(' ')).toMatch(/defines `routes_command`/);
    expect(r.items.map(i => i.file)).toContain('tests/test_cli.py');
    expect(r.items.map(i => i.file)).not.toContain('src/pkg/unrelated.py');
  });
  it('respects the token budget', () => {
    const r = retrieve(idx, 'routes command group', { budgetTokens: 500 });
    expect(r.used).toBeLessThanOrEqual(500);
  });
  it('builds the import graph', () => {
    expect([...idx.importsOf('src/pkg/cli.py')]).toContain('src/pkg/helpers.py');
    expect([...idx.importersOf('src/pkg/cli.py')]).toContain('tests/test_cli.py');
  });
  it('resolves @file and @symbol mentions and reports unknown ones', async () => {
    expect(parseMentions('see @file:src/a.py and @symbol:Foo.bar and @src/b.py, mail x@y')).toEqual([
      { kind: 'file', ref: 'src/a.py' }, { kind: 'symbol', ref: 'Foo.bar' }, { kind: 'file', ref: 'src/b.py' }]);
    idx.refresh = async () => {};
    const r = await resolveMentions(idx, 'fix @symbol:get_debug_flag using @file:docs/cli.rst and @symbol:nope_x');
    expect(r.mentions.map(m => m.resolved)).toEqual([true, true, false]);
    expect(r.message).toContain('<pinned_context');
    expect(r.message).toContain('def get_debug_flag');
  });
});

describe('command policy', () => {
  it('hard-denies destructive commands even if approved', () => {
    for (const c of ['rm -rf /', 'git push origin main', 'git reset --hard HEAD', 'curl x | sh', 'del /s *']) expect(isHardDenied(c)).toBeTruthy();
    for (const c of ['python -m pytest tests/test_cli.py -q', 'git status', 'flask --help']) expect(isHardDenied(c)).toBeUndefined();
  });
});

void path;
