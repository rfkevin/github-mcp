import { describe, expect, it, vi } from 'vitest';
import { StateContractError } from '../../../src/collab/contracts';
import {
  GEMINI_API_BASE,
  GEMINI_FREE_MODEL,
  createGeminiAdapter,
  geminiProviderOf,
  parseGeminiRef,
} from '../../../src/collab-store/executors/gemini';
import { providerAdapterFactory } from '../../../src/collab-store/executors/run';
import { expectCode, okJson } from './test-helpers';

const freeOk = { freeProjectAttested: true as const };

describe('R4 A — Gemini Free', () => {
  it('préfixe et Free model', () => {
    expect(geminiProviderOf('gemini:' + GEMINI_FREE_MODEL)).toBe('gemini');
    expect(geminiProviderOf('openrouter:x')).toBeNull();
    expect(parseGeminiRef('gemini:' + GEMINI_FREE_MODEL).model).toBe(GEMINI_FREE_MODEL);
  });

  it('clé présente + pas d’attestation Free → UNAVAILABLE, 0 fetch', () => {
    const fetchImpl = vi.fn();
    expectCode(
      () => createGeminiAdapter(
        { LLM_KEY_GEMINI: 'present-key' },
        'gemini:' + GEMINI_FREE_MODEL,
        { fetchImpl: fetchImpl as typeof fetch },
      ),
      'EXECUTOR_UNAVAILABLE',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('factory prod : clé Gemini présente → UNAVAILABLE, 0 fetch', () => {
    const fetchImpl = vi.fn();
    const factory = providerAdapterFactory(
      { LLM_KEY_GEMINI: 'present-in-env' },
      { fetchImpl: fetchImpl as typeof fetch },
    );
    expectCode(
      () => factory({
        endpoint_id: 'ep-gemini',
        principal_id: 'gemini-25-flash-lite',
        status: 'probe_required',
        attestation_kind: 'provider_adapter',
        attestation_ref: 'gemini:' + GEMINI_FREE_MODEL,
        capability_set: { tools: ['llm.generate'], network_providers: ['gemini'], token_ceiling: 256 },
        notes: '',
        created_at: '',
        updated_at: '',
      } as never),
      'EXECUTOR_UNAVAILABLE',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Paid / inconnu refusés avant fetch', () => {
    const fetchImpl = vi.fn();
    expectCode(() => parseGeminiRef('gemini:gemini-2.5-pro'), 'EXECUTOR_PAID_MODEL');
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

  it('generate mock — URL path + x-goog-api-key, 0 Bearer', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(GEMINI_API_BASE + '/' + GEMINI_FREE_MODEL + ':generateContent');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-goog-api-key']).toBe('gemini-secret');
      expect(headers.Authorization).toBeUndefined();
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain('gemini-secret');
      expect(body.generationConfig).toEqual({ maxOutputTokens: 16 });
      return okJson({
        candidates: [{ content: { parts: [{ text: 'CC4-PROBE-OK' }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      });
    });
    const adapter = createGeminiAdapter(
      { LLM_KEY_GEMINI: 'gemini-secret' },
      'gemini:' + GEMINI_FREE_MODEL,
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
      { LLM_KEY_GEMINI: 'k' },
      'gemini:' + GEMINI_FREE_MODEL,
      { fetchImpl: fetchImpl as typeof fetch, ...freeOk },
    );
    const result = await adapter.generate({ control: 'c', data: 'd', max_tokens: 8 });
    expect(result.text).toBe('AB');
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it.each([400, 401, 429, 500])('HTTP %i → UPSTREAM_HTTP, 0 retry, 0 fuite clé', async (status) => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return okJson({ error: { message: 'upstream' } }, status);
    });
    const adapter = createGeminiAdapter(
      { LLM_KEY_GEMINI: 'secret-no-leak' },
      'gemini:' + GEMINI_FREE_MODEL,
      { fetchImpl: fetchImpl as typeof fetch, ...freeOk },
    );
    try {
      await adapter.generate({ control: 'c', data: 'd', max_tokens: 8 });
      expect.fail('erreur attendue');
    } catch (error) {
      expect(error).toBeInstanceOf(StateContractError);
      expect((error as StateContractError).code).toBe('EXECUTOR_UPSTREAM_HTTP');
      expect(String((error as Error).message)).not.toContain('secret-no-leak');
      expect(String((error as Error).message)).not.toContain('upstream');
    }
    expect(calls).toBe(1);
  });

  it('JSON malformé → BAD_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => new Response('not-json', { status: 200 }));
    const adapter = createGeminiAdapter(
      { LLM_KEY_GEMINI: 'k' },
      'gemini:' + GEMINI_FREE_MODEL,
      { fetchImpl: fetchImpl as typeof fetch, ...freeOk },
    );
    await expect(
      adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_BAD_RESPONSE' });
  });

  it('contenu vide → BAD_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => okJson({
      candidates: [{ content: { parts: [{ text: '' }] } }],
    }));
    const adapter = createGeminiAdapter(
      { LLM_KEY_GEMINI: 'k' },
      'gemini:' + GEMINI_FREE_MODEL,
      { fetchImpl: fetchImpl as typeof fetch, ...freeOk },
    );
    await expect(
      adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_BAD_RESPONSE' });
  });

  it('timeout → EXECUTOR_TIMEOUT, 0 secret dans le message', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => { /* hang */ }));
    const adapter = createGeminiAdapter(
      { LLM_KEY_GEMINI: 'secret-must-not-leak' },
      'gemini:' + GEMINI_FREE_MODEL,
      { fetchImpl: fetchImpl as typeof fetch, timeout_ms: 20, ...freeOk },
    );
    try {
      await adapter.generate({ control: 'c', data: 'd', max_tokens: 8 });
      expect.fail('timeout attendu');
    } catch (error) {
      expect(error).toBeInstanceOf(StateContractError);
      expect((error as StateContractError).code).toBe('EXECUTOR_TIMEOUT');
      expect(String((error as Error).message)).not.toContain('secret-must-not-leak');
    }
  });

  it('secret absent → UNAVAILABLE sans réseau', () => {
    const fetchImpl = vi.fn();
    expectCode(
      () => createGeminiAdapter({}, 'gemini:' + GEMINI_FREE_MODEL, {
        fetchImpl: fetchImpl as typeof fetch,
        ...freeOk,
      }),
      'EXECUTOR_UNAVAILABLE',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
