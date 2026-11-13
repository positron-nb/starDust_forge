/**
 * Launches a real VS Code (the installed one if found, otherwise a downloaded build) with an
 * isolated profile, loads this extension and runs test-ui/suite.ts inside the extension host.
 *   npm run test:ui          (set VSCODE_EXE to use a specific Code executable)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

(async () => {
  const ext = path.resolve(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ui-'));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'calc.py'), 'placeholder\n');
  const result = path.join(tmp, 'result.json');
  const candidates = [process.env.VSCODE_EXE, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', '/usr/share/code/code'].filter((p): p is string => !!p && fs.existsSync(p));
  let code = 0;
  try {
    await runTests({
      vscodeExecutablePath: candidates[0],
      extensionDevelopmentPath: ext,
      extensionTestsPath: path.join(ext, 'out', 'ui-suite.js'),
      extensionTestsEnv: { FORGE_UI_RESULT: result },
      launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
        '--user-data-dir', path.join(tmp, 'user'), '--extensions-dir', path.join(tmp, 'exts')],
    });
  } catch (e) { code = 1; console.error(String((e as Error).message ?? e)); }
  if (fs.existsSync(result)) {
    const r = JSON.parse(fs.readFileSync(result, 'utf8')) as { vscode: string; results: Array<{ name: string; ok: boolean; error?: string }> };
    console.log(`\nVS Code ${r.vscode} — UI integration tests`);
    for (const t of r.results) console.log(`  ${t.ok ? '✓' : '✗'} ${t.name}${t.error ? `\n      ${t.error}` : ''}`);
    console.log(`${r.results.filter(t => t.ok).length}/${r.results.length} passed`);
    if (process.env.FORGE_UI_REPORT) fs.copyFileSync(result, process.env.FORGE_UI_REPORT);
  } else { code = 1; console.error('No result file was written: the suite did not run.'); }
  process.exit(code);
})();
