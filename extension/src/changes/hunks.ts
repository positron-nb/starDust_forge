/**
 * Hunk model for diff review. Pure functions (no vscode) so they are unit-tested.
 * A proposal = original text + proposed text. We split the line diff into hunks
 * (maximal runs of changed lines) and can rebuild the file with any subset accepted.
 */
import { diffLines } from 'diff';

export type HunkState = 'pending' | 'accepted' | 'rejected';
export interface Hunk {
  index: number;
  /** 1-based line in the ORIGINAL where the hunk starts (insertions: line before which text is inserted). */
  origStart: number;
  removed: string[];
  added: string[];
  /** 1-based line in the PROPOSED (all hunks applied) text where the hunk starts. */
  newStart: number;
  state: HunkState;
}

interface Segment { kind: 'same' | 'hunk'; lines: string[]; hunk?: number }

export interface HunkSet { hunks: Hunk[]; segments: Segment[]; eol: string; }

const splitLines = (s: string) => (s === '' ? [] : s.replace(/\r\n/g, '\n').split('\n'));

export function computeHunks(original: string, proposed: string): HunkSet {
  const eol = /\r\n/.test(original) ? '\r\n' : '\n';
  const a = original.replace(/\r\n/g, '\n');
  const b = proposed.replace(/\r\n/g, '\n');
  const parts = diffLines(a, b);
  const segments: Segment[] = [];
  const hunks: Hunk[] = [];
  let o = 1, n = 1;
  let cur: Hunk | undefined;
  const flush = () => { if (cur) { segments.push({ kind: 'hunk', lines: [], hunk: cur.index }); hunks.push(cur); cur = undefined; } };
  for (const p of parts) {
    // diffLines keeps the trailing newline in each part's value
    const lines = p.value.endsWith('\n') ? p.value.slice(0, -1).split('\n') : p.value.split('\n');
    if (!p.added && !p.removed) {
      flush();
      segments.push({ kind: 'same', lines });
      o += lines.length; n += lines.length;
      continue;
    }
    if (!cur) cur = { index: hunks.length, origStart: o, newStart: n, removed: [], added: [], state: 'pending' };
    if (p.removed) { cur.removed.push(...lines); o += lines.length; }
    else { cur.added.push(...lines); n += lines.length; }
  }
  flush();
  return { hunks, segments, eol };
}

/** Rebuild text: accepted hunks take the new lines, everything else keeps the original. */
export function applyHunks(set: HunkSet, include: (h: Hunk) => boolean, originalEndsWithNewline: boolean): string {
  const out: string[] = [];
  for (const s of set.segments) {
    if (s.kind === 'same') out.push(...s.lines);
    else { const h = set.hunks[s.hunk!]; out.push(...(include(h) ? h.added : h.removed)); }
  }
  return out.join(set.eol) + (originalEndsWithNewline && out.length ? set.eol : '');
}

export function summarize(set: HunkSet): { accepted: number; rejected: number; pending: number; total: number } {
  const c = { accepted: 0, rejected: 0, pending: 0, total: set.hunks.length };
  for (const h of set.hunks) c[h.state]++;
  return c;
}

export interface EditSpec { old_string?: string; new_string: string; start_line?: number; end_line?: number }

/** Models often copy read_file output verbatim: "  123| code". Strip that prefix if EVERY line has it. */
export function stripLineNumbers(s: string): string {
  const lines = s.split('\n');
  return lines.every(l => /^\s*\d+\| ?/.test(l) || l === '') && lines.some(l => l !== '') ? lines.map(l => l.replace(/^\s*\d+\| ?/, '')).join('\n') : s;
}

/**
 * Apply edits to a text. Two forms (any model can use either):
 *  - search/replace: old_string must match exactly once. Tolerated, in order: exact match;
 *    read_file line-number prefixes; trailing-whitespace differences; indentation differences
 *    (new_string is re-indented by the same offset). Every tier still requires a UNIQUE match.
 *  - line range: start_line..end_line (1-based, inclusive, numbers of the ORIGINAL file) replaced by
 *    new_string; line-range edits are applied bottom-up so earlier numbers stay valid.
 * Errors are phrased so the model can fix the call.
 */
export function applyEdits(text: string, edits: EditSpec[]): { ok: true; text: string } | { ok: false; error: string } {
  let cur = text.replace(/\r\n/g, '\n');
  const ranged = edits.map((e, i) => ({ e, i })).filter(x => x.e.start_line !== undefined && !x.e.old_string);
  const replaces = edits.map((e, i) => ({ e, i })).filter(x => !(x.e.start_line !== undefined && !x.e.old_string));

  // line-range edits first, bottom-up, on the original numbering
  const lines = cur.split('\n');
  for (const { e, i } of [...ranged].sort((a, b) => b.e.start_line! - a.e.start_line!)) {
    const s = e.start_line!, en = e.end_line ?? e.start_line!;
    if (s < 1 || en < s - 1 || en > lines.length) return { ok: false, error: `edit ${i + 1}: line range ${s}-${en} is outside the file (1-${lines.length}).` };
    const repl = stripLineNumbers(e.new_string.replace(/\r\n/g, '\n'));
    lines.splice(s - 1, en - s + 1, ...(repl === '' ? [] : repl.split('\n')));
  }
  cur = lines.join('\n');

  for (const { e, i } of replaces) {
    const oldS = stripLineNumbers((e.old_string ?? '').replace(/\r\n/g, '\n'));
    let newS = stripLineNumbers(e.new_string.replace(/\r\n/g, '\n'));
    if (oldS === '') {
      if (cur.trim() !== '') return { ok: false, error: `edit ${i + 1}: old_string is empty but the file is not; give the text to replace, or use start_line/end_line.` };
      cur = newS; continue;
    }
    // tier 1: exact
    const first = cur.indexOf(oldS);
    if (first >= 0) {
      if (cur.indexOf(oldS, first + 1) >= 0) return { ok: false, error: `edit ${i + 1}: old_string occurs more than once; include more surrounding lines to make it unique, or use start_line/end_line.` };
      cur = cur.slice(0, first) + newS + cur.slice(first + oldS.length);
      continue;
    }
    // tiers 2/3: line-wise, ignoring trailing whitespace, then leading indentation
    const fileLines = cur.split('\n');
    const want = oldS.replace(/\n+$/, '').split('\n');
    let applied = false;
    for (const norm of [(l: string) => l.trimEnd(), (l: string) => l.trim()]) {
      const target = want.map(norm);
      const hits: number[] = [];
      for (let k = 0; k + target.length <= fileLines.length; k++) {
        if (target.every((t, j) => norm(fileLines[k + j]) === t)) hits.push(k);
      }
      if (hits.length > 1) return { ok: false, error: `edit ${i + 1}: old_string matches ${hits.length} places (lines ${hits.map(h => h + 1).join(', ')}); add surrounding lines or use start_line/end_line.` };
      if (hits.length === 1) {
        const k = hits[0];
        const indentOf = (l: string) => /^\s*/.exec(l)![0];
        const fileIndent = indentOf(fileLines[k]), oldIndent = indentOf(want[0]);
        if (fileIndent !== oldIndent) {
          newS = newS.split('\n').map(l => (l.startsWith(oldIndent) ? fileIndent + l.slice(oldIndent.length) : l.trim() === '' ? l : fileIndent + l.trimStart())).join('\n');
        }
        fileLines.splice(k, want.length, ...newS.replace(/\n$/, '').split('\n'));
        cur = fileLines.join('\n');
        applied = true;
        break;
      }
    }
    if (!applied) {
      // help the model: show where the first line of old_string is closest to existing code
      const firstLine = want.find(l => l.trim())?.trim() ?? '';
      const near = fileLines.map((l, n) => ({ n: n + 1, l })).filter(x => firstLine && x.l.trim() === firstLine).slice(0, 3);
      const hint = near.length ? ` The first line occurs at line(s) ${near.map(x => x.n).join(', ')} but the following lines differ.` : '';
      return { ok: false, error: `edit ${i + 1}: old_string not found in the file.${hint} Re-read the exact lines with read_file, or use start_line/end_line with the line numbers shown by read_file.` };
    }
  }
  return { ok: true, text: cur };
}
