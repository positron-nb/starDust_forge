/**
 * Diff review in the editor. Each Proposal opens as a native diff editor
 * (original ↔ proposed, both virtual documents — nothing touches disk). Hunks are
 * decorated by state; the user accepts/rejects per hunk (CodeLens, Alt+Y / Alt+N at
 * the cursor, or the agent panel's review card) and then applies the decisions.
 */
import * as vscode from 'vscode';
import type { ChangeManager, Proposal } from '../changes/changeManager';
import type { Hunk } from '../changes/hunks';
import { summarize } from '../changes/hunks';

export const SCHEME = 'forge-review';

export class ReviewController implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider {
  private waiting = new Map<string, (outcome: 'apply' | 'cancel') => void>();
  private changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private deco = {
    pending: vscode.window.createTextEditorDecorationType({ isWholeLine: true, borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('editorInfo.foreground'),
      after: { contentText: '  ◆ pending review (Alt+Y accept · Alt+N reject)', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' } }),
    accepted: vscode.window.createTextEditorDecorationType({ isWholeLine: true, borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('testing.iconPassed'),
      after: { contentText: '  ✓ accepted', color: new vscode.ThemeColor('testing.iconPassed') } }),
    rejected: vscode.window.createTextEditorDecorationType({ isWholeLine: true, opacity: '0.45', textDecoration: 'line-through', borderWidth: '0 0 0 3px', borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('testing.iconFailed'), after: { contentText: '  ✗ rejected — will not be applied', color: new vscode.ThemeColor('testing.iconFailed'), textDecoration: 'none' } }),
  };

  constructor(private readonly changes: ChangeManager, private readonly onUpdate: (p: Proposal) => void) {
    changes.listeners.add(p => { this.refresh(p); this.onUpdate(p); });
  }

  register(ctx: vscode.ExtensionContext): void {
    const at = (args: unknown[]): { id: string; index?: number } | undefined => {
      if (typeof args[0] === 'string') return { id: args[0], index: typeof args[1] === 'number' ? args[1] : undefined };
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.uri.scheme !== SCHEME) return undefined;
      const id = this.idOf(ed.document.uri);
      const p = this.changes.get(id);
      const line = ed.selection.active.line + 1;
      const h = p?.set.hunks.find(x => line >= x.newStart - (x.added.length ? 0 : 1) && line <= x.newStart + Math.max(x.added.length, 1) - 1) ?? p?.set.hunks.find(x => x.state === 'pending');
      return { id, index: h?.index };
    };
    ctx.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, this),
      ...Object.values(this.deco),
      vscode.window.onDidChangeVisibleTextEditors(() => { for (const id of this.waiting.keys()) { const p = this.changes.get(id); if (p) this.decorate(p); } }),
      vscode.commands.registerCommand('forge.review.acceptHunk', (...a) => { const t = at(a); if (t?.index !== undefined) { this.changes.setHunk(t.id, t.index, 'accepted'); this.nextPending(t.id); } }),
      vscode.commands.registerCommand('forge.review.rejectHunk', (...a) => { const t = at(a); if (t?.index !== undefined) { this.changes.setHunk(t.id, t.index, 'rejected'); this.nextPending(t.id); } }),
      vscode.commands.registerCommand('forge.review.acceptAll', (...a) => { const t = at(a); if (t) this.changes.setAll(t.id, 'accepted'); }),
      vscode.commands.registerCommand('forge.review.rejectAll', (...a) => { const t = at(a); if (t) this.changes.setAll(t.id, 'rejected'); }),
      vscode.commands.registerCommand('forge.review.apply', (...a) => { const t = at(a); if (t) this.complete(t.id, 'apply'); }),
      vscode.commands.registerCommand('forge.review.open', (id: string) => { const p = this.changes.get(id); if (p) void this.open(p); }),
    );
  }

  /** Called during a TrueForge approval pause. Resolves when the user applies or the run is cancelled. */
  async review(p: Proposal): Promise<'apply' | 'cancel'> {
    const done = new Promise<'apply' | 'cancel'>(resolve => this.waiting.set(p.id, resolve));
    this.onUpdate(p);
    await this.open(p);
    return done;
  }

  cancelAll(): void { for (const id of [...this.waiting.keys()]) this.complete(id, 'cancel'); }

  private complete(id: string, outcome: 'apply' | 'cancel'): void {
    const resolve = this.waiting.get(id);
    if (!resolve) return;
    const p = this.changes.get(id);
    if (outcome === 'apply' && p && summarize(p.set).pending > 0) {
      void vscode.window.showWarningMessage(`${summarize(p.set).pending} hunk(s) still pending — they will be treated as rejected.`, { modal: true }, 'Apply anyway').then(c => {
        if (c === 'Apply anyway') { this.waiting.delete(id); resolve('apply'); void this.close(id); }
      });
      return;
    }
    this.waiting.delete(id);
    resolve(outcome);
    void this.close(id);
  }

  private uri(p: Proposal, side: 'original' | 'proposed'): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: `/${p.id}/${side}/${p.path}` });
  }
  private idOf(u: vscode.Uri): string { return u.path.split('/')[1]; }

  private async open(p: Proposal): Promise<void> {
    const n = p.set.hunks.length;
    await vscode.commands.executeCommand('vscode.diff', this.uri(p, 'original'), this.uri(p, 'proposed'),
      `Forge review: ${p.path}${p.isNew ? ' (new file)' : ''} — ${n} hunk${n === 1 ? '' : 's'}`, { preview: false });
    this.decorate(p);
  }

  private async close(id: string): Promise<void> {
    for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) {
      const inp = t.input as { modified?: vscode.Uri } | undefined;
      if (inp?.modified?.scheme === SCHEME && this.idOf(inp.modified) === id) await vscode.window.tabGroups.close(t);
    }
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const p = this.changes.get(this.idOf(uri));
    if (!p) return '';
    return uri.path.split('/')[2] === 'original' ? p.original : p.proposed;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const id = this.idOf(doc.uri);
    const p = this.changes.get(id);
    if (!p || doc.uri.path.split('/')[2] !== 'proposed' || p.status !== 'reviewing') return [];
    const s = summarize(p.set);
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, { title: `Forge: ${s.accepted}✓ ${s.rejected}✗ ${s.pending} pending — Apply decisions`, command: 'forge.review.apply', arguments: [id] }),
      new vscode.CodeLens(top, { title: 'Accept all', command: 'forge.review.acceptAll', arguments: [id] }),
      new vscode.CodeLens(top, { title: 'Reject all', command: 'forge.review.rejectAll', arguments: [id] }),
    ];
    for (const h of p.set.hunks) {
      const r = this.range(doc, h);
      lenses.push(new vscode.CodeLens(r, { title: `Hunk ${h.index + 1}/${p.set.hunks.length} [${h.state}]: ✓ Accept`, command: 'forge.review.acceptHunk', arguments: [id, h.index] }));
      lenses.push(new vscode.CodeLens(r, { title: '✗ Reject', command: 'forge.review.rejectHunk', arguments: [id, h.index] }));
    }
    return lenses;
  }

  private range(doc: vscode.TextDocument, h: Hunk): vscode.Range {
    const start = Math.min(Math.max(0, h.newStart - 1 - (h.added.length ? 0 : 1)), Math.max(0, doc.lineCount - 1));
    const end = Math.min(start + Math.max(h.added.length, 1) - 1, Math.max(0, doc.lineCount - 1));
    return new vscode.Range(start, 0, end, 0);
  }

  private refresh(p: Proposal): void {
    this.lensEmitter.fire();
    this.decorate(p);
  }

  private decorate(p: Proposal): void {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== SCHEME || this.idOf(ed.document.uri) !== p.id || ed.document.uri.path.split('/')[2] !== 'proposed') continue;
      for (const state of ['pending', 'accepted', 'rejected'] as const) {
        ed.setDecorations(this.deco[state], p.status === 'reviewing' ? p.set.hunks.filter(h => h.state === state).map(h => this.range(ed.document, h)) : []);
      }
    }
  }

  private nextPending(id: string): void {
    const p = this.changes.get(id);
    const next = p?.set.hunks.find(h => h.state === 'pending');
    const ed = vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === SCHEME && this.idOf(e.document.uri) === id && e.document.uri.path.includes('/proposed/'));
    if (next && ed) { const r = this.range(ed.document, next); ed.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport); ed.selection = new vscode.Selection(r.start, r.start); }
  }
}

/** FileIO backed by the editor: writes are WorkspaceEdits (so Ctrl+Z works) followed by a save. */
export const vscodeIO = {
  async read(abs: string): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath.toLowerCase() === abs.toLowerCase());
    if (open) return open.getText();
    try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(abs))); } catch { return undefined; }
  },
  async write(abs: string, text: string): Promise<void> {
    const uri = vscode.Uri.file(abs);
    let exists = true;
    try { await vscode.workspace.fs.stat(uri); } catch { exists = false; }
    const we = new vscode.WorkspaceEdit();
    if (!exists) { we.createFile(uri, { ignoreIfExists: true, contents: new TextEncoder().encode(text) }); await vscode.workspace.applyEdit(we); return; }
    const doc = await vscode.workspace.openTextDocument(uri);
    we.replace(uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount + 1, 0)), text);
    if (!(await vscode.workspace.applyEdit(we))) throw new Error(`VS Code refused the edit to ${abs}`);
    await doc.save();
  },
  async remove(abs: string): Promise<void> { await vscode.workspace.fs.delete(vscode.Uri.file(abs), { useTrash: false }); },
};
