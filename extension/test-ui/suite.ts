/**
 * UI integration tests. They run INSIDE a real VS Code extension host (see run.ts) against
 * the real extension: the review diff editor, hunk commands, apply, undo, cancel and guards.
 * No model is needed: each test calls the same `approve` function that runs during a
 * TrueForge approval pause, then drives the UI through VS Code commands, and checks the disk.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { ForgeTestApi } from '../src/extension';

const ORIGINAL = [
  'def add(a, b):', '    return a + b', '', '',
  'def sub(a, b):', '    return a - b', '', '',
  'def keep():', '    return 1', '',
].join('\n');
const EDITS = [
  { old_string: '    return a + b', new_string: '    return b + a' },
  { old_string: '    return a - b', new_string: '    return -(b - a)' },
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(what: string, f: () => T | undefined | false | Promise<T | undefined | false>, ms = 15000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await sleep(100);
  }
}
const reviewTabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs)
  .filter(t => (t.input as { modified?: vscode.Uri } | undefined)?.modified?.scheme === 'forge-review');
const idOf = (t: vscode.Tab) => (t.input as { modified: vscode.Uri }).modified.path.split('/')[1];
const req = (args: unknown) => ({ threadId: 'main', toolCallId: `call-${Date.now()}`, toolName: 'propose_edit', args });

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<ForgeTestApi | undefined>('forgeathon.forge-agent');
  assert.ok(ext, 'extension forgeathon.forge-agent is installed in the test host');
  const api = await ext.activate();
  assert.ok(api, 'activate() returned the test API (a workspace folder is open)');
  const file = path.join(api.root, 'calc.py');
  const disk = () => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const reset = async () => {
    api.cancelPending();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(file, ORIGINAL, 'utf8');
    await sleep(150);
  };

  const results: Array<{ name: string; ok: boolean; error?: string }> = [];
  const test = async (name: string, f: () => Promise<void>) => {
    try { await reset(); await f(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, error: (e as Error).message }); }
  };

  await test('all Forge commands are registered', async () => {
    const all = new Set(await vscode.commands.getCommands(true));
    for (const c of ['forge.inlineEdit', 'forge.cancel', 'forge.newSession', 'forge.showSession', 'forge.undoLast', 'forge.undoRun',
      'forge.review.acceptHunk', 'forge.review.rejectHunk', 'forge.review.acceptAll', 'forge.review.rejectAll', 'forge.review.apply', 'forge.review.open']) {
      assert.ok(all.has(c), `command ${c} is registered`);
    }
  });

  await test('agent panel view opens', async () => {
    await vscode.commands.executeCommand('forge.agentView.focus');
  });

  await test('proposed edit opens a native diff editor; nothing is written before review', async () => {
    const pending = api.approve(req({ path: 'calc.py', edits: EDITS, description: 'swap operands' }));
    const tab = await until('review diff tab', () => reviewTabs()[0]);
    assert.match(tab.label, /^Forge review: calc\.py — 2 hunks$/);
    assert.ok(tab.input instanceof vscode.TabInputTextDiff, 'tab is a text diff editor');
    assert.equal(disk(), ORIGINAL, 'file on disk is unchanged while the diff is under review');
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', (tab.input as vscode.TabInputTextDiff).modified);
    const titles = (lenses ?? []).map(l => l.command?.title ?? '');
    assert.ok(titles.some(t => /Hunk 1\/2 \[pending\]: ✓ Accept/.test(t)) && titles.some(t => /Hunk 2\/2/.test(t)), `per-hunk CodeLens present (${titles.join(' | ')})`);
    api.cancelPending();
    assert.deepEqual(await pending, { allow: false, reason: 'The run was cancelled; nothing was written.' });
  });

  await test('accept hunk 1, reject hunk 2, apply → only the accepted hunk reaches disk', async () => {
    const pending = api.approve(req({ path: 'calc.py', edits: EDITS }));
    const id = idOf(await until('review diff tab', () => reviewTabs()[0]));
    await vscode.commands.executeCommand('forge.review.acceptHunk', id, 0);
    await vscode.commands.executeCommand('forge.review.rejectHunk', id, 1);
    await vscode.commands.executeCommand('forge.review.apply', id);
    assert.deepEqual(await pending, { allow: true });
    assert.equal(disk(), ORIGINAL, 'approval alone writes nothing (TrueForge has not executed the tool yet)');
    const r = await api.applyApproved('calc.py', EDITS);
    assert.ok(r.ok, r.message);
    assert.match(r.message, /REJECTED 1 hunk/);
    assert.equal(disk(), ORIGINAL.replace('return a + b', 'return b + a'));
    await until('review tab closed', () => reviewTabs().length === 0);
  });

  await test('Forge: Undo Last Applied Change restores the file', async () => {
    const pending = api.approve(req({ path: 'calc.py', edits: EDITS }));
    const id = idOf(await until('review diff tab', () => reviewTabs()[0]));
    await vscode.commands.executeCommand('forge.review.acceptAll', id);
    await vscode.commands.executeCommand('forge.review.apply', id);
    await pending;
    assert.ok((await api.applyApproved('calc.py', EDITS)).ok);
    assert.notEqual(disk(), ORIGINAL);
    void vscode.commands.executeCommand('forge.undoLast'); // resolves only when its notification is dismissed
    await until('file restored by undo', () => disk() === ORIGINAL);
  });

  await test('reject all → approval denied, workspace unchanged', async () => {
    const pending = api.approve(req({ path: 'calc.py', edits: EDITS }));
    const id = idOf(await until('review diff tab', () => reviewTabs()[0]));
    await vscode.commands.executeCommand('forge.review.rejectAll', id);
    await vscode.commands.executeCommand('forge.review.apply', id);
    const d = await pending;
    assert.equal(d.allow, false);
    assert.match((d as { reason: string }).reason, /rejected all 2 hunk/);
    assert.equal((await api.applyApproved('calc.py', EDITS)).ok, false, 'an unapproved edit cannot be executed');
    assert.equal(disk(), ORIGINAL);
  });

  await test('cancel after approval but before execution → nothing is written', async () => {
    const pending = api.approve(req({ path: 'calc.py', edits: EDITS }));
    const id = idOf(await until('review diff tab', () => reviewTabs()[0]));
    await vscode.commands.executeCommand('forge.review.acceptAll', id);
    await vscode.commands.executeCommand('forge.review.apply', id);
    assert.deepEqual(await pending, { allow: true });
    assert.equal(api.cancelPending(), 1, 'one approved-but-unapplied edit was dropped');
    const r = await api.applyApproved('calc.py', EDITS);
    assert.equal(r.ok, false);
    assert.equal(disk(), ORIGINAL, 'no half-applied edit after cancel');
  });

  await test('file changed on disk after review → edit refused as stale', async () => {
    const pending = api.approve(req({ path: 'calc.py', edits: EDITS }));
    const id = idOf(await until('review diff tab', () => reviewTabs()[0]));
    await vscode.commands.executeCommand('forge.review.acceptAll', id);
    await vscode.commands.executeCommand('forge.review.apply', id);
    await pending;
    const changed = ORIGINAL + '# edited by the user meanwhile\n';
    fs.writeFileSync(file, changed, 'utf8');
    const r = await api.applyApproved('calc.py', EDITS);
    assert.equal(r.ok, false);
    assert.match(r.message, /changed on disk after it was reviewed/);
    assert.equal(disk(), changed);
  });

  await test('edit that deletes an existing function is refused before any diff is shown', async () => {
    const d = await api.approve(req({ path: 'calc.py', edits: [{ old_string: 'def keep():\n    return 1', new_string: 'def other():\n    return 1' }] }));
    assert.equal(d.allow, false);
    assert.match((d as { reason: string }).reason, /would delete existing definition\(s\) keep/);
    assert.equal(reviewTabs().length, 0);
    assert.equal(disk(), ORIGINAL);
  });

  await test('edit that makes the file invalid Python is refused', async () => {
    const d = await api.approve(req({ path: 'calc.py', edits: [{ old_string: '    return a + b', new_string: '    return (a + b' }] }));
    assert.equal(d.allow, false);
    assert.match((d as { reason: string }).reason, /invalid Python/);
    assert.equal(disk(), ORIGINAL);
  });

  await reset();
  const out = process.env.FORGE_UI_RESULT;
  if (out) fs.writeFileSync(out, JSON.stringify({ vscode: vscode.version, results }, null, 1));
  const failed = results.filter(r => !r.ok);
  if (failed.length) throw new Error(`${failed.length} UI test(s) failed: ${failed.map(f => `${f.name}: ${f.error}`).join(' || ')}`);
}
