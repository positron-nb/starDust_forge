import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/mcp/workspace';
import { retryDelayMs } from '../src/trueforge/agentRunner';
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
  it('honours provider retry hints', () => expect(retryDelayMs('Please retry in 34.4s.', 0)).toBe(34900));
  it('caps long hints', () => expect(retryDelayMs('retry in 500s', 0)).toBe(65000));
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
