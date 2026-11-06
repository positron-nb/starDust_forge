import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs';
import { EditorMcpServer } from './mcp/server';
import { installReadTools } from './mcp/tools';
import { Workspace } from './mcp/workspace';
import { AgentRunner } from './trueforge/agentRunner';
import { loadAgentSpec } from './trueforge/agentSpec';
import { AgentViewProvider } from './ui/agentView';

let mcp: EditorMcpServer | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const out = vscode.window.createOutputChannel('Forge Agent');
  const log = (m: string) => out.appendLine(`[${new Date().toISOString()}] ${m}`);
  const cfg = () => vscode.workspace.getConfiguration('forge');

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { log('No workspace folder open; Forge Agent is idle.'); return; }
  const ws = new Workspace(folder.uri.fsPath);

  mcp = new EditorMcpServer(server => {
    installReadTools(server, { ws, rgPath: findRipgrep(), onToolCall: (n, a) => log(`tool ${n} ${JSON.stringify(a)}`) });
  }, log);
  await mcp.start();

  // The runner is created lazily so the extension activates even when TrueForge is not running yet.
  let runner: AgentRunner | undefined;
  let runnerKey = '';
  const getRunner = async (): Promise<AgentRunner> => {
    const baseUrl = cfg().get<string>('baseUrl', 'http://localhost:8790');
    const models = cfg().get<string[]>('models', []);
    const name = cfg().get<string>('mcpServerName', 'forge-workspace');
    const key = JSON.stringify([baseUrl, models, name]);
    if (!runner || key !== runnerKey) {
      runner = new AgentRunner({ baseUrl, models, spec: loadAgentSpec(name) });
      runnerKey = key;
      try {
        await mcp!.registerWithTrueForge(runner.sdk, name);
      } catch (err) {
        runner = undefined;
        throw new Error(`Cannot reach TrueForge at ${baseUrl}. Start it with: npx @truefoundry/trueforge@latest  (${(err as Error).message})`);
      }
    }
    return runner;
  };

  const view = new AgentViewProvider(ctx, getRunner, () => cfg().get<string>('baseUrl', 'http://localhost:8790'),
    async req => ({ allow: false, reason: `No reviewer for ${req.toolName} yet.` }));

  ctx.subscriptions.push(
    out,
    vscode.window.registerWebviewViewProvider('forge.agentView', view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('forge.cancel', () => view.cancel()),
    vscode.commands.registerCommand('forge.newSession', () => view.newSession()),
    vscode.commands.registerCommand('forge.showSession', async () => {
      const id = runner?.currentSessionId;
      if (!id) return vscode.window.showInformationMessage('No TrueForge session yet.');
      await vscode.env.openExternal(vscode.Uri.parse(`${cfg().get('baseUrl')}/sessions/${id}`));
    }),
    { dispose: () => void mcp?.stop() },
  );
  log(`Forge Agent active for ${ws.root}`);
}

export async function deactivate(): Promise<void> { await mcp?.stop(); }

/** VS Code ships ripgrep; prefer it, fall back to rg on PATH. */
function findRipgrep(): string {
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  for (const p of [
    path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
    path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
  ]) if (fs.existsSync(p)) return p;
  return 'rg';
}
