/**
 * Task ledger: the agent's working state, kept by the extension (outside the model's
 * context window), so it survives TrueForge context compaction. Tool handlers update it
 * automatically — no extra model requests — and the `task_state` tool returns it.
 * Nothing here is task-specific.
 */
import crypto from 'node:crypto';

export interface ReadRecord { hash: string; lines: number; ranges: Array<[number, number]>; reads: number }

export class TaskLedger {
  task = '';
  plan = '';
  next = '';
  readonly reads = new Map<string, ReadRecord>();
  readonly discovered = new Set<string>();
  readonly symbols = new Set<string>();
  readonly edits: Array<{ path: string; summary: string }> = [];
  readonly rejected: Array<{ path: string; reason: string }> = [];
  lastTest?: { command: string; exitCode: number | null; summary: string };
  duplicateReads = 0;
  totalReads = 0;

  reset(task: string): void {
    this.task = task; this.plan = ''; this.next = '';
    this.reads.clear(); this.discovered.clear(); this.symbols.clear();
    this.edits.length = 0; this.rejected.length = 0; this.lastTest = undefined;
    this.duplicateReads = 0; this.totalReads = 0;
  }

  static hash(text: string): string { return crypto.createHash('sha1').update(text).digest('hex').slice(0, 10); }

  /** Records a read; returns true when this exact (unchanged) range was already returned before. */
  recordRead(path: string, content: string, start: number, end: number): boolean {
    this.totalReads++;
    const hash = TaskLedger.hash(content);
    const lines = content.split(/\r?\n/).length;
    let r = this.reads.get(path);
    if (!r || r.hash !== hash) { r = { hash, lines, ranges: [], reads: 0 }; this.reads.set(path, r); }
    r.reads++;
    const dup = r.ranges.some(([s, e]) => s <= start && e >= end);
    if (dup) this.duplicateReads++;
    else r.ranges.push([start, end]);
    this.discovered.add(path);
    return dup;
  }

  recordEdit(path: string, summary: string): void { this.edits.push({ path, summary }); this.reads.delete(path); }
  recordRejected(path: string, reason: string): void { this.rejected.push({ path, reason: reason.slice(0, 200) }); }

  recordCommand(command: string, exitCode: number | null, output: string): void {
    if (!/pytest|test|jest|vitest|npm (run )?test|go test|cargo test/i.test(command)) return;
    const summary = [...output.matchAll(/^.*\b(\d+ (passed|failed|error|errors|skipped))\b.*$/gim)].map(m => m[0].trim()).pop()
      ?? output.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 200);
    this.lastTest = { command, exitCode, summary };
  }

  render(): string {
    const merged = (rs: Array<[number, number]>) => rs.slice().sort((a, b) => a[0] - b[0])
      .reduce<Array<[number, number]>>((acc, [s, e]) => { const l = acc[acc.length - 1]; if (l && s <= l[1] + 1) l[1] = Math.max(l[1], e); else acc.push([s, e]); return acc; }, [])
      .map(([s, e]) => `${s}-${e}`).join(', ');
    const out = [
      `ORIGINAL TASK:\n${this.task || '(not recorded)'}`,
      `PLAN: ${this.plan || '(none recorded)'}`,
      `FILES READ (current content, line ranges already seen):\n${[...this.reads].map(([p, r]) => `- ${p} (${r.lines} lines, rev ${r.hash}): ${merged(r.ranges)}`).join('\n') || '- none'}`,
      `OTHER RELEVANT FILES FOUND: ${[...this.discovered].filter(p => !this.reads.has(p)).join(', ') || 'none'}`,
      `SYMBOLS: ${[...this.symbols].slice(0, 30).join(', ') || 'none'}`,
      `EDITS APPLIED:\n${this.edits.map((e, i) => `${i + 1}. ${e.path}: ${e.summary}`).join('\n') || '- none'}`,
      this.rejected.length ? `EDITS REFUSED/REJECTED:\n${this.rejected.map(r => `- ${r.path}: ${r.reason}`).join('\n')}` : '',
      `LAST TEST: ${this.lastTest ? `\`${this.lastTest.command}\` → exit ${this.lastTest.exitCode}; ${this.lastTest.summary}` : 'not run yet'}`,
      `NEXT: ${this.next || '(not recorded)'}`,
      `(Files changed by applied edits must be re-read before editing them again; other ranges above are unchanged since you read them.)`,
    ];
    return out.filter(Boolean).join('\n\n');
  }
}
