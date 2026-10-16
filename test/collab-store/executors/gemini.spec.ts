import { describe, expect, it, vi } from 'vitest';
import { StateContractError } from '../../../src/collab/contracts';
import {
  GEMINI_API_BASE,
  GEMINI_FREE_MODEL,
  createGeminiAdapter,
  geminiProviderOf,
  parseGeminiRef,
} from '../../../src/collab-store/executors/gemini';

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try { fn(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(StateContractError);
  expect((thrown as StateContractError).code).toBe(code);
}

describe('R4 A — Gemini Free', () => {
  it('préfixe et Free model', () => {
    expect(geminiProviderOf('gemini:' + GEMINI_FREE_MODEL)).toBe('gemini');
    expect(geminiProviderOf('openrouter:x')).toBeNull();
    expect(parseGeminiRef('gemini:' + GEMINI_FREE_MODEL).model).toBe(GEMINI_FREE_MODEL);
  });

  it('Paid / inconnu refusés avant fetch', () => {
    const fetchImpl = vi.fn();
    expectCode(() => parseGeminiRef('gemini:gemini-2.5-pro'), 'EXECUTOR_PAID_MODEL');
    expectCode(() => parseGeminiRef('gemini:unknown-model'), 'EXECUTOR_UNSUPPORTED');
    expectCode(
      () => createGeminiAdapter({ LLM_KEY_GEMINI: 'k' }, 'gemini:gemini-2.5-pro', {
        fetchImpl: fetchImpl as typeof fetch,
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
      { fetchImpl: fetchImpl as typeof fetch },
    );
    const result = await adapter.generate({ control: 'ctrl', data: 'data', max_tokens: 16 });
    expect(result).toMatchObject({
      text: 'CC4-PROBE-OK', provider: 'gemini', model: GEMINI_FREE_MODEL,
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  });

  it('contenu vide → BAD_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => okJson({
      candidates: [{ content: { parts: [{ text: '' }] } }],
    }));
    const adapter = createGeminiAdapter(
      { LLM_KEY_GEMINI: 'k' },
      'gemini:' + GEMINI_FREE_MODEL,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    await expect(
      adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_BAD_RESPONSE' });
  });

  it('secret absent → UNAVAILABLE 0 fetch', () => {
    const fetchImpl = vi.fn();
    expectCode(
      () => createGeminiAdapter({}, 'gemini:' + GEMINI_FREE_MODEL, {
        fetchImpl: fetchImpl as typeof fetch,
      }),
      'EXECUTOR_UNAVAILABLE',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
