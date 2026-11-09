/**
 * Loads agent/forge-coder.json (the agent definition shipped in the repo, written in
 * the HTTP API's snake_case) and converts it to the SDK's camelCase AgentSpec.
 *
 * Profiles:
 *  - "full" (default): the definition as shipped — deferred tool loading, sub-agents,
 *    ask-user questions; shows off TrueForge features.
 *  - "lean": for small/free models and tight free-tier limits. All workspace tools are
 *    preloaded (no list_tools/get_tool_info/call_tool meta-tools and no "discover tools
 *    first" instruction), sub-agents and ask-user are off. Measured: ~1.3k fewer prompt
 *    tokens on every request and no tool-discovery round trips.
 * compactAt: TrueForge compaction trigger (estimated input tokens). By default TrueForge
 * compacts at 80% of the context window, which for 1M-token models means never; free
 * tiers with per-minute token limits need history summarised much earlier.
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

export type AgentProfile = 'full' | 'lean';
export interface SpecOptions { profile?: AgentProfile; compactAt?: number; reasoningEffort?: string }

export function loadAgentSpec(mcpServerName: string, extraInstructions = '', opts: SpecOptions = {}): AgentSpec {
  const m = toCamel(structuredClone(agentDef.manifest)) as { instructions: string; mcpServers: Array<Record<string, unknown>>; config: Record<string, any> };
  const config = m.config;
  let mcpServers = m.mcpServers.map(s => ({ ...s, name: mcpServerName }));
  if (opts.profile === 'lean') {
    // Frequently used tools are preloaded (preload_tools); rarely needed ones (find_symbol,
    // list_files, the single-command run_command) stay deferred and are reached through TrueForge's
    // list_tools/get_tool_info/call_tool. Verification goes through the preloaded run_commands batch.
    mcpServers = mcpServers.map(s => ({ ...s, preloadTools: (((s as Record<string, unknown>).preloadTools as string[] | undefined) ?? []).filter(t => t !== 'run_command') }));
    config.askUserQuestions = { enabled: false };
    config.dynamicSubAgents = { enabled: false };
  }
  // compactAt > 0: explicit trigger; < 0: compaction disabled; 0/undefined: TrueForge default
  // (min(80% of context, context - max_output)).
  if (opts.compactAt && opts.compactAt > 0) {
    config.contextManagement = { ...config.contextManagement, compaction: { enabled: true, trigger: { type: 'input_tokens', value: opts.compactAt } } };
  } else if (opts.compactAt && opts.compactAt < 0) {
    config.contextManagement = { ...config.contextManagement, compaction: { enabled: false } };
  }
  return {
    instructions: m.instructions + (extraInstructions ? `\n\n${extraInstructions}` : ''),
    mcpServers,
    config,
    ...(opts.reasoningEffort ? { modelParams: { reasoningEffort: opts.reasoningEffort } } : {}),
  };
}
