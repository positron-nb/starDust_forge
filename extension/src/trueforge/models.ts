/**
 * Which models to run. `forge.models` is an ordered fallback list of TrueForge model names
 * ("provider/model"). When it is empty, the extension uses the models configured in TrueForge
 * itself, so it works with whatever model TrueForge has without touching VS Code settings.
 * Names in `forge.models` that TrueForge does not know are reported, and kept, so the runner's
 * normal fallback (with a clear "not configured" message) still applies.
 */
export interface ProviderListing { name: string; models: Array<{ name: string }> }

export const AUTO_MODEL_LIMIT = 3;

export function resolveModels(configured: string[], providers: ProviderListing[]): { models: string[]; note?: string } {
  const available = providers.flatMap(p => p.models.map(m => `${p.name}/${m.name}`));
  const wanted = configured.map(s => s.trim()).filter(Boolean);
  if (wanted.length) {
    const unknown = available.length ? wanted.filter(m => !available.includes(m)) : [];
    return { models: wanted, note: unknown.length ? `Not configured in TrueForge: ${unknown.join(', ')} (they will fail and fall back). Configured: ${available.slice(0, 8).join(', ')}${available.length > 8 ? ', …' : ''}` : undefined };
  }
  if (!available.length) return { models: [], note: 'No model is configured in TrueForge. Add one in TrueForge → Settings → Models.' };
  const models = available.slice(0, AUTO_MODEL_LIMIT);
  return { models, note: `forge.models is empty: using the models configured in TrueForge, in this fallback order: ${models.join(' → ')}.` };
}
