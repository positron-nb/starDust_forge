import { describe, it, expect } from 'vitest';
import { resolveModels } from '../src/trueforge/models';

const providers = [
  { name: 'openrouter', models: [{ name: 'nemotron-ultra' }, { name: 'gemma4-31b' }] },
  { name: 'google-gemini', models: [{ name: 'gemini-3-5-flash' }, { name: 'gemini-3-1-flash-lite' }] },
];

describe('model resolution', () => {
  it('empty forge.models → models configured in TrueForge, max 3, in TrueForge order', () => {
    const r = resolveModels([], providers);
    expect(r.models).toEqual(['openrouter/nemotron-ultra', 'openrouter/gemma4-31b', 'google-gemini/gemini-3-5-flash']);
    expect(r.note).toMatch(/using the models configured in TrueForge/);
  });
  it('explicit list is kept in order; unknown names are reported but kept (runner falls back)', () => {
    const r = resolveModels(['broken/dead-model', 'google-gemini/gemini-3-5-flash'], providers);
    expect(r.models).toEqual(['broken/dead-model', 'google-gemini/gemini-3-5-flash']);
    expect(r.note).toMatch(/Not configured in TrueForge: broken\/dead-model/);
  });
  it('explicit known list has no note', () => {
    expect(resolveModels(['openrouter/nemotron-ultra'], providers).note).toBeUndefined();
  });
  it('nothing configured anywhere → empty with a clear note', () => {
    const r = resolveModels([], []);
    expect(r.models).toEqual([]);
    expect(r.note).toMatch(/No model is configured/);
  });
});
