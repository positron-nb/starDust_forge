/**
 * Budgeted context assembly.
 *
 * 1. Lexical recall   – BM25 over symbol chunks (identifier-aware tokens, name/doc/path weighted).
 * 2. Structural boost – exact symbol-name hits; files with many hits ("hot files").
 * 3. Graph expansion  – neighbours of the hottest files via the import graph, their test
 *                       counterparts (tests/test_<name>.py) and docs that mention their symbols.
 * 4. Diversity        – at most `perFile` chunks per file so one big file can't eat the budget.
 * 5. Budget packing   – greedy by score; each snippet is cut to `maxLines`; class chunks show
 *                       only their header + method list; overlapping ranges are skipped.
 * Every selected item carries a human-readable reason; dropped candidates are reported too.
 */
import type { ContextIndex, Chunk } from './index';
import { tokenize } from './index';

export interface ContextItem {
  file: string; symbol: string; kind: string; start: number; end: number;
  score: number; tokens: number; reasons: string[]; snippet: string;
}
export interface ContextResult {
  query: string; budget: number; used: number;
  items: ContextItem[];
  skipped: Array<{ file: string; symbol: string; score: number; why: string }>;
  stats: { files: number; chunks: number; candidates: number; indexMs: number };
}
export interface RetrieveOptions { budgetTokens?: number; perFile?: number; maxLines?: number; pinned?: string[] }

export const estimateTokens = (s: string) => Math.ceil(s.length / 3.6);

export function retrieve(idx: ContextIndex, query: string, o: RetrieveOptions = {}): ContextResult {
  const budget = Math.max(500, Math.min(o.budgetTokens ?? 6000, 24000));
  const perFile = o.perFile ?? 5;
  const maxLines = o.maxLines ?? 60;
  const terms = tokenize(query);
  // Only code-like identifiers get the exact-name boost: snake_case, camelCase/PascalCase-with-inner-capital,
  // dotted names or anything in backticks/quotes. Plain English words ("test", "add") do not.
  const quoted = [...query.matchAll(/[`'"]([A-Za-z_][\w.]*)[`'"]/g)].map(m => m[1]);
  const codeLike = (query.match(/[A-Za-z_][A-Za-z0-9_.]{2,}/g) ?? []).filter(w => /_|[a-z][A-Z]|\./.test(w));
  const rawIds = new Set([...quoted, ...codeLike].flatMap(w => [w, w.split('.').pop()!]).map(w => w.toLowerCase()));

  // 1+2. lexical recall with structural boosts
  const scored = new Map<number, { c: Chunk; score: number; reasons: string[] }>();
  const chunksById = new Map(idx.allChunks().map(c => [c.id, c]));
  for (const [id, { score, matched }] of idx.bm25(terms)) {
    const c = chunksById.get(id)!;
    const reasons = [`matches ${matched.slice(0, 5).map(t => `"${t}"`).join(', ')}`];
    let s = score;
    if (rawIds.has(c.sym.name.toLowerCase())) { s *= 2.5; reasons.unshift(`defines \`${c.sym.name}\` named in the request`); }
    if (c.sym.kind === 'section') s *= 0.8;
    if (c.sym.kind === 'function' && c.sym.qualified.includes('.')) s *= 0.4; // nested helper inside a function
    scored.set(id, { c, score: s, reasons });
  }

  // hot files = files whose chunks collectively score highest
  // file relevance = sum of its 3 best chunks (a plain total would favour huge files)
  const perFileScores = new Map<string, number[]>();
  for (const v of scored.values()) (perFileScores.get(v.c.file) ?? perFileScores.set(v.c.file, []).get(v.c.file)!).push(v.score);
  const fileScore = new Map([...perFileScores].map(([f, xs]) => [f, xs.sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0)]));
  const hot = [...fileScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([f]) => f);
  for (const v of scored.values()) {
    const rank = hot.indexOf(v.c.file);
    if (rank >= 0) { v.score *= 1.3 - rank * 0.05; v.reasons.push(`in a top-${rank + 1} relevant file`); }
  }

  // 3. graph expansion from the hottest code files
  const topScore = Math.max(1, ...[...scored.values()].map(v => v.score));
  const bump = (c: Chunk, factor: number, why: string) => {
    const cur = scored.get(c.id);
    if (cur) { cur.score += topScore * factor * 0.5; cur.reasons.push(why); }
    else scored.set(c.id, { c, score: topScore * factor * 0.35, reasons: [why] });
  };
  for (const f of hot.filter(f => !f.startsWith('tests/') && !/\.(md|rst)$/.test(f)).slice(0, 2)) {
    const base = f.split('/').pop()!.replace(/\.\w+$/, '');
    for (const c of idx.allChunks()) {
      if (c.file === f) continue;
      if (new RegExp(`(^|/)tests?/test_${base}\\.py$`).test(c.file) && scored.has(c.id)) bump(c, 0.4, `test counterpart of ${f}`);
    }
    for (const imp of idx.importersOf(f)) {
      for (const c of idx.allChunks()) if (c.file === imp && scored.has(c.id)) bump(c, 0.15, `imports ${f}`);
    }
  }

  // 4+5. diversity + greedy budget packing (outlines of the hottest files go first: cheap, high value)
  const ranked = [...scored.values()].sort((a, b) => b.score - a.score);
  const items: ContextItem[] = [];
  const skipped: ContextResult['skipped'] = [];
  const perFileCount = new Map<string, number>();
  const taken: Array<{ file: string; start: number; end: number }> = [];
  let used = 0;
  for (const [rank, f] of hot.slice(0, 3).entries()) {
    const outline = renderOutline(idx, f);
    const tokens = estimateTokens(outline) + 20;
    if (!outline || used + tokens > budget * 0.35) continue;
    used += tokens;
    items.push({ file: f, symbol: '(outline)', kind: 'outline', start: 1, end: idx.lines(f)?.length ?? 1, score: round(fileScore.get(f) ?? 0),
      tokens, reasons: [`top-${rank + 1} file by total relevance; outline lists every definition so related code can be found without reading the whole file`], snippet: outline });
  }
  for (const v of ranked) {
    const { c } = v;
    if (items.length >= 30) break;
    if ((perFileCount.get(c.file) ?? 0) >= perFile) { if (skipped.length < 15) skipped.push({ file: c.file, symbol: c.sym.qualified, score: round(v.score), why: `per-file cap (${perFile})` }); continue; }
    if (taken.some(t => t.file === c.file && c.sym.start >= t.start && c.sym.end <= t.end)) continue; // inside an already-shown range
    const snippet = renderSnippet(idx, c, maxLines);
    const tokens = estimateTokens(snippet) + 20;
    if (used + tokens > budget) { if (skipped.length < 15) skipped.push({ file: c.file, symbol: c.sym.qualified, score: round(v.score), why: `over budget (${tokens} tok)` }); continue; }
    used += tokens;
    perFileCount.set(c.file, (perFileCount.get(c.file) ?? 0) + 1);
    taken.push({ file: c.file, start: c.sym.start, end: c.sym.kind === 'class' ? c.sym.start : c.sym.end });
    items.push({ file: c.file, symbol: c.sym.qualified, kind: c.sym.kind, start: c.sym.start, end: c.sym.end,
      score: round(v.score), tokens, reasons: [...new Set(v.reasons)], snippet });
  }
  return { query, budget, used, items, skipped,
    stats: { files: idx.fileCount, chunks: idx.chunkCount, candidates: scored.size, indexMs: idx.lastRefreshMs } };
}

/** One line per top-level definition / class method / doc section, with line numbers. */
function renderOutline(idx: ContextIndex, file: string): string {
  const chunks = idx.allChunks().filter(c => c.file === file && !(c.sym.kind === 'function' && c.sym.qualified.includes('.')));
  if (chunks.length < 3) return '';
  return chunks.slice(0, 60).map(c => `${String(c.sym.start).padStart(5)}  ${c.sym.kind === 'method' ? '  ' : ''}${c.sym.signature.slice(0, 110)}`).join('\n')
    + (chunks.length > 60 ? `\n  … ${chunks.length - 60} more` : '');
}

function renderSnippet(idx: ContextIndex, c: Chunk, maxLines: number): string {
  const lines = idx.lines(c.file) ?? [];
  const num = (i: number) => `${String(i).padStart(5)}| ${lines[i - 1] ?? ''}`;
  if (c.sym.kind === 'class') {
    // header + docstring, then one line per method signature
    const out: string[] = [];
    const methods = idx.allChunks().filter(m => m.file === c.file && m.sym.kind === 'method' && m.sym.qualified.startsWith(c.sym.qualified + '.') && !m.sym.qualified.slice(c.sym.qualified.length + 1).includes('.'));
    const headerEnd = Math.min(c.sym.end, methods[0] ? methods[0].sym.start - 1 : c.sym.start + 25, c.sym.start + 25);
    for (let i = c.sym.start; i <= headerEnd; i++) out.push(num(i));
    for (const m of methods.slice(0, 25)) out.push(`${String(m.sym.start).padStart(5)}| ${(lines[m.sym.start - 1] ?? '').replace(/^(\s*)@.*/, '$1' + m.sym.signature)}  …`);
    return out.join('\n');
  }
  const end = Math.min(c.sym.end, c.sym.start + maxLines - 1);
  const out: string[] = [];
  for (let i = c.sym.start; i <= end; i++) out.push(num(i));
  if (end < c.sym.end) out.push(`  …  (${c.sym.end - end} more lines; read_file ${c.file} start_line=${end + 1})`);
  return out.join('\n');
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Compact text for the model: reasons first, then snippets. */
export function formatContext(r: ContextResult): string {
  const head = `Context for "${r.query}": ${r.items.length} snippets from ${new Set(r.items.map(i => i.file)).size} files, ${r.used}/${r.budget} tokens ` +
    `(index: ${r.stats.files} files, ${r.stats.chunks} symbols, ${r.stats.candidates} candidates).`;
  const why = r.items.map((it, i) => `${i + 1}. ${it.file}:${it.start}-${it.end} ${it.kind} ${it.symbol} [score ${it.score}] — ${it.reasons.join('; ')}`).join('\n');
  const skipped = r.skipped.length ? `\nNot included (ask with read_file if needed): ${r.skipped.slice(0, 8).map(s => `${s.file}::${s.symbol} (${s.why})`).join(', ')}` : '';
  const body = r.items.map(it => `\n### ${it.file} — ${it.symbol} (lines ${it.start}-${it.end})\n${it.snippet}`).join('\n');
  return `${head}\nWHY THESE WERE SELECTED:\n${why}${skipped}\n${body}`;
}
