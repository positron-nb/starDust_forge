/** Turns propose_edit arguments (from a TrueForge approval pause) into a reviewable Proposal. */
import type { Workspace } from '../mcp/workspace';
import { applyEdits, type EditSpec } from './hunks';
import { ChangeManager, proposalKey, type FileIO, type Proposal } from './changeManager';
import { parseFile, langOf } from '../context/symbols';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Syntax check for Python proposals (ast.parse — nothing is executed or written).
 * Returns an error message, or undefined when the code parses or no interpreter is available.
 */
export function pythonSyntaxError(root: string, source: string): string | undefined {
  const venv = ['.venv/Scripts/python.exe', '.venv/bin/python'].map(p => path.join(root, p)).find(p => fs.existsSync(p));
  const script = ['import ast,sys', 'try:', ' ast.parse(sys.stdin.read())', 'except SyntaxError as e:', ' print(f"line {e.lineno}: {e.msg}"); sys.exit(3)'].join('\n');
  const r = spawnSync(venv ?? 'python', ['-c', script],
    { input: source, encoding: 'utf8', timeout: 8000, windowsHide: true });
  return r.status === 3 ? r.stdout.trim() : undefined;
}

/** Qualified names of code definitions present in `before` but missing from `after`. */
export function removedDefinitions(path: string, before: string, after: string): string[] {
  const lang = langOf(path);
  if (lang !== 'python' && lang !== 'js') return [];
  const count = (t: string) => {
    const m = new Map<string, number>();
    for (const s of parseFile(path, t).symbols) m.set(s.qualified, (m.get(s.qualified) ?? 0) + 1);
    // module-level names too (e.g. `cli = FlaskGroup(...)`, `export const x =`)
    const re = lang === 'python' ? /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/gm : /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
    for (const [, name] of t.matchAll(re)) if (!m.has(name)) m.set(name, 1);
    return m;
  };
  const a = count(after);
  const out: string[] = [];
  for (const [name, n] of count(before)) if ((a.get(name) ?? 0) < n) out.push(name);
  return out;
}

export async function prepareProposal(ws: Workspace, changes: ChangeManager, io: FileIO, args: unknown):
  Promise<{ ok: true; proposal: Proposal } | { ok: false; reason: string }> {
  const a = args as { path?: string; edits?: EditSpec[]; description?: string; confirm_removal?: string[] };
  if (!a?.path || !Array.isArray(a.edits) || a.edits.length === 0) return { ok: false, reason: 'propose_edit needs "path" and a non-empty "edits" array.' };
  let abs: string, rel: string;
  try { ({ abs, rel } = ws.resolve(a.path)); } catch (e) { return { ok: false, reason: (e as Error).message }; }
  const original = await io.read(abs);
  const applied = applyEdits(original ?? '', a.edits);
  if (!applied.ok) return { ok: false, reason: `Edit could not be applied to ${rel}: ${applied.error}` };
  const eolText = original && /\r\n/.test(original) ? applied.text.replace(/\n/g, '\r\n') : applied.text;
  if ((original ?? '').replace(/\r\n/g, '\n') === applied.text) return { ok: false, reason: `The edit to ${rel} does not change anything.` };
  // Guard: deleting existing definitions must be explicit, and is always flagged in the review.
  // Only definitions that existed before this agent run are protected; the agent may still
  // rework code it added itself earlier in the same run.
  const baseline = changes.baselineOf(rel) ?? original ?? '';
  const preexisting = new Set(removedDefinitions(rel, baseline, ''));
  const removed = original ? removedDefinitions(rel, original, applied.text).filter(n => preexisting.has(n)) : [];
  const confirmed = new Set(a.confirm_removal ?? []);
  const unconfirmed = removed.filter(n => !confirmed.has(n) && !confirmed.has(n.split('.').pop()!));
  if (unconfirmed.length) {
    return { ok: false, reason: `Refused: this edit to ${rel} would delete existing definition(s) ${unconfirmed.join(', ')}. ` +
      'Keep existing code and add new code next to it (e.g. insert with start_line/end_line). Only if the user explicitly asked to remove them, repeat the call with confirm_removal: [names].' };
  }
  if (/\.pyi?$/.test(rel)) {
    const err = pythonSyntaxError(ws.root, applied.text);
    if (err && !(original && pythonSyntaxError(ws.root, original))) {
      return { ok: false, reason: `Refused: the edit would make ${rel} invalid Python (${err}). Re-read the region and send a corrected edit.` };
    }
  }
  const warn = removed.length ? `⚠ removes existing ${removed.join(', ')} — ` : '';
  const proposal = changes.createProposal({ key: proposalKey(a.path, a.edits), path: rel, abs, original, proposed: eolText, description: warn + (a.description ?? '') });
  return { ok: true, proposal };
}
