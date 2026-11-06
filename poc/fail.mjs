import { TrueForge } from '@truefoundry/trueforge-sdk';
const c = new TrueForge({ baseUrl: 'http://localhost:8790', timeoutInSeconds: 120 });
await c.settings.modelProviders.createOrUpdate({ manifest: { type: 'custom', name: 'broken', baseUrl: 'http://127.0.0.1:9/v1',
  auth: { apiKey: 'invalid' }, models: [{ name: 'dead-model', modelId: 'dead-model', properties: { contextLength: 128000, maxOutputTokens: 4096 } }] } }).catch(e => console.log('provider err', e.statusCode, JSON.stringify(e.body ?? e.message)));
const t0 = Date.now();
const { data: s } = await c.sessions.create({ agent: { spec: { model: { name: 'broken/dead-model' }, instructions: 'hi' } } });
const st = await c.sessions.createTurnStream(s.id, { input: [{ type: 'user.message', content: 'hi' }] });
for await (const { data: e } of st.withMetadata()) console.log((Date.now()-t0)+'ms', e.type, e.type==='turn.done'?JSON.stringify(e.state).slice(0,600):'');
