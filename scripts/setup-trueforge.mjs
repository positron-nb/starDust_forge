#!/usr/bin/env node
/**
 * Registers model providers (from config/models.json, or the example file) and the
 * forge-coder agent definition with a LOCAL TrueForge via its HTTP API.
 * Usage: node scripts/setup-trueforge.mjs [--only-broken]
 *   --only-broken  register just the unreachable "broken" provider used for Task C
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const onlyBroken = process.argv.includes('--only-broken');
const cfgPath = fs.existsSync(path.join(root, 'config/models.json')) ? 'config/models.json' : 'config/models.example.json';
const cfg = JSON.parse(fs.readFileSync(path.join(root, cfgPath), 'utf8'));

async function call(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith('_') ? undefined : v)));

for (const p of cfg.providers) {
  const isPlaceholder = JSON.stringify(p.auth ?? {}).includes('YOUR_');
  if (p._optional && !process.argv.includes('--with-optional') && !onlyBroken) { console.log(`skip optional ${p.name}`); continue; }
  if (onlyBroken ? p.name !== 'broken' : isPlaceholder) { if (!onlyBroken) console.log(`skip ${p.name ?? p.type} (placeholder key — set it in config/models.json or the TrueForge UI)`); continue; }
  await call('PUT', '/api/v1/settings/model-providers', { manifest: strip(p) });
  console.log(`✓ model provider ${p.name ?? p.type}`);
}

if (!onlyBroken) {
  const agent = JSON.parse(fs.readFileSync(path.join(root, 'agent/forge-coder.json'), 'utf8'));
  const model = cfg.vscode_settings_example?.['forge.models']?.[0] ?? 'google-gemini/gemini-3-5-flash';
  const manifest = { ...agent.manifest, model: { name: model } };
  const existing = (await call('GET', '/api/v1/agents')).data?.find(a => a.name === agent.name);
  if (existing) await call('PUT', `/api/v1/agents/${existing.id}`, { manifest });
  else await call('POST', '/api/v1/agents', { name: agent.name, description: agent.description, manifest });
  console.log(`✓ agent "${agent.name}" saved in TrueForge (visible under Agents). The extension sends the same spec inline per session so it can switch models for fallback.`);
}
