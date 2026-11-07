/** get_context and find_symbol: the context engine exposed to the TrueForge agent. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextIndex } from '../context/index';
import { retrieve, formatContext, type ContextResult } from '../context/retrieve';

export interface ContextToolDeps {
  index: ContextIndex;
  onToolCall?: (name: string, args: unknown) => void;
  /** Lets the panel render the "why these files" table live. */
  onContext?: (r: ContextResult) => void;
}

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function installContextTools(server: McpServer, d: ContextToolDeps): void {
  server.registerTool('get_context', {
    title: 'Get relevant context',
    description: 'START HERE for any task. Retrieves the code, tests and docs most relevant to a natural-language query from an index of the whole repository, ' +
      'ranked (BM25 over symbols + import graph + test/doc links) and packed into a token budget. Returns outlines of the most relevant files, ' +
      'focused snippets with line numbers, and WHY each was selected. Call again with a narrower query to dig deeper.',
    inputSchema: {
      query: z.string().describe('What you need: the task, symbols, concepts'),
      budget_tokens: z.number().int().min(500).max(12000).default(3000).describe('Max tokens of context to return'),
    },
    annotations: RO,
  }, async ({ query, budget_tokens }) => {
    d.onToolCall?.('get_context', { query, budget_tokens });
    await d.index.refresh();
    // optional hard cap for providers with tiny per-request limits (e.g. Groq free 8K TPM)
    const cap = Number(process.env.FORGE_CONTEXT_MAX ?? 0);
    const r = retrieve(d.index, query, { budgetTokens: cap > 0 ? Math.min(budget_tokens, cap) : budget_tokens });
    d.onContext?.(r);
    return text(formatContext(r));
  });

  server.registerTool('find_symbol', {
    title: 'Find symbol',
    description: 'Find where a function, class, method or doc section is defined (exact name, then substring). Returns file, line range, signature and docstring.',
    inputSchema: { name: z.string().describe('Symbol name, e.g. "get_debug_flag" or "FlaskGroup.list_commands"') },
    annotations: RO,
  }, async ({ name }) => {
    d.onToolCall?.('find_symbol', { name });
    await d.index.refresh();
    const hits = d.index.findSymbols(name);
    if (!hits.length) return text(`No symbol matching "${name}". Try search_workspace.`);
    return text(hits.map(c => `${c.file}:${c.sym.start}-${c.sym.end} ${c.sym.kind} ${c.sym.qualified}\n    ${c.sym.signature}${c.sym.doc ? `\n    "${c.sym.doc}"` : ''}`).join('\n'));
  });
}
