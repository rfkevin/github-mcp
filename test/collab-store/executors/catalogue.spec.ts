import { describe, expect, it } from 'vitest';
import {
  MODEL_CANDIDATES, catalogueCandidate, catalogueExecutionGate,
} from '../../../src/collab-store/executors/catalogue';

describe('R4 catalogue multi-fournisseurs dormant', () => {
  it('ne donne jamais une sonde ou un dispatch via le catalogue', () => {
    expect(MODEL_CANDIDATES.length).toBeGreaterThanOrEqual(10);
    for (const item of MODEL_CANDIDATES) {
      expect(item.catalogue_only).toBe(true);
      expect(item.probe_allowed).toBe(false);
      expect(item.dispatch_allowed).toBe(false);
      expect(catalogueExecutionGate(item.ref).allowed).toBe(false);
    }
  });

  it('sépare les candidats Free des modèles payants et non vérifiés', () => {
    for (const item of MODEL_CANDIDATES) {
      expect(item.paid_disabled).toBe(item.tier !== 'free');
      if (item.tier !== 'free') {
        expect(catalogueExecutionGate(item.ref)).toEqual({
          allowed: false, reason: 'paid_or_unverified',
        });
      } else {
        expect(catalogueExecutionGate(item.ref)).toEqual({
          allowed: false, reason: 'catalogue_only',
        });
      }
    }
    expect(catalogueExecutionGate('openrouter:unknown/expensive'))
      .toEqual({ allowed: false, reason: 'unknown_model' });
  });

  it('préserve la distinction API directe / agrégateur / Workers AI', () => {
    expect(catalogueCandidate('deepseek:deepseek-flash')?.provider).toBe('deepseek');
    expect(catalogueCandidate('openrouter:deepseek/deepseek-v4-flash:free')?.provider)
      .toBe('openrouter');
    expect(catalogueCandidate('workers-ai:@cf/deepseek-ai/deepseek-v4-flash-0731')?.provider)
      .toBe('workers-ai');
    const refs = MODEL_CANDIDATES.map(x => x.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('montre les pools de quota partagés et les noms de secrets sans aucune valeur', () => {
    const cf = MODEL_CANDIDATES.filter(x => x.provider === 'workers-ai');
    expect(new Set(cf.map(x => x.quota_pool)).size).toBe(1);
    expect(cf.every(x => x.secret_name === 'AI')).toBe(true);
    const or = MODEL_CANDIDATES.filter(x => x.provider === 'openrouter');
    expect(or.every(x => x.secret_name === 'LLM_KEY_OPENROUTER')).toBe(true);
    expect(or.every(x => x.credential_contract === 'existing-secret')).toBe(true);
    expect(MODEL_CANDIDATES.find(x => x.provider === 'groq')?.credential_contract)
      .toBe('proposed-secret');
    expect(MODEL_CANDIDATES.every(x => x.source_url.startsWith('https://'))).toBe(true);
  });

  it('est immuable au runtime : impossible d activer par mutation', () => {
    expect(Object.isFrozen(MODEL_CANDIDATES)).toBe(true);
    expect(Object.isFrozen(MODEL_CANDIDATES[0])).toBe(true);
    expect(catalogueCandidate('openrouter:qwen/qwen3.5-flash-02-23')?.paid_disabled)
      .toBe(true);
    expect(catalogueCandidate('no-such-model')).toBeNull();
  });
});
