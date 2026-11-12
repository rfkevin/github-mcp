import { describe, expect, it } from 'vitest';
import { chooseContinuation, type NativeContinuationReference } from '../../../src/collab-store/agentrun/provider-continuity';

const native: NativeContinuationReference = {
  provider: 'gemini', model: 'example-model', kind: 'server_session', reference: 'opaque-session-value',
};

describe('CC8 — contrat universel de continuité des fournisseurs', () => {
  it('réutilise la session native seulement avec le même fournisseur, modèle et protocole explicitement activé', () => {
    expect(chooseContinuation({ provider: 'gemini', model: 'example-model', nativeKinds: ['server_session'] }, native))
      .toEqual({ mode: 'native', reference: native });
  });
  it('un passage vers un autre fournisseur ne transmet jamais son état opaque', () => {
    for (const provider of ['zai', 'anthropic', 'openai', 'xai', 'workers-ai', 'openrouter', 'groq',
      'deepseek', 'future-provider-not-listed-in-cc8']) {
      expect(chooseContinuation({ provider, model: 'example-model', nativeKinds: ['server_session'] }, native))
        .toEqual({ mode: 'portable', reason: 'provider_changed' });
    }
  });
  it('un autre modèle, même chez le fournisseur, reçoit la continuité D1 portable', () => {
    expect(chooseContinuation({ provider: 'gemini', model: 'other-model', nativeKinds: ['server_session'] }, native))
      .toEqual({ mode: 'portable', reason: 'model_changed' });
  });
  it('un protocole non supporté ou une session absente ne devient jamais une permission implicite', () => {
    expect(chooseContinuation({ provider: 'gemini', model: 'example-model' }, native))
      .toEqual({ mode: 'portable', reason: 'unsupported_protocol' });
    expect(chooseContinuation({ provider: 'future-provider', model: 'v1' }, null))
      .toEqual({ mode: 'portable', reason: 'no_native_state' });
  });
});
