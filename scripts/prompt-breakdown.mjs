#!/usr/bin/env node
/**
 * Prompt-token breakdown of dumped OpenAI-style requests (from reasoning-shim --dump).
 * Tokens are estimated as chars/4 (same heuristic TrueForge uses).
 *   node scripts/prompt-breakdown.mjs <dumpDir> [--tools]
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const showTools = process.argv.includes('--tools');
const tok = s => Math.round((typeof s === 'string' ? s : JSON.stringify(s ?? '')).length / 4);
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
const rows = [];
for (const f of files) {
  const b = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const r = { req: f.replace(/\D/g, ''), system: 0, tools: tok(b.tools), user: 0, assistant: 0, tool_results: 0, nTools: (b.tools ?? []).length, nMsgs: b.messages.length };
  for (const m of b.messages) {
    const t = tok(m.content) + (m.tool_calls ? tok(m.tool_calls) : 0);
    if (m.role === 'system') r.system += t; else if (m.role === 'tool') r.tool_results += t; else if (m.role === 'assistant') r.assistant += t; else r.user += t;
  }
  r.total = r.system + r.tools + r.user + r.assistant + r.tool_results;
  rows.push(r);
}
console.table(rows);
const sum = k => rows.reduce((a, r) => a + r[k], 0);
const total = sum('total');
console.log(`requests=${rows.length} total≈${total} tok; share: system ${Math.round(100 * sum('system') / total)}% · tools ${Math.round(100 * sum('tools') / total)}% · user ${Math.round(100 * sum('user') / total)}% · assistant ${Math.round(100 * sum('assistant') / total)}% · tool results ${Math.round(100 * sum('tool_results') / total)}%`);
if (showTools && files.length) {
  const b = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  console.log('\nper-tool schema size (last request):');
  for (const t of b.tools ?? []) console.log(`  ${String(tok(t)).padStart(6)}  ${t.function?.name}`);
  const sys = b.messages.find(m => m.role === 'system');
  if (sys) console.log(`\nsystem prompt ≈${tok(sys.content)} tok; first 400 chars:\n${String(sys.content).slice(0, 400)}`);
}
