/**
 * Inline edit (Ctrl+Alt+E): select code, describe the change. A short-lived TrueForge
 * session (same agent definition + MCP tools, inline-specific instructions) proposes the
 * edit through propose_edit; the proposal opens in the hunk-review diff. Progress
 * streams into a cancellable notification and the agent panel.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import type { AgentRunner } from '../trueforge/agentRunner';
import type { AgentViewProvider } from './agentView';
export { INLINE_INSTRUCTIONS } from '../trueforge/inlinePrompt';

export function registerInlineEdit(ctx: vscode.ExtensionContext, deps: {
  root: string;
  view: AgentViewProvider;
  makeRunner: () => Promise<AgentRunner>;
}): void {
  ctx.subscriptions.push(vscode.commands.registerCommand('forge.inlineEdit', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') return vscode.window.showInformationMessage('Forge: open a file and select code to edit.');
    if (deps.view.isRunning) return vscode.window.showWarningMessage('Forge: a run is already in progress — cancel it first (Ctrl+Shift+Esc).');
    const sel: vscode.Range = ed.selection.isEmpty ? ed.document.lineAt(ed.selection.active.line).range : ed.selection;
    const start = sel.start.line + 1, end = sel.end.line + (sel.end.character === 0 && sel.end.line > sel.start.line ? 0 : 1);
    const full = new vscode.Range(start - 1, 0, end - 1, ed.document.lineAt(end - 1).text.length);
    const selected = ed.document.getText(full);
    const rel = path.relative(deps.root, ed.document.uri.fsPath).split(path.sep).join('/');
    if (rel.startsWith('..')) return vscode.window.showWarningMessage('Forge: the file is outside the workspace.');

    const instruction = await vscode.window.showInputBox({
      title: `Forge inline edit — ${rel}:${start}-${end}`,
      prompt: 'Describe the change for the selected code',
      placeHolder: 'e.g. Treat "off" and "n" as false as well…',
      ignoreFocusOut: true,
    });
    if (!instruction?.trim()) return;
    if (ed.document.isDirty) await ed.document.save(); // review compares against disk; save user edits first

    const lang = ed.document.languageId;
    const message = `File: ${rel} (lines ${start}-${end}, ${lang})\nInstruction: ${instruction.trim()}\n\nSelected code:\n\`\`\`${lang}\n${selected}\n\`\`\``;
    const runner = await deps.makeRunner().catch(e => { void vscode.window.showErrorMessage(`Forge: ${(e as Error).message}`); return undefined; });
    if (!runner) return;

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Forge inline edit (${rel})`, cancellable: true }, async (progress, token) => {
      token.onCancellationRequested(() => void deps.view.cancel());
      progress.report({ message: `asking ${runner.currentModel} via TrueForge…` });
      const r = await deps.view.runTask(runner, `✏️ Inline edit ${rel}:${start}-${end} — ${instruction.trim()}`, message, 'inline', [], s => progress.report({ message: s.length > 90 ? s.slice(0, 87) + '…' : s }));
      if (r?.status === 'error') void vscode.window.showErrorMessage(`Forge inline edit failed: ${r.error} No files were changed.`);
      if (r?.status === 'cancelled') void vscode.window.showWarningMessage('Forge inline edit cancelled. No files were changed.');
    });
  }));
}
