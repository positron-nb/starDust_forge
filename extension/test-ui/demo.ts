/**
 * Demo driver for the screen recording. Runs inside a real VS Code (Extension Development Host)
 * with the Flask checkout open and drives the extension exactly as a user would: it selects code,
 * fills the inline-edit box / panel input, presses accept/reject on each hunk, applies, cancels and
 * types verification commands into a visible Git Bash terminal. The models, TrueForge sessions,
 * edits and test output are all real. Nothing is mocked.
 *
 * FORGE_DEMO_TAKE = A | B | C, FORGE_DEMO_DIR = folder for events-<take>.jsonl / status.txt / go-* signals.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import type { ForgeTestApi } from '../src/extension';

const DIR = process.env.FORGE_DEMO_DIR ?? '.';
const TAKE = process.env.FORGE_DEMO_TAKE ?? 'A';
const TASK_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
const CANCEL_TASK = "In src/flask/helpers.py, make get_debug_flag also treat 'off' as false.";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function mark(ev: string, extra: Record<string, unknown> = {}): void {
  fs.appendFileSync(path.join(DIR, `events-${TAKE}.jsonl`), JSON.stringify({ t: Date.now(), ev, ...extra }) + '\n');
  fs.writeFileSync(path.join(DIR, 'status.txt'), `${new Date().toISOString()} ${TAKE} ${ev} ${JSON.stringify(extra)}\n`);
}
async function waitFor<T>(fn: () => T | undefined | false, timeoutMs: number, pollMs = 250): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(pollMs); }
  return undefined;
}
async function waitSignal(name: string, timeoutMs: number): Promise<void> {
  mark(`waiting-signal:${name}`);
  await waitFor(() => fs.existsSync(path.join(DIR, `go-${name}`)), timeoutMs, 500);
}

interface ReviewTab { id: string; hunks: number; label: string }
const seen = new Set<string>();
function reviewTab(): ReviewTab | undefined {
  for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) {
    const inp = t.input as { modified?: vscode.Uri } | undefined;
    if (inp?.modified?.scheme !== 'forge-review') continue;
    const id = inp.modified.path.split('/')[1];
    if (seen.has(id)) continue;
    const n = /— (\d+) hunk/.exec(t.label);
    return { id, hunks: n ? Number(n[1]) : 1, label: t.label };
  }
  return undefined;
}
async function review(t: ReviewTab, mode: 'accept' | 'reject', pauseMs: number): Promise<void> {
  seen.add(t.id);
  mark(`review-open`, { label: t.label, hunks: t.hunks, mode });
  await sleep(pauseMs);
  for (let i = 0; i < t.hunks; i++) {
    await vscode.commands.executeCommand(mode === 'accept' ? 'forge.review.acceptHunk' : 'forge.review.rejectHunk', t.id, i);
    await sleep(Math.max(500, pauseMs / 2));
  }
  await sleep(600);
  await vscode.commands.executeCommand('forge.review.apply', t.id);
  mark(`review-${mode}ed`, { label: t.label });
}

let term: vscode.Terminal | undefined;
async function shell(cmd: string, waitMs: number): Promise<void> {
  if (!term) {
    term = vscode.window.createTerminal({ name: 'verify (Git Bash)', shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe', shellArgs: ['--login', '-i'] });
    term.show(true);
    await sleep(3500);
  }
  term.show(true);
  term.sendText(cmd);
  await sleep(waitMs);
}
const CLEAN = 'test -z "$(git status --porcelain)" && echo "git status: working tree clean" || git status --short';

async function selectFunction(rel: string, name: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, rel)));
  const ed = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
  const lines = doc.getText().split(/\r?\n/);
  const start = lines.findIndex(l => l.startsWith(`def ${name}(`));
  let end = lines.findIndex((l, i) => i > start && /^(def |class |@)/.test(l));
  end = end < 0 ? lines.length - 1 : end - 1;
  while (end > start && !lines[end].trim()) end--;
  ed.selection = new vscode.Selection(start, 0, end, lines[end].length);
  ed.revealRange(new vscode.Range(Math.max(0, start - 6), 0, end, 0), vscode.TextEditorRevealType.AtTop);
}

async function showPanel(): Promise<void> {
  await vscode.commands.executeCommand('forge.agentView.focus');
  await sleep(800);
  await vscode.commands.executeCommand('workbench.action.focusSideBar');
  for (let i = 0; i < 14; i++) { await vscode.commands.executeCommand('workbench.action.increaseViewWidth'); await sleep(40); }
}

async function typeIntoPanel(text: string): Promise<void> {
  for (let i = 4; i <= text.length + 3; i += 4) { api.panelInput({ kind: 'prefill', text: text.slice(0, i) }); await sleep(18); }
  api.panelInput({ kind: 'prefill', text });
  await sleep(1200);
  api.panelInput({ kind: 'submit' });
}

/** Inline edit as a user does it: select the function, Ctrl+Alt+E, type, Enter. */
async function inlineEdit(instruction: string): Promise<void> {
  await selectFunction('src/flask/helpers.py', 'get_debug_flag');
  await sleep(2500);
  mark('inline-open');
  void vscode.commands.executeCommand('forge.inlineEdit', instruction);
  await sleep(3500);
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  mark('inline-sent');
}

let api: ForgeTestApi;
let root = '';

async function takeA(): Promise<void> {
  await inlineEdit(TASK_A);
  const t = await waitFor(reviewTab, 240_000);
  if (!t) { mark('A-no-review'); return; }
  await review(t, 'accept', 3500);
  await waitFor(() => !api.isRunning(), 180_000);
  mark('A-run-done');
  await sleep(2500);
  await shell('clear; git diff --stat', 2500);
  await shell(`for v in off OFF n N 0 false no 1 yes; do printf 'FLASK_DEBUG=%-5s -> ' "$v"; FLASK_DEBUG=$v .venv/Scripts/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"; done`, 9000);
  await shell('.venv/Scripts/python -m pytest tests/test_helpers.py -q 2>&1 | tail -1', 9000);
  mark('A-verified');
  await sleep(3000);
}

async function takeB(): Promise<void> {
  await vscode.commands.executeCommand('forge.newSession');
  await sleep(1500);
  mark('B-typing');
  await typeIntoPanel(TASK_B);
  mark('B-sent');
  await waitFor(() => api.isRunning(), 20_000);
  const end = Date.now() + 25 * 60_000;
  let reviews = 0;
  while (Date.now() < end) {
    const t = reviewTab();
    if (t) { await review(t, 'accept', reviews === 0 ? 3500 : 1800); reviews++; continue; }
    if (!api.isRunning()) break;
    await sleep(300);
  }
  mark('B-run-done', { reviews, session: api.sessionId() });
  await sleep(3000);
  await waitSignal('B-session', 15 * 60_000);   // TrueForge session is shown in a browser here
  mark('B-verify');
  await shell('clear; git status --short', 2500);
  await shell('.venv/Scripts/python -m pytest tests/test_cli.py -q 2>&1 | tail -2', 14000);
  await shell('.venv/Scripts/flask --app ../demo/task_b_app.py --help | grep -A12 "^Commands"', 5000);
  await shell(`.venv/Scripts/flask --app ../demo/task_b_app.py config | grep -E '"(API_TOKEN|DATABASE_PASSWORD|SECRET_KEY|NAME|DEBUG|TESTING)"'`, 6000);
  mark('B-verified');
  await sleep(2000);
  void vscode.commands.executeCommand('forge.undoRun');   // its info toast resolves only when dismissed
  mark('B-undo');
  await sleep(2500);
  await shell(CLEAN, 3500);
  mark('B-done');
  await sleep(2000);
}

async function takeC(): Promise<void> {
  // ---- cancellation: stop the run while its edit is waiting for review
  await vscode.commands.executeCommand('forge.newSession');
  await sleep(1500);
  mark('X-typing');
  await typeIntoPanel(CANCEL_TASK);
  mark('X-sent');
  const t = await waitFor(reviewTab, 240_000);
  if (t) { seen.add(t.id); mark('X-review-open', { label: t.label }); }
  await sleep(3500);
  await vscode.commands.executeCommand('forge.cancel');
  mark('X-cancelled');
  await waitFor(() => !api.isRunning(), 30_000);
  await sleep(2000);
  await shell(`clear; ${CLEAN}`, 3500);
  mark('X-verified');
  await sleep(1500);

  // ---- Task C: dead endpoint first in the fallback list
  await vscode.commands.executeCommand('workbench.action.openSettingsJson');
  await sleep(1500);
  await vscode.workspace.getConfiguration('forge').update('models', ['broken/dead-model', 'google-gemini/gemini-3-1-flash-lite'], vscode.ConfigurationTarget.Global);
  mark('C-settings');
  await sleep(4000);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await inlineEdit(TASK_A);
  let rejected = 0;
  const end = Date.now() + 6 * 60_000;
  while (Date.now() < end && rejected < 2) {
    const r = reviewTab();
    if (r) { await review(r, 'reject', 3500); rejected++; await sleep(1500); continue; }
    if (!api.isRunning() && rejected) break;
    await sleep(300);
  }
  if (api.isRunning()) { await vscode.commands.executeCommand('forge.cancel'); mark('C-cancel-after-reject'); }
  await waitFor(() => !api.isRunning(), 30_000);
  mark('C-run-done', { rejected });
  await sleep(2000);
  await shell(`clear; ${CLEAN}`, 3500);
  mark('C-verified');
  await sleep(3000);
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<ForgeTestApi | undefined>('forgeathon.forge-agent');
  const a = await ext?.activate();
  if (!a) { mark('no-api'); return; }
  api = a; root = a.root;
  mark('start', { vscode: vscode.version });
  await sleep(1500);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('notifications.clearAll');
  await showPanel();
  await selectFunction('src/flask/helpers.py', 'get_debug_flag');
  await sleep(2000);
  await vscode.commands.executeCommand('notifications.clearAll');
  await waitSignal('start', 5 * 60_000);         // recording is running
  await vscode.commands.executeCommand('notifications.clearAll');
  mark('go');
  try {
    if (TAKE === 'A') await takeA();
    if (TAKE === 'B') await takeB();
    if (TAKE === 'C') await takeC();
  } catch (e) { mark('error', { message: String((e as Error).message ?? e) }); }
  mark('end');
  await waitSignal('close', 10 * 60_000);
}
