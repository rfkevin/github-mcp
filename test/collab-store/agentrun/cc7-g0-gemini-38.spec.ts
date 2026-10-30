import { describe, expect, it, vi } from 'vitest';
import wranglerRaw from '../../../wrangler.jsonc?raw';
import {
  GEMINI_38_FLASH, GEMINI_API_BASE, GEMINI_FREE_MODEL, GEMINI_NO_MINIMAL_MODELS,
  createGeminiAdapter, geminiFreeAttestedFromEnv, geminiThinkingLevel, parseGeminiRef,
} from '../../../src/collab-store/executors/gemini';
import { effortOptions, EFFORTS } from '../../../src/collab-store/agentrun/effort';
import { GEMINI_PROTOCOL } from '../../../src/collab-store/agentrun/gemini-model';
import { okJson } from '../executors/test-helpers';

// CC-7 G0 (décision de Kevin du 2026-10-31, synthèse #1138) — Gemini 3.8 Flash utilisable :
// (1) jamais thinkingLevel « minimal » pour un modèle qui le refuse (doc « What's new in Gemini 3.8 Flash » :
//     low | medium | high, « minimal » renvoie une erreur) ; (2) 3.8 Flash dans la liste gratuite de l'adaptateur
//     consultatif ; (3) attestation du projet gratuit déclarée dans wrangler.jsonc cc3-test, pour qu'un
//     déploiement ne l'efface plus ; (4) gemini sur le canal API, en gratuit seulement.
const wrangler = JSON.parse(wranglerRaw) as { vars: Record<string, string>; env: Record<string, { vars: Record<string, string> }> };
const cc3 = wrangler.env['cc3-test'].vars;

describe('CC-7 G0 — niveau de réflexion par modèle', () => {
  it('3.8 Flash et 4-argon : jamais minimal ; échelle inchangée au-dessus', () => {
    for (const model of [GEMINI_38_FLASH, 'gemini-4-argon']) {
      expect(GEMINI_NO_MINIMAL_MODELS.has(model)).toBe(true);
      expect(EFFORTS.map(e => geminiThinkingLevel(model, e))).toEqual(['low', 'low', 'medium', 'high']);
    }
  });

  it('les autres Gemini 3.x gardent minimal comme niveau le plus léger (comportement L9b inchangé)', () => {
    for (const model of [GEMINI_FREE_MODEL, 'gemini-3.6-flash']) {
      expect(EFFORTS.map(e => geminiThinkingLevel(model, e))).toEqual(['minimal', 'low', 'medium', 'high']);
    }
  });

  it('effort.ts (agents API) suit la même règle, quel que soit le niveau demandé', () => {
    for (const e of EFFORTS) {
      expect(effortOptions('gemini:' + GEMINI_38_FLASH, e)).not.toEqual({ thinkingLevel: 'minimal' });
    }
    expect(effortOptions('gemini:' + GEMINI_38_FLASH, 'low')).toEqual({ thinkingLevel: 'low' });
    expect(effortOptions('gemini:gemini-3.6-flash', 'low')).toEqual({ thinkingLevel: 'minimal' });
  });

  it('protocole des agents API : sans effort choisi, le défaut est le plus léger accepté par le modèle', () => {
    const level = (model: string, requestOptions?: Record<string, unknown>) => {
      const { body } = GEMINI_PROTOCOL.prepare({ model, system: 'S', messages: [{ role: 'user', content: 'q' }],
        tools: [], taskKind: 'answer', schemas: () => [], maxOutputTokens: 64, ...(requestOptions ? { requestOptions } : {}) });
      return (body.generationConfig as { thinkingConfig: { thinkingLevel: string } }).thinkingConfig.thinkingLevel;
    };
    expect(level(GEMINI_38_FLASH)).toBe('low');
    expect(level(GEMINI_FREE_MODEL)).toBe('minimal');
    // Un niveau décidé par effort.ts reste prioritaire.
    expect(level(GEMINI_38_FLASH, { thinkingLevel: 'high' })).toBe('high');
  });
});

describe('CC-7 G0 — adaptateur consultatif', () => {
  it('3.8 Flash accepté comme modèle gratuit, 3.5 Flash-Lite toujours accepté', () => {
    expect(parseGeminiRef('gemini:' + GEMINI_38_FLASH).model).toBe(GEMINI_38_FLASH);
    expect(parseGeminiRef('gemini:' + GEMINI_FREE_MODEL).model).toBe(GEMINI_FREE_MODEL);
  });

  it('appel 3.8 Flash : URL du modèle et thinkingLevel low (pas minimal)', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(GEMINI_API_BASE + '/' + GEMINI_38_FLASH + ':generateContent');
      const body = JSON.parse(String(init?.body)) as { generationConfig: unknown };
      expect(body.generationConfig).toEqual({ maxOutputTokens: 16, thinkingConfig: { thinkingLevel: 'low' } });
      return okJson({ candidates: [{ content: { parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } });
    });
    const adapter = createGeminiAdapter({ LLM_KEY_GEMINI: 'k' }, 'gemini:' + GEMINI_38_FLASH,
      { fetchImpl: fetchImpl as unknown as typeof fetch, freeProjectAttested: true });
    const out = await adapter.generate({ control: 'c', data: 'd', max_tokens: 16 });
    expect(out.model).toBe(GEMINI_38_FLASH);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sans attestation, 3.8 Flash reste bloqué avant tout appel (0 fetch)', () => {
    expect(() => createGeminiAdapter({ LLM_KEY_GEMINI: 'k' }, 'gemini:' + GEMINI_38_FLASH, {}))
      .toThrow(/non attesté/);
  });
});

describe('CC-7 G0 — configuration cc3-test (wrangler.jsonc)', () => {
  it('attestation du projet gratuit déclarée dans le fichier : un déploiement ne l’efface plus', () => {
    expect(cc3.GEMINI_FREE_PROJECT_ATTESTED).toBe('true');
    expect(geminiFreeAttestedFromEnv(cc3)).toBe(true);
  });

  it('jamais d’attestation hors cc3-test : production et autres environnements restent fermés', () => {
    expect(wrangler.vars.GEMINI_FREE_PROJECT_ATTESTED).toBeUndefined();
    expect(geminiFreeAttestedFromEnv({ ...wrangler.vars, GEMINI_FREE_PROJECT_ATTESTED: 'true' })).toBe(false);
    for (const [name, envConfig] of Object.entries(wrangler.env)) {
      if (name !== 'cc3-test') expect(envConfig.vars?.GEMINI_FREE_PROJECT_ATTESTED, name).toBeUndefined();
    }
  });

  it('aucun secret Gemini dans le fichier', () => {
    expect(wranglerRaw).not.toMatch(/LLM_KEY_GEMINI\s*"?\s*:/);
  });

  it('gemini sur le canal API, sans aucune enveloppe payante', () => {
    expect(cc3.AGENT_RUN_PARTICIPANTS.split(',').map(p => p.trim())).toContain('gemini');
    expect(cc3.AGENT_RUN_MODELS_GEMINI.split(',')[0]).toBe('gemini:' + GEMINI_38_FLASH);
    expect(Object.keys(cc3).filter(k => /^AGENT_RUN_PAID_PARTICIPANT_.*GEMINI/.test(k))).toEqual([]);
  });
});
