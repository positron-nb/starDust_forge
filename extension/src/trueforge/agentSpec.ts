/**
 * Loads agent/forge-coder.json (the agent definition shipped in the repo, written in
 * the HTTP API's snake_case) and converts it to the SDK's camelCase AgentSpec.
 */
import agentDef from '../../../agent/forge-coder.json';
import type { AgentSpec } from './agentRunner';

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Deep-converts object keys only; array items and string values (tool names) stay as-is. */
export function toCamel(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(toCamel);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), toCamel(x)]));
  return v;
}

export function loadAgentSpec(mcpServerName: string, extraInstructions = ''): AgentSpec {
  const m = toCamel(agentDef.manifest) as { instructions: string; mcpServers: Array<Record<string, unknown>>; config: Record<string, unknown> };
  return {
    instructions: m.instructions + (extraInstructions ? `\n\n${extraInstructions}` : ''),
    mcpServers: m.mcpServers.map(s => ({ ...s, name: mcpServerName })),
    config: m.config,
  };
}
