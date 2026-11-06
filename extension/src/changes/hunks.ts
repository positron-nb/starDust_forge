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

/**
 * Apply search/replace edits to a text. Each old_string must match exactly once
 * (or be empty with the file empty/new). Returns an error the model can act on otherwise.
 */
export function applyEdits(text: string, edits: Array<{ old_string: string; new_string: string }>): { ok: true; text: string } | { ok: false; error: string } {
  let cur = text.replace(/\r\n/g, '\n');
  for (const [i, e] of edits.entries()) {
    const oldS = e.old_string.replace(/\r\n/g, '\n');
    const newS = e.new_string.replace(/\r\n/g, '\n');
    if (oldS === '') {
      if (cur.trim() !== '') return { ok: false, error: `edit ${i + 1}: old_string is empty but the file is not; give the exact text to replace` };
      cur = newS; continue;
    }
    const first = cur.indexOf(oldS);
    if (first < 0) return { ok: false, error: `edit ${i + 1}: old_string not found in the file. Re-read the file (read_file) and copy the exact current text, including indentation.` };
    if (cur.indexOf(oldS, first + 1) >= 0) return { ok: false, error: `edit ${i + 1}: old_string occurs more than once; include more surrounding lines to make it unique.` };
    cur = cur.slice(0, first) + newS + cur.slice(first + oldS.length);
  }
  return { ok: true, text: cur };
}
