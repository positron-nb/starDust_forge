#!/usr/bin/env node
/**
 * Benchmark metrics from real TrueForge session events (no estimates):
 * model requests, input/output tokens (provider-reported usage), tool calls by name,
 * failed tool results, provider errors, wall time.
 *
 *   node scripts/session-metrics.mjs <e2e log file | session id ...> [--base http://localhost:8790]
 * Session ids are taken from "[session] http://.../sessions/<id> (model)" lines of an e2e log.
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const bi = argv.indexOf('--base');
const base = bi >= 0 ? argv.splice(bi, 2)[1] : 'http://localhost:8790';
const ids = [];
for (const a of argv) {
  if (fs.existsSync(a)) for (const m of fs.readFileSync(a, 'utf8').matchAll(/sessions\/(\w+) \(([^)]+)\)/g)) ids.push([m[1], m[2]]);
  else ids.push([a, '?']);
}

async function events(id) {
  const out = [];
  let tok;
  do {
    const u = new URL(`${base}/api/v1/sessions/${id}/events`);
    u.searchParams.set('limit', '100');
    if (tok) u.searchParams.set('page_token', tok);
    const j = await (await fetch(u)).json();
    out.push(...(j.data ?? []).map(d => d.event));
    tok = j.pagination?.next_page_token;
  } while (tok);
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

const rows = [];
for (const [id, model] of ids) {
  const ev = await events(id);
  const r = { model, session: id.slice(-8), requests: 0, in_tok: 0, out_tok: 0, max_in: 0, cached: 0, tool_calls: 0, tool_errors: 0, model_errors: 0, compactions: 0, dup_reads: 0, secs: 0 };
  const seen = new Set();
  const names = {};
  for (const e of ev) {
    if (e.type === 'model.message') {
      r.requests++;
      const u = e.usage ?? {};
      const inp = u.prompt_tokens ?? u.input_tokens ?? 0;
      r.in_tok += inp; r.max_in = Math.max(r.max_in, inp);
      r.out_tok += u.completion_tokens ?? u.output_tokens ?? 0;
      r.cached += u.prompt_tokens_details?.cached_tokens ?? 0;
      for (const t of e.tool_calls ?? []) {
        r.tool_calls++; names[t.function?.name] = (names[t.function?.name] ?? 0) + 1;
        let a = {}; try { a = JSON.parse(t.function?.arguments ?? '{}'); } catch { /* */ }
        const reqs = t.function?.name === 'read_file' ? [a] : t.function?.name === 'read_files' ? (a.requests ?? []) : [];
        for (const q of reqs) { const k = `${q.path}:${q.start_line ?? 1}-${q.end_line ?? ''}`; if (seen.has(k)) r.dup_reads++; seen.add(k); }
      }
    }
    if (e.type === 'tool.response' && /"error"|could not be applied|Refused|not found in the file/i.test(String(e.content).slice(0, 400))) r.tool_errors++;
    if (e.type === 'turn.done' && e.state?.status === 'error') r.model_errors++;
    if (e.type === 'thread.context_compaction_started') r.compactions++;
  }
  if (ev.length) r.secs = Math.round((Date.parse(ev.at(-1).created_at) - Date.parse(ev[0].created_at)) / 1000);
  r.tools = Object.entries(names).map(([k, v]) => `${k}×${v}`).join(' ');
  rows.push(r);
}
for (const r of rows) console.log(JSON.stringify(r));
const tot = k => rows.reduce((a, r) => a + r[k], 0);
console.log(`TOTAL requests=${tot('requests')} in=${tot('in_tok')} out=${tot('out_tok')} cached=${tot('cached')} tool_calls=${tot('tool_calls')} tool_errors=${tot('tool_errors')} model_errors=${tot('model_errors')} compactions=${tot('compactions')} dup_reads=${tot('dup_reads')} secs=${tot('secs')}`);
