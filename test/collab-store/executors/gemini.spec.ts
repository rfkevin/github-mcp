import { describe, expect, it, vi } from 'vitest';
import {
  GEMINI_API_BASE,
  GEMINI_CC3_TEST_PUBLIC_ORIGIN,
  GEMINI_FREE_MODEL,
  GEMINI_LEGACY_25_FLASH_LITE,
  createGeminiAdapter,
  geminiFreeAttestedFromEnv,
  geminiProviderOf,
  parseGeminiRef,
} from '../../../src/collab-store/executors/gemini';
import { providerAdapterFactory } from '../../../src/collab-store/executors/run';
import {
  countingStatusFetch, expectCode, expectRejectCode, hangFetch, okJson,
} from './test-helpers';

const freeOk = { freeProjectAttested: true as const };
const freeRef = 'gemini:' + GEMINI_FREE_MODEL;

/** Env TEST complet : attestation + origin CC3-test. */
const testEnvOk = {
  LLM_KEY_GEMINI: 'gemini-secret',
  GEMINI_FREE_PROJECT_ATTESTED: 'true',
  PUBLIC_ORIGIN: GEMINI_CC3_TEST_PUBLIC_ORIGIN,
} as const;

const endpointStub = {
  endpoint_id: 'ep-gemini',
  principal_id: 'gemini-35-flash-lite',
  status: 'probe_required',
  attestation_kind: 'provider_adapter',
  attestation_ref: freeRef,
  capability_set: { tools: ['llm.generate'], network_providers: ['gemini'], token_ceiling: 256 },
  notes: '',
  created_at: '',
  updated_at: '',
} as never;

describe('R4 A — Gemini Free (3.5 Flash-Lite)', () => {
  it('préfixe et Free model = gemini-3.5-flash-lite', () => {
    expect(GEMINI_FREE_MODEL).toBe('gemini-3.5-flash-lite');
    expect(geminiProviderOf(freeRef)).toBe('gemini');
    expect(geminiProviderOf('openrouter:x')).toBeNull();
    expect(parseGeminiRef(freeRef).model).toBe(GEMINI_FREE_MODEL);
  });

  it('2.5-flash-lite hors allowlist (nouveaux projets restreints)', () => {
    expectCode(
      () => parseGeminiRef('gemini:' + GEMINI_LEGACY_25_FLASH_LITE),
      'EXECUTOR_UNSUPPORTED',
    );
  });

  it('geminiFreeAttestedFromEnv : true + origin CC3-test uniquement', () => {
    expect(geminiFreeAttestedFromEnv({})).toBe(false);
    expect(geminiFreeAttestedFromEnv({
      GEMINI_FREE_PROJECT_ATTESTED: 'true',
    })).toBe(false);
    expect(geminiFreeAttestedFromEnv({
      GEMINI_FREE_PROJECT_ATTESTED: 'true',
      PUBLIC_ORIGIN: GEMINI_CC3_TEST_PUBLIC_ORIGIN,
    })).toBe(true);
    expect(geminiFreeAttestedFromEnv({
      GEMINI_FREE_PROJECT_ATTESTED: 'true',
      PUBLIC_ORIGIN: 'https://github-mcp.rfahedkevin.workers.dev',
    })).toBe(false);
    expect(geminiFreeAttestedFromEnv({
      GEMINI_FREE_PROJECT_ATTESTED: 'True',
      PUBLIC_ORIGIN: GEMINI_CC3_TEST_PUBLIC_ORIGIN,
    })).toBe(false);
    expect(geminiFreeAttestedFromEnv({
      GEMINI_FREE_PROJECT_ATTESTED: '1',
      PUBLIC_ORIGIN: GEMINI_CC3_TEST_PUBLIC_ORIGIN,
    })).toBe(false);
  });

  it('clé présente + pas d’attestation Free → UNAVAILABLE, 0 fetch', () => {
    const fetchImpl = vi.fn();
    expectCode(
      () => createGeminiAdapter(
        { LLM_KEY_GEMINI: 'present-key' },
        freeRef,
        { fetchImpl: fetchImpl as typeof fetch },
      ),
      'EXECUTOR_UNAVAILABLE',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('factory : clé seule → UNAVAILABLE, 0 fetch', () => {
    const fetchImpl = vi.fn();
    const factory = providerAdapterFactory(
      { LLM_KEY_GEMINI: 'present-in-env' },
      { fetchImpl: fetchImpl as typeof fetch },
    );
    expectCode(() => factory(endpointStub), 'EXECUTOR_UNAVAILABLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('factory : true + origin TEST → adapter, mock generate', async () => {
    const fetchImpl = vi.fn(async () => okJson({
      candidates: [{ content: { parts: [{ text: 'CC4-PROBE-OK' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }));
    const factory = providerAdapterFactory(
      { ...testEnvOk },
      { fetchImpl: fetchImpl as typeof fetch },
    );
    const adapter = factory(endpointStub);
    const result = await adapter.generate({ control: 'c', data: 'd', max_tokens: 16 });
    expect(result.text).toBe('CC4-PROBE-OK');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('factory : true + origin PROD → UNAVAILABLE, 0 fetch', () => {
    const fetchImpl = vi.fn();
    const factory = providerAdapterFactory(
      {
        LLM_KEY_GEMINI: 'k',
        GEMINI_FREE_PROJECT_ATTESTED: 'true',
        PUBLIC_ORIGIN: 'https://github-mcp.rfahedkevin.workers.dev',
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );
    expectCode(() => factory(endpointStub), 'EXECUTOR_UNAVAILABLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('factory : true + origin absente / preview → UNAVAILABLE, 0 fetch', () => {
    const fetchImpl = vi.fn();
    for (const origin of [undefined, '', 'https://preview.example.workers.dev']) {
      const factory = providerAdapterFactory(
        {
          LLM_KEY_GEMINI: 'k',
          GEMINI_FREE_PROJECT_ATTESTED: 'true',
          ...(origin !== undefined ? { PUBLIC_ORIGIN: origin } : {}),
        },
        { fetchImpl: fetchImpl as typeof fetch },
      );
      expectCode(() => factory(endpointStub), 'EXECUTOR_UNAVAILABLE');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('factory : valeur env non exacte même avec origin TEST → UNAVAILABLE', () => {
    const fetchImpl = vi.fn();
    for (const bad of ['True', 'TRUE', '1', 'yes', '']) {
      const factory = providerAdapterFactory(
        {
          LLM_KEY_GEMINI: 'k',
          GEMINI_FREE_PROJECT_ATTESTED: bad,
          PUBLIC_ORIGIN: GEMINI_CC3_TEST_PUBLIC_ORIGIN,
        },
        { fetchImpl: fetchImpl as typeof fetch },
      );
      expectCode(() => factory(endpointStub), 'EXECUTOR_UNAVAILABLE');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Paid / inconnu refusés avant fetch', () => {
    const fetchImpl = vi.fn();
    expectCode(() => parseGeminiRef('gemini:gemini-2.5-pro'), 'EXECUTOR_PAID_MODEL');
    expectCode(() => parseGeminiRef('gemini:gemini-3.5-pro'), 'EXECUTOR_PAID_MODEL');
    expectCode(() => parseGeminiRef('gemini:unknown-model'), 'EXECUTOR_UNSUPPORTED');
    expectCode(
      () => createGeminiAdapter({ LLM_KEY_GEMINI: 'k' }, 'gemini:gemini-2.5-pro', {
        fetchImpl: fetchImpl as typeof fetch,
        ...freeOk,
      }),
      'EXECUTOR_PAID_MODEL',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('generate mock — URL 3.5 + thinkingLevel minimal (pas thinkingBudget)', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(GEMINI_API_BASE + '/' + GEMINI_FREE_MODEL + ':generateContent');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-goog-api-key']).toBe('gemini-secret');
      expect(headers.Authorization).toBeUndefined();
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain('gemini-secret');
      expect(JSON.stringify(body)).not.toContain('thinkingBudget');
      expect(body.generationConfig).toEqual({
        maxOutputTokens: 16,
        thinkingConfig: { thinkingLevel: 'minimal' },
      });
      return okJson({
        candidates: [{ content: { parts: [{ text: 'CC4-PROBE-OK' }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      });
    });
    const adapter = createGeminiAdapter(
      { LLM_KEY_GEMINI: 'gemini-secret' },
      freeRef,
      { fetchImpl: fetchImpl as typeof fetch, ...freeOk },
    );
    const result = await adapter.generate({ control: 'ctrl', data: 'data', max_tokens: 16 });
    expect(result).toMatchObject({
      text: 'CC4-PROBE-OK', provider: 'gemini', model: GEMINI_FREE_MODEL,
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  });

  it('concatène plusieurs parts textuelles', async () => {
    const fetchImpl = vi.fn(async () => okJson({
      candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] } }],
    }));
    const adapter = createGeminiAdapter(
      { LLM_KEY_GEMINI: 'k' }, freeRef,
      { fetchImpl: fetchImpl as typeof fetch, ...freeOk },
    );
    const result = await adapter.generate({ control: 'c', data: 'd', max_tokens: 8 });
    expect(result.text).toBe('AB');
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it.each([400, 401, 429, 500])('HTTP %i → UPSTREAM_HTTP, 0 retry, 0 fuite clé', async (status) => {
    const { fetchImpl, calls } = countingStatusFetch(status);
    const adapter = createGeminiAdapter(
      { LLM_KEY_GEMINI: 'secret-no-leak' }, freeRef,
      { fetchImpl, ...freeOk },
    );
    await expectRejectCode(
      adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_UPSTREAM_HTTP',
      ['secret-no-leak', 'upstream'],
    );
    expect(calls()).toBe(1);
  });

  it('JSON malformé → BAD_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => new Response('not-json', { status: 200 }));
    const adapter = createGeminiAdapter(
      { LLM_KEY_GEMINI: 'k' }, freeRef,
      { fetchImpl: fetchImpl as typeof fetch, ...freeOk },
    );
    await expectRejectCode(
      adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_BAD_RESPONSE',
    );
  });

  it('contenu vide → BAD_RESPONSE (pas de promesse OFF total thinking)', async () => {
    const fetchImpl = vi.fn(async () => okJson({
      candidates: [{ content: { parts: [{ text: '' }] } }],
    }));
    const adapter = createGeminiAdapter(
      { LLM_KEY_GEMINI: 'k' }, freeRef,
      { fetchImpl: fetchImpl as typeof fetch, ...freeOk },
    );
    await expectRejectCode(
      adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_BAD_RESPONSE',
    );
  });

  it('timeout → EXECUTOR_TIMEOUT, 0 secret dans le message', async () => {
    const adapter = createGeminiAdapter(
      { LLM_KEY_GEMINI: 'secret-must-not-leak' }, freeRef,
      { fetchImpl: hangFetch(), timeout_ms: 20, ...freeOk },
    );
    await expectRejectCode(
      adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_TIMEOUT',
      ['secret-must-not-leak'],
    );
  });

  it('secret absent → UNAVAILABLE sans réseau', () => {
    const fetchImpl = vi.fn();
    expectCode(
      () => createGeminiAdapter({}, freeRef, {
        fetchImpl: fetchImpl as typeof fetch,
        ...freeOk,
      }),
      'EXECUTOR_UNAVAILABLE',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
