/** Workspace sandboxing: every tool path goes through here. No vscode imports (unit-testable). */
import path from 'node:path';
import fs from 'node:fs/promises';

const DENY = [/(^|\/)\.git(\/|$)/, /(^|\/)\.env(\.|$)/, /\.(pem|key|p12|pfx)$/i, /(^|\/)id_(rsa|ed25519)/, /(^|\/)\.trueforge-data(\/|$)/];
export const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', '.mypy_cache', '.pytest_cache', '.tox', '.idea', '.vscode-test']);

export class Workspace {
  readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }

  /** Resolve a model-supplied path; throws if it escapes the workspace or hits a sensitive file. */
  resolve(rel: string): { abs: string; rel: string } {
    if (typeof rel !== 'string' || rel.trim() === '') throw new Error('path is required');
    const abs = path.resolve(this.root, rel.replace(/^[/\\]+/, ''));
    const r = path.relative(this.root, abs);
    if (r.startsWith('..') || path.isAbsolute(r)) throw new Error(`path "${rel}" is outside the workspace`);
    const norm = r.split(path.sep).join('/');
    if (DENY.some(d => d.test(norm))) throw new Error(`access to "${norm}" is denied (sensitive path)`);
    return { abs, rel: norm || '.' };
  }

  async read(rel: string): Promise<string> {
    const { abs } = this.resolve(rel);
    const st = await fs.stat(abs);
    if (st.size > 2_000_000) throw new Error('file larger than 2 MB');
    return fs.readFile(abs, 'utf8');
  }

  async exists(rel: string): Promise<boolean> {
    try { await fs.access(this.resolve(rel).abs); return true; } catch { return false; }
  }

  /** Recursive listing (respecting IGNORED_DIRS), capped. */
  async list(rel = '.', maxDepth = 3, cap = 400): Promise<string[]> {
    const start = this.resolve(rel);
    const out: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (out.length >= cap) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= cap) return;
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        const r = path.relative(this.root, abs).split(path.sep).join('/');
        out.push(e.isDirectory() ? r + '/' : r);
        if (e.isDirectory() && depth < maxDepth) await walk(abs, depth + 1);
      }
    };
    await walk(start.abs, 1);
    return out;
  }
}
