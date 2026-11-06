/**
 * Explicit context: "@file:path" (or "@path/with.ext") and "@symbol:name" in a request
 * are resolved locally and attached to the user turn as pinned context, within their
 * own budget. Unresolvable mentions are reported back instead of silently dropped.
 */
import type { ContextIndex } from './index';
import { estimateTokens } from './retrieve';

export interface Mention { kind: 'file' | 'symbol'; ref: string; resolved: boolean; detail: string; tokens: number }
export interface MentionResult { message: string; mentions: Mention[] }

const RE = /@(?:(file|symbol):)?([A-Za-z0-9_./\\-]+[A-Za-z0-9_])/g;

export function parseMentions(text: string): Array<{ kind: 'file' | 'symbol'; ref: string }> {
  const out: Array<{ kind: 'file' | 'symbol'; ref: string }> = [];
  for (const m of text.matchAll(RE)) {
    const explicit = m[1] as 'file' | 'symbol' | undefined;
    const ref = m[2].replace(/\\/g, '/');
    const kind = explicit ?? (/[/.]\w+$/.test(ref) && ref.includes('.') ? 'file' : 'symbol');
    // skip things like e-mail addresses / decorators written in prose without a path or explicit kind
    if (!explicit && kind === 'symbol' && !/[_A-Z]/.test(ref)) continue;
    out.push({ kind, ref });
  }
  return out;
}

export async function resolveMentions(idx: ContextIndex, text: string, budgetTokens = 5000): Promise<MentionResult> {
  const parsed = parseMentions(text);
  if (!parsed.length) return { message: text, mentions: [] };
  await idx.refresh();
  const blocks: string[] = [];
  const mentions: Mention[] = [];
  let used = 0;
  const num = (lines: string[], s: number, e: number) => lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}| ${l}`).join('\n');

  for (const { kind, ref } of parsed) {
    let block = '';
    let detail = '';
    if (kind === 'file') {
      const lines = idx.lines(ref.replace(/^\.?\//, ''));
      if (!lines) { mentions.push({ kind, ref, resolved: false, detail: 'file not found in index', tokens: 0 }); continue; }
      const file = ref.replace(/^\.?\//, '');
      if (lines.length <= 250) { block = `### @file ${file} (full, ${lines.length} lines)\n${num(lines, 1, lines.length)}`; detail = `full file (${lines.length} lines)`; }
      else {
        const outline = idx.allChunks().filter(c => c.file === file && !(c.sym.kind === 'function' && c.sym.qualified.includes('.')))
          .map(c => `${String(c.sym.start).padStart(5)}  ${c.sym.signature.slice(0, 110)}`).join('\n');
        block = `### @file ${file} (${lines.length} lines — outline only; use read_file for ranges)\n${outline}`;
        detail = `outline (file has ${lines.length} lines)`;
      }
    } else {
      const hits = idx.findSymbols(ref, 3);
      if (!hits.length) { mentions.push({ kind, ref, resolved: false, detail: 'symbol not found', tokens: 0 }); continue; }
      const c = hits[0];
      const lines = idx.lines(c.file) ?? [];
      const end = Math.min(c.sym.end, c.sym.start + 120);
      block = `### @symbol ${c.sym.qualified} — ${c.file}:${c.sym.start}-${c.sym.end}\n${num(lines, c.sym.start, end)}`;
      detail = `${c.file}:${c.sym.start}-${c.sym.end}${hits.length > 1 ? ` (+${hits.length - 1} other matches)` : ''}`;
    }
    const t = estimateTokens(block);
    if (used + t > budgetTokens) { mentions.push({ kind, ref, resolved: false, detail: `skipped: over mention budget (${t} tok)`, tokens: 0 }); continue; }
    used += t;
    blocks.push(block);
    mentions.push({ kind, ref, resolved: true, detail, tokens: t });
  }
  const missing = mentions.filter(m => !m.resolved).map(m => `@${m.kind}:${m.ref} (${m.detail})`);
  const message = text +
    (blocks.length ? `\n\n<pinned_context source="user @-mentions">\n${blocks.join('\n\n')}\n</pinned_context>` : '') +
    (missing.length ? `\n\n(Unresolved mentions: ${missing.join(', ')})` : '');
  return { message, mentions };
}
