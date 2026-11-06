import { Workspace } from '../src/mcp/workspace';
import { ContextIndex } from '../src/context/index';
import { retrieve } from '../src/context/retrieve';
(async () => {
  const idx = new ContextIndex(new Workspace(process.argv[2]));
  await idx.refresh();
  const r = retrieve(idx, process.argv[3], { budgetTokens: +(process.argv[4] ?? 6000) });
  console.log(`index ${r.stats.files} files / ${r.stats.chunks} symbols in ${r.stats.indexMs}ms; candidates ${r.stats.candidates}; used ${r.used}/${r.budget}`);
  for (const i of r.items) console.log(`${i.score.toFixed(1).padStart(6)} ${i.tokens.toString().padStart(4)}t ${i.file}:${i.start} ${i.symbol} — ${i.reasons.join('; ')}`);
  console.log('skipped:', r.skipped.slice(0, 5).map(s => `${s.file}::${s.symbol} (${s.why})`).join(' | '));
})();
