/**
 * Opens the Flask checkout in a real VS Code (installed Code.exe, throwaway profile) with this
 * extension loaded, and runs test-ui/demo.ts (the demo driver) inside it.
 *   node out/demo-run.js <A|B|C> <flaskDir> <demoDir> <modelsJson>
 */
import fs from 'node:fs';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

(async () => {
  const [take, flask, dir, models] = process.argv.slice(2);
  const ext = path.resolve(__dirname, '..');
  const user = path.join(dir, `profile-${take}`);
  fs.rmSync(user, { recursive: true, force: true });
  fs.mkdirSync(path.join(user, 'User'), { recursive: true });
  fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({
    'window.newWindowDimensions': 'maximized',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'chat.disableAIFeatures': true,
    'security.workspace.trust.enabled': false,
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
    'extensions.ignoreRecommendations': true,
    'git.openRepositoryInParentFolders': 'never',
    'editor.fontSize': 15,
    'editor.minimap.enabled': false,
    'terminal.integrated.fontSize': 14,
    'forge.models': JSON.parse(models),
    'forge.profile': 'lean',
    'forge.compactAtTokens': 100000,
    'forge.autoApproveCommands': [
      '^(python -m )?pytest(\\s|$)',
      '^(python -m )?flask( --app \\S+)? (--help|routes|config)\\b',
      '^git (status|diff|log)\\b',
      '^python -c ',
      '.*',
    ],
  }, null, 2));
  const exe = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  await runTests({
    vscodeExecutablePath: exe,
    extensionDevelopmentPath: ext,
    extensionTestsPath: path.join(ext, 'out', 'demo-suite.js'),
    extensionTestsEnv: { FORGE_DEMO_TAKE: take, FORGE_DEMO_DIR: dir },
    launchArgs: [flask, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
      '--user-data-dir', user, '--extensions-dir', path.join(dir, 'exts')],
  }).catch(e => console.error(String((e as Error).message ?? e)));
})();
