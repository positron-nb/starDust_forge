import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/mcp/workspace';
import { retryDelayMs, providerWaitHintMs } from '../src/trueforge/agentRunner';
import { toCamel, loadAgentSpec } from '../src/trueforge/agentSpec';

describe('Workspace path guard', () => {
  const ws = new Workspace(path.join(os.tmpdir(), 'forge-ws'));
  it('resolves relative paths inside the root', () => {
    expect(ws.resolve('src/a.py').rel).toBe('src/a.py');
    expect(ws.resolve('/src/a.py').rel).toBe('src/a.py');
  });
  it('rejects traversal outside the workspace', () => {
    expect(() => ws.resolve('../etc/passwd')).toThrow(/outside the workspace/);
    expect(() => ws.resolve('src/../../x')).toThrow(/outside the workspace/);
  });
  it('denies sensitive files', () => {
    for (const p of ['.git/config', '.env', '.env.local', 'certs/server.pem', 'home/id_rsa']) {
      expect(() => ws.resolve(p)).toThrow(/denied/);
    }
  });
});

describe('retryDelayMs', () => {
  it('parses Groq-style "try again in" hints', () => {
    expect(providerWaitHintMs('TPM: Limit 8000, Used 6226. Please try again in 13.815s. Need more')).toBe(14315);
    expect(providerWaitHintMs('Please try again in 1m2.5s')).toBe(63000);
    expect(providerWaitHintMs('retry in 300s')).toBeUndefined();
  });
  it('honours provider retry hints', () => expect(retryDelayMs('Please retry in 34.4s.', 0)).toBe(34900));
  it('does not wait out very long hints (daily quota): short backoff, then fallback', () => expect(retryDelayMs('retry in 500s', 0)).toBe(2000));
  it('falls back to exponential backoff', () => {
    expect(retryDelayMs('503 overloaded', 0)).toBe(2000);
    expect(retryDelayMs('503 overloaded', 2)).toBe(8000);
  });
});

describe('agent spec', () => {
  it('converts keys to camelCase but keeps tool-name values', () => {
    expect(toCamel({ require_approval_for_tools: ['propose_edit'] })).toEqual({ requireApprovalForTools: ['propose_edit'] });
  });
  it('gates writes behind TrueForge approval and disables the sandbox', () => {
    const s = loadAgentSpec('x');
    expect(s.mcpServers[0].name).toBe('x');
    expect(s.mcpServers[0].requireApprovalForTools).toContain('propose_edit');
    expect((s.config as { sandbox: { enabled: boolean } }).sandbox.enabled).toBe(false);
  });
});

import { summarizeError, unwrapDeferred } from '../src/trueforge/agentRunner';
describe('error summaries and deferred tools', () => {
  it('summarizes provider errors to one line', () => {
    expect(summarizeError('[Model Error] Request failed (429): quota ... Please retry in 35.7s.')).toMatch(/^Rate limit.*wait 36s/);
    expect(summarizeError('[Model Error] Cannot connect to API: bad port')).toBe('Model endpoint unreachable (connection failed).');
    expect(summarizeError('401 invalid api key')).toMatch(/rejected the API key/);
  });
  it('unwraps call_tool so approvals see the real tool', () => {
    expect(unwrapDeferred('call_tool', 'deferred', { mcp_server: 'forge-workspace', tool_name: 'propose_edit', input: { path: 'a' } }))
      .toEqual({ name: 'propose_edit', server: 'forge-workspace', args: { path: 'a' }, deferred: true });
    expect(unwrapDeferred('read_file', 'x', {}).deferred).toBe(false);
  });
});

describe('default auto-approve command patterns (package.json)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const defaults: string[] = require('../package.json').contributes.configuration.properties['forge.autoApproveCommands'].default;
  const ok = (c: string) => defaults.some(r => new RegExp(r).test(c));
  it('allows read-only checks and tests', () => {
    for (const c of ['python -m pytest tests/test_cli.py -q', 'pytest tests', 'git status --short', 'git diff --check', 'python -m flask --help', 'flask --app x config']) expect(ok(c), c).toBe(true);
  });
  it('does not allow anything else', () => {
    for (const c of ['rm -rf x', 'git push', 'git checkout -- .', 'pytestx', 'python -c "print(1)"', 'pip install x']) expect(ok(c), c).toBe(false);
  });
});

describe('loop detector', () => {
  it('fires after 3 identical failing calls, not for different calls or successes', async () => {
    const { LoopDetector } = await import('../src/trueforge/agentRunner');
    const d = new LoopDetector(3);
    const err = '{"error":[{"type":"text","text":"Tool \'list_tools\' is not allowed on MCP server forge-workspace"}]}';
    d.call('a', 'call_tool', '{"tool_name":"list_tools"}'); expect(d.result('a', err)).toBeUndefined();
    d.call('b', 'call_tool', '{"tool_name":"list_tools"}'); expect(d.result('b', err)).toBeUndefined();
    d.call('c', 'call_tool', '{"tool_name":"list_tools"}'); expect(d.result('c', err)).toMatch(/Loop detected.*3 times/);
    d.call('d', 'read_file', '{"path":"a"}'); expect(d.result('d', 'a.py lines 1-3 of 3')).toBeUndefined();
    d.call('e', 'call_tool', '{"x":1}'); expect(d.result('e', err)).toBeUndefined();
    d.call('f', 'call_tool', '{"x":2}'); expect(d.result('f', err)).toBeUndefined();
  });
});
