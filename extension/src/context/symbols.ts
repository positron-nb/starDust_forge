/**
 * Lightweight, dependency-free structural parsing. We do not need a full AST:
 * for retrieval we need (name, kind, line range, docstring) per definition, and
 * the import edges of each file. Indentation (Python) and brace balance (C-like)
 * give reliable ranges for well-formatted code; docs are split by section headings.
 */
export type SymbolKind = 'class' | 'function' | 'method' | 'section';

export interface Sym {
  name: string;        // short name, e.g. "routes_command"
  qualified: string;   // e.g. "FlaskGroup.list_commands"
  kind: SymbolKind;
  start: number;       // 1-based, includes decorators
  end: number;         // 1-based inclusive
  signature: string;   // first definition line, trimmed
  doc: string;         // docstring / first paragraph (short)
}

export interface ParsedFile { symbols: Sym[]; imports: string[]; lang: Lang }
export type Lang = 'python' | 'js' | 'docs' | 'other';

export function langOf(path: string): Lang {
  if (/\.pyi?$/.test(path)) return 'python';
  if (/\.(m?[jt]sx?|cjs|go|java|rs|cs|kt|swift|c|cc|cpp|h|hpp)$/.test(path)) return 'js';
  if (/\.(md|rst|txt)$/i.test(path)) return 'docs';
  return 'other';
}

export function parseFile(path: string, text: string): ParsedFile {
  const lang = langOf(path);
  const lines = text.split(/\r?\n/);
  if (lang === 'python') return { lang, ...parsePython(lines) };
  if (lang === 'js') return { lang, ...parseBraces(lines) };
  if (lang === 'docs') return { lang, symbols: parseDocs(lines, /\.rst$/i.test(path)), imports: [] };
  return { lang, symbols: [], imports: [] };
}

const indentOf = (l: string) => l.length - l.trimStart().length;

function parsePython(lines: string[]): { symbols: Sym[]; imports: string[] } {
  const symbols: Sym[] = [];
  const imports: string[] = [];
  const stack: Array<{ indent: number; sym: Sym }> = [];
  const close = (indent: number, lineNo: number) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      const top = stack.pop()!;
      top.sym.end = lastCode(lines, top.sym.start, lineNo - 1);
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const ind = indentOf(line);
    const m = /^(async\s+def|def|class)\s+([A-Za-z_]\w*)/.exec(t);
    if (m) {
      close(ind, i + 1);
      let start = i + 1;
      while (start > 1 && lines[start - 2].trim().startsWith('@')) start--;
      const parent = stack[stack.length - 1]?.sym;
      const kind: SymbolKind = m[1] === 'class' ? 'class' : parent?.kind === 'class' ? 'method' : 'function';
      const sym: Sym = { name: m[2], qualified: parent ? `${parent.qualified}.${m[2]}` : m[2], kind, start, end: lines.length, signature: t.replace(/:\s*$/, ''), doc: pyDoc(lines, i + 1) };
      symbols.push(sym);
      stack.push({ indent: ind, sym });
      continue;
    }
    if (stack.length && ind <= stack[stack.length - 1].indent) close(ind, i + 1);
    if (ind === 0 || /^\s*(from|import)\s/.test(line)) {
      let im = /^from\s+(\.*[\w.]*)\s+import\s+(.+)/.exec(t);
      if (im) { imports.push(im[1]); for (const n of im[2].replace(/[()]/g, '').split(',')) { const nm = n.trim().split(/\s+as\s+/)[0]; if (/^\w+$/.test(nm)) imports.push(`${im[1]}${im[1].endsWith('.') ? '' : '.'}${nm}`); } }
      im = /^import\s+([\w.]+)/.exec(t);
      if (im) imports.push(im[1]);
    }
  }
  close(-1, lines.length + 1);
  return { symbols, imports };
}

function lastCode(lines: string[], from: number, to: number): number {
  let e = to;
  while (e > from && !lines[e - 1]?.trim()) e--;
  return Math.max(from, e);
}

function pyDoc(lines: string[], defIdx: number): string {
  // find the end of the signature (may span lines), then a docstring
  let j = defIdx - 1;
  while (j < lines.length && !/:\s*(#.*)?$/.test(lines[j])) j++;
  const first = lines[j + 1]?.trim() ?? '';
  const q = /^[rbuRBU]?("""|''')/.exec(first);
  if (!q) return '';
  let doc = first.slice(q[0].length);
  for (let k = j + 2; k < Math.min(lines.length, j + 12) && !doc.includes(q[1]); k++) doc += ' ' + lines[k].trim();
  return doc.split(q[1])[0].split(/\n\s*\n|\.\s/)[0].trim().replace(/\.$/, '').slice(0, 200);
}

function parseBraces(lines: string[]): { symbols: Sym[]; imports: string[] } {
  const symbols: Sym[] = [];
  const imports: string[] = [];
  const re = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:(class|interface|function\*?|func|fn|def)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/;
  for (let i = 0; i < lines.length; i++) {
    const im = /(?:import\s.*?from\s+|require\(\s*|import\s+)['"]([^'"]+)['"]/.exec(lines[i]);
    if (im) imports.push(im[1]);
    const m = re.exec(lines[i]);
    if (!m) continue;
    const name = m[2] ?? m[3];
    let depth = 0, seen = false, end = i + 1;
    for (let k = i; k < Math.min(lines.length, i + 2000); k++) {
      for (const ch of lines[k]) { if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--; }
      if (seen && depth <= 0) { end = k + 1; break; }
      if (!seen && k > i + 3) break;
    }
    symbols.push({ name, qualified: name, kind: m[1] === 'class' || m[1] === 'interface' ? 'class' : 'function', start: i + 1, end, signature: lines[i].trim().slice(0, 160), doc: '' });
  }
  return { symbols, imports };
}

function parseDocs(lines: string[], rst: boolean): Sym[] {
  const heads: Array<{ title: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const md = /^#{1,4}\s+(.+)/.exec(lines[i]);
    if (!rst && md) heads.push({ title: md[1].trim(), line: i + 1 });
    if (rst && lines[i].trim() && /^([=\-~^"'`#*+])\1{2,}\s*$/.test(lines[i + 1] ?? '') && !/^([=\-~^"'`#*+])\1+$/.test(lines[i].trim())) {
      heads.push({ title: lines[i].trim(), line: i + 1 });
    }
  }
  return heads.map((h, k) => ({ name: h.title, qualified: h.title, kind: 'section' as const, start: h.line,
    end: lastCode(lines, h.line, (heads[k + 1]?.line ?? lines.length + 1) - 1), signature: h.title, doc: '' }));
}
