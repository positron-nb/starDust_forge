/**
 * ContextIndex: an incremental, in-memory index of the workspace.
 *  - chunks  = one per symbol (function / method / class header / doc section)
 *  - lexical = BM25 over identifier-aware tokens, with field weights (name > path > doc > body)
 *  - graph   = import edges between files (Python dotted modules, JS relative paths)
 * Files are re-parsed only when their mtime changes, so repeated queries are cheap.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '../mcp/workspace';
import { IGNORED_DIRS } from '../mcp/workspace';
import { langOf, parseFile, type Sym } from './symbols';

export interface Chunk {
  id: number;
  file: string;
  sym: Sym;
  tf: Map<string, number>;  // weighted term frequencies
  len: number;              // weighted length
}

interface FileEntry { mtime: number; lines: string[]; chunks: Chunk[]; imports: string[]; }

const INDEXED = /\.(py|pyi|m?[jt]sx?|cjs|go|java|rs|cs|kt|md|rst)$/i;
const MAX_FILE_BYTES = 400_000;
const MAX_FILES = 6000;
const STOP = new Set('a an and are as at be by for from get has have how i if in into is it its of on or set that the this to was what when where which with should must also new add any all as use'.split(' '));

/** "routes_command" → [routes_command, routes, command]; "FlaskGroup" → [flaskgroup, flask, group]. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) ?? []) {
    const lower = raw.toLowerCase();
    const parts = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[_\s]+/).map(p => p.toLowerCase()).filter(Boolean);
    if (parts.length > 1 && !STOP.has(lower)) out.push(lower);
    for (const p of parts) if (p.length > 1 && !STOP.has(p)) out.push(p);
  }
  return out;
}

export class ContextIndex {
  private files = new Map<string, FileEntry>();
  private chunks: Chunk[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  private nextId = 0;
  private dirty = true;
  /** importer → imported files, and the reverse */
  private out = new Map<string, Set<string>>();
  private inn = new Map<string, Set<string>>();
  lastRefreshMs = 0;

  constructor(private readonly ws: Workspace) {}

  get fileCount(): number { return this.files.size; }
  get chunkCount(): number { return this.chunks.length; }
  lines(file: string): string[] | undefined { return this.files.get(file)?.lines; }
  allChunks(): readonly Chunk[] { return this.chunks; }
  importsOf(file: string): Set<string> { return this.out.get(file) ?? new Set(); }
  importersOf(file: string): Set<string> { return this.inn.get(file) ?? new Set(); }
  hasFile(f: string): boolean { return this.files.has(f); }

  /** Incremental refresh: stat everything, re-parse changed files only. */
  async refresh(): Promise<void> {
    const t0 = Date.now();
    const seen = new Set<string>();
    const walk = async (dir: string) => {
      if (seen.size >= MAX_FILES) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(abs); continue; }
        if (!INDEXED.test(e.name)) continue;
        const rel = path.relative(this.ws.root, abs).split(path.sep).join('/');
        seen.add(rel);
        const st = await fs.stat(abs).catch(() => undefined);
        if (!st || st.size > MAX_FILE_BYTES) continue;
        const cur = this.files.get(rel);
        if (cur && cur.mtime === st.mtimeMs) continue;
        const text = await fs.readFile(abs, 'utf8').catch(() => '');
        this.indexFile(rel, text, st.mtimeMs);
      }
    };
    await walk(this.ws.root);
    for (const f of [...this.files.keys()]) if (!seen.has(f)) { this.files.delete(f); this.dirty = true; }
    if (this.dirty) this.rebuild();
    this.lastRefreshMs = Date.now() - t0;
  }

  /** Index a file from text (also used by tests). */
  indexFile(rel: string, text: string, mtime = Date.now()): void {
    const parsed = parseFile(rel, text);
    const pathToks = tokenize(rel.replace(/\.\w+$/, ''));
    const lines = text.split(/\r?\n/);
    const chunks: Chunk[] = parsed.symbols.map(sym => {
      const tf = new Map<string, number>();
      const add = (toks: string[], w: number) => { for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + w); };
      add(tokenize(sym.qualified), 4);
      add(pathToks, 1.5);
      add(tokenize(sym.doc), 2);
      // body: for classes only the header region (methods are their own chunks)
      const bodyEnd = sym.kind === 'class' ? Math.min(sym.end, sym.start + 40) : Math.min(sym.end, sym.start + 250);
      add(tokenize(lines.slice(sym.start - 1, bodyEnd).join('\n')), 1);
      let len = 0; for (const v of tf.values()) len += v;
      return { id: this.nextId++, file: rel, sym, tf, len };
    });
    this.files.set(rel, { mtime, lines, chunks, imports: parsed.imports });
    this.dirty = true;
  }

  private rebuild(): void {
    this.chunks = [...this.files.values()].flatMap(f => f.chunks);
    this.df.clear();
    let total = 0;
    for (const c of this.chunks) { total += c.len; for (const t of c.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1); }
    this.avgLen = this.chunks.length ? total / this.chunks.length : 1;
    this.buildGraph();
    this.dirty = false;
  }

  private buildGraph(): void {
    this.out.clear(); this.inn.clear();
    // dotted module → file, using every suffix of the path ("src/flask/cli.py" → flask.cli, cli)
    const mod = new Map<string, string>();
    for (const f of this.files.keys()) {
      if (langOf(f) !== 'python') continue;
      const parts = f.replace(/\.pyi?$/, '').replace(/\/__init__$/, '').split('/');
      for (let i = 0; i < parts.length; i++) { const k = parts.slice(i).join('.'); if (!mod.has(k)) mod.set(k, f); }
    }
    for (const [f, entry] of this.files) {
      const targets = new Set<string>();
      for (const imp of entry.imports) {
        let target: string | undefined;
        if (langOf(f) === 'python') {
          let name = imp;
          if (imp.startsWith('.')) {
            const dots = /^\.+/.exec(imp)![0].length;
            const base = f.split('/').slice(0, -dots);
            name = [...base, imp.slice(dots)].filter(Boolean).join('.');
          }
          for (let n = name; n && !target; n = n.includes('.') ? n.slice(0, n.lastIndexOf('.')) : '') target = mod.get(n);
        } else if (imp.startsWith('.')) {
          const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), imp));
          target = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`].find(c => this.files.has(c));
        }
        if (target && target !== f) targets.add(target);
      }
      this.out.set(f, targets);
      for (const t of targets) { if (!this.inn.has(t)) this.inn.set(t, new Set()); this.inn.get(t)!.add(f); }
    }
  }

  /** BM25 score of each chunk for the query terms (k1=1.2, b=0.75). */
  bm25(terms: string[]): Map<number, { score: number; matched: string[] }> {
    const N = this.chunks.length || 1;
    const res = new Map<number, { score: number; matched: string[] }>();
    const uniq = [...new Set(terms)];
    for (const c of this.chunks) {
      let s = 0; const matched: string[] = [];
      for (const t of uniq) {
        const f = c.tf.get(t); if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * c.len / this.avgLen));
        matched.push(t);
      }
      if (s > 0) res.set(c.id, { score: s, matched });
    }
    return res;
  }

  findSymbols(name: string, limit = 20): Chunk[] {
    const q = name.toLowerCase();
    const exact = this.chunks.filter(c => c.sym.name.toLowerCase() === q || c.sym.qualified.toLowerCase() === q);
    const partial = exact.length ? [] : this.chunks.filter(c => c.sym.kind !== 'section' && c.sym.qualified.toLowerCase().includes(q));
    return [...exact, ...partial].slice(0, limit);
  }
}
