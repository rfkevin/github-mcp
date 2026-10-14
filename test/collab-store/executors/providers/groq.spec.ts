import { describe, expect, it, vi } from 'vitest';
import { StateContractError } from '../../../../src/collab/contracts';
import {
  GROQ_CHAT_COMPLETIONS_URL,
  GROQ_FREE_MODELS,
  GROQ_PROVIDER,
  GROQ_SECRET_NAME,
  createGroqAdapter,
  parseGroqRef,
} from '../../../../src/collab-store/executors/providers/groq';

const FREE_REF = 'groq:openai/gpt-oss-20b';
const PAID_REF = 'groq:llama-3.3-70b-versatile';

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('R4 A1 Groq adapter (mock only)', () => {
  it('parse : Free allowlist ok, paid et inconnu refusés avant fetch', () => {
    expect(parseGroqRef(FREE_REF)).toEqual({
      provider: GROQ_PROVIDER,
      model: 'openai/gpt-oss-20b',
    });
    expect(GROQ_FREE_MODELS.has('openai/gpt-oss-20b')).toBe(true);

    expect(() => parseGroqRef(PAID_REF)).toThrow(StateContractError);
    try {
      parseGroqRef(PAID_REF);
    } catch (e) {
      expect((e as StateContractError).code).toBe('EXECUTOR_PAID_MODEL');
    }

    expect(() => parseGroqRef('groq:unknown-model')).toThrow(StateContractError);
    expect(() => parseGroqRef('openrouter:x')).toThrow(StateContractError);
  });

  it('refuse create sans secret, sans appeler le réseau', () => {
    const fetchImpl = vi.fn();
    expect(() => createGroqAdapter({}, FREE_REF, { fetchImpl: fetchImpl as typeof fetch })).toThrow(
      StateContractError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('generate succès via fetch mock — URL et secret constants', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(GROQ_CHAT_COMPLETIONS_URL);
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-key-not-a-real-secret');
      expect(String(init?.body)).not.toContain('test-key');
      return okJson({
        choices: [{ message: { content: 'ok-groq' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      });
    });

    const adapter = createGroqAdapter(
      { LLM_KEY_GROQ: 'test-key-not-a-real-secret' },
      FREE_REF,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    expect(adapter.provider).toBe('groq');
    expect(adapter.model).toBe('openai/gpt-oss-20b');
    expect(GROQ_SECRET_NAME).toBe('LLM_KEY_GROQ');

    const result = await adapter.generate({
      control: 'résume',
      data: 'hello',
      max_tokens: 16,
    });
    expect(result.text).toBe('ok-groq');
    expect(result.provider).toBe('groq');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('mappe 401 / 429 / 500 et JSON invalide', async () => {
    for (const status of [401, 429, 500]) {
      const fetchImpl = vi.fn(async () => okJson({}, status));
      const adapter = createGroqAdapter(
        { LLM_KEY_GROQ: 'k' },
        FREE_REF,
        { fetchImpl: fetchImpl as typeof fetch },
      );
      await expect(
        adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
      ).rejects.toMatchObject({ code: 'EXECUTOR_UPSTREAM_HTTP' });
    }

    const bad = vi.fn(async () => new Response('not-json', { status: 200 }));
    const adapter = createGroqAdapter(
      { LLM_KEY_GROQ: 'k' },
      FREE_REF,
      { fetchImpl: bad as typeof fetch },
    );
    await expect(
      adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
    ).rejects.toMatchObject({ code: 'EXECUTOR_BAD_RESPONSE' });
  });

  it('paid refusé même avec secret présent (dormant)', () => {
    const fetchImpl = vi.fn();
    expect(() =>
      createGroqAdapter({ LLM_KEY_GROQ: 'k' }, PAID_REF, { fetchImpl: fetchImpl as typeof fetch }),
    ).toThrow(StateContractError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('validate max_tokens localement', () => {
    const adapter = createGroqAdapter(
      { LLM_KEY_GROQ: 'k' },
      FREE_REF,
      { fetchImpl: vi.fn() as unknown as typeof fetch },
    );
    expect(() => adapter.validate({ control: 'c', data: 'd', max_tokens: 0 })).toThrow(
      StateContractError,
    );
  });
});
