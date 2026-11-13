/**
 * Task ledger: the agent's working state, kept by the extension (outside the model's
 * context window), so it survives TrueForge context compaction AND a model fallback.
 * Tool handlers update it automatically — no extra model requests — and the `task_state`
 * tool returns it. The ledger also drives three generic gates:
 *   - edits-before-verify: while planned files are still unedited, command calls are refused;
 *   - verification-loop brake: at most N command calls in a row without an edit;
 *   - completion check: when the agent says "done", unfinished plan items / missing or failing
 *     tests produce one automatic follow-up turn (see AgentRunner `completionCheck`).
 * Nothing here is task-specific.
 */
import crypto from 'node:crypto';

export interface ReadRecord { hash: string; lines: number; ranges: Array<[number, number]>; reads: number }

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

export class TaskLedger {
  task = '';
  plan = '';
  next = '';
  /** 'agent': gates apply. 'inline': a single reviewed edit, no gates. */
  mode: 'agent' | 'inline' = 'agent';
  plannedFiles: string[] = [];
  readonly reads = new Map<string, ReadRecord>();
  readonly discovered = new Set<string>();
  readonly symbols = new Set<string>();
  readonly edits: Array<{ path: string; summary: string }> = [];
  readonly rejected: Array<{ path: string; reason: string }> = [];
  lastTest?: { command: string; exitCode: number | null; summary: string };
  /** True when a test command ran after the most recent applied edit. */
  testedSinceEdit = false;
  duplicateReads = 0;
  totalReads = 0;
  /** Command calls since the last applied edit (verification-loop brake). */
  commandsSinceEdit = 0;
  static readonly MAX_COMMANDS_WITHOUT_EDIT = 4;

  reset(task: string, mode: 'agent' | 'inline' = 'agent'): void {
    this.task = task; this.plan = ''; this.next = ''; this.mode = mode; this.plannedFiles = [];
    this.reads.clear(); this.discovered.clear(); this.symbols.clear();
    this.edits.length = 0; this.rejected.length = 0; this.lastTest = undefined; this.testedSinceEdit = false;
    this.duplicateReads = 0; this.totalReads = 0; this.commandsSinceEdit = 0;
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

  recordEdit(path: string, summary: string): void {
    this.edits.push({ path: norm(path), summary });
    this.reads.delete(path); this.reads.delete(norm(path));
    this.commandsSinceEdit = 0;
    this.testedSinceEdit = false;
  }

  recordRejected(path: string, reason: string): void { this.rejected.push({ path, reason: reason.slice(0, 200) }); }

  setPlannedFiles(files: string[]): void { this.plannedFiles = [...new Set(files.map(norm).filter(Boolean))]; }

  /** Planned files that have no applied edit yet. */
  pendingPlanned(): string[] {
    const edited = new Set(this.edits.map(e => e.path));
    return this.plannedFiles.filter(f => !edited.has(f));
  }

  /** Returns a refusal message when a command call should not run now (see the gates above). */
  commandBrake(): string | undefined {
    if (this.mode === 'agent' && this.edits.length > 0) {
      const pending = this.pendingPlanned();
      if (pending.length) {
        return `Refused: finish your planned edits first, then verify everything once. Still unedited: ${pending.join(', ')}. ` +
          'Apply those edits with propose_edit now. (If a planned file is no longer needed, update the plan: task_state(planned_files=[...]).)';
      }
    }
    if (++this.commandsSinceEdit <= TaskLedger.MAX_COMMANDS_WITHOUT_EDIT) return undefined;
    return `Refused: ${this.commandsSinceEdit - 1} command calls in a row without an edit. Stop probing. Read the last failing output above, then either fix the code/tests with propose_edit, or finish with a summary that states what is still failing. (Commands are allowed again after your next applied edit.)`;
  }

  recordCommand(command: string, exitCode: number | null, output: string): void {
    if (!/pytest|test|jest|vitest|npm (run )?test|go test|cargo test/i.test(command)) return;
    const summary = [...output.matchAll(/^.*\b(\d+ (passed|failed|error|errors|skipped))\b.*$/gim)].map(m => m[0].trim()).pop()
      ?? output.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 200);
    this.lastTest = { command, exitCode, summary };
    this.testedSinceEdit = true;
  }

  /**
   * Called when the agent ends its turn. Returns a follow-up instruction when the work is
   * visibly unfinished (agent mode, at least one applied edit), otherwise undefined.
   */
  completionIssues(): string | undefined {
    if (this.mode !== 'agent' || this.edits.length === 0) return undefined;
    const issues: string[] = [];
    const pending = this.pendingPlanned();
    if (pending.length) issues.push(`your plan lists file(s) with no applied edit yet: ${pending.join(', ')}`);
    if (!this.testedSinceEdit) issues.push('no test command has run since your last applied edit');
    else if (this.lastTest && this.lastTest.exitCode !== 0) issues.push(`the last test run failed (\`${this.lastTest.command}\` → exit ${this.lastTest.exitCode}; ${this.lastTest.summary})`);
    if (!issues.length) return undefined;
    return `Completion check by the editor — the task is not finished: ${issues.join('; ')}. ` +
      'Finish the remaining edits first, then verify once with a single run_commands call (the test file(s) covering your change), fix any failure, and only then give the final summary. ' +
      'If something cannot be done, say exactly what and why.';
  }

  /**
   * State for a fallback model that starts a fresh session after the previous model failed.
   * Returns undefined when nothing useful happened yet. The new model has not seen any file
   * content, so read ranges are forgotten (files stay listed as relevant).
   */
  handoff(): string | undefined {
    if (this.edits.length === 0 && this.discovered.size === 0 && !this.plan) return undefined;
    this.reads.clear();
    this.commandsSinceEdit = 0;
    return 'HANDOFF — a previous model worked on this task in this workspace and then failed (provider error). Its recorded state follows. ' +
      'Edits listed as applied are ALREADY on disk: do not redo them; re-read a file before editing it again. You have not seen any file content yet, so read what you need (read_files), then continue with the pending work.\n\n' +
      this.render();
  }

  render(): string {
    const merged = (rs: Array<[number, number]>) => rs.slice().sort((a, b) => a[0] - b[0])
      .reduce<Array<[number, number]>>((acc, [s, e]) => { const l = acc[acc.length - 1]; if (l && s <= l[1] + 1) l[1] = Math.max(l[1], e); else acc.push([s, e]); return acc; }, [])
      .map(([s, e]) => `${s}-${e}`).join(', ');
    const edited = new Set(this.edits.map(e => e.path));
    const out = [
      `ORIGINAL TASK:\n${this.task || '(not recorded)'}`,
      `PLAN: ${this.plan || '(none recorded)'}`,
      this.plannedFiles.length ? `PLANNED FILES: ${this.plannedFiles.map(f => `${f} (${edited.has(f) ? 'edited ✓' : 'PENDING'})`).join(', ')}` : '',
      `FILES READ (current content, line ranges already seen):\n${[...this.reads].map(([p, r]) => `- ${p} (${r.lines} lines, rev ${r.hash}): ${merged(r.ranges)}`).join('\n') || '- none'}`,
      `OTHER RELEVANT FILES FOUND: ${[...this.discovered].filter(p => !this.reads.has(p)).join(', ') || 'none'}`,
      `SYMBOLS: ${[...this.symbols].slice(0, 30).join(', ') || 'none'}`,
      `EDITS APPLIED:\n${this.edits.map((e, i) => `${i + 1}. ${e.path}: ${e.summary}`).join('\n') || '- none'}`,
      this.rejected.length ? `EDITS REFUSED/REJECTED:\n${this.rejected.slice(-6).map(r => `- ${r.path}: ${r.reason}`).join('\n')}` : '',
      `LAST TEST: ${this.lastTest ? `\`${this.lastTest.command}\` → exit ${this.lastTest.exitCode}; ${this.lastTest.summary}${this.testedSinceEdit ? '' : ' (STALE: edits were applied after it)'}` : 'not run yet'}`,
      `NEXT: ${this.next || '(not recorded)'}`,
      `(Files changed by applied edits must be re-read before editing them again; other ranges above are unchanged since you read them.)`,
    ];
    return out.filter(Boolean).join('\n\n');
  }
}
