import { describe, expect, it, vi } from 'vitest';
import { StateContractError } from '../../../src/collab/contracts';
import {
  GROQ_CHAT_COMPLETIONS_URL,
  ZAI_CHAT_COMPLETIONS_URL,
  createOpenAiCompatibleAdapter,
  openAiCompatibleProviderOf,
  parseOpenAiCompatibleRef,
} from '../../../src/collab-store/executors/openai-compatible';

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('R4 A — openai-compatible multi-provider', () => {
  it('détecte les préfixes supportés', () => {
    expect(openAiCompatibleProviderOf('groq:openai/gpt-oss-20b')).toBe('groq');
    expect(openAiCompatibleProviderOf('zai:glm-4.7-flash')).toBe('zai');
    expect(openAiCompatibleProviderOf('deepseek:deepseek-flash')).toBe('deepseek');
    expect(openAiCompatibleProviderOf('openrouter:x/y:free')).toBe('openrouter');
    expect(openAiCompatibleProviderOf('workers-ai:@cf/x')).toBeNull();
  });

  it('Groq Free ok ; paid et inconnu refusés avant fetch', () => {
    expect(parseOpenAiCompatibleRef('groq:openai/gpt-oss-20b')).toEqual({
      provider: 'groq', model: 'openai/gpt-oss-20b',
    });
    expect(() => parseOpenAiCompatibleRef('groq:llama-3.3-70b-versatile')).toThrow(StateContractError);
    try { parseOpenAiCompatibleRef('groq:llama-3.3-70b-versatile'); }
    catch (e) { expect((e as StateContractError).code).toBe('EXECUTOR_PAID_MODEL'); }
    expect(() => parseOpenAiCompatibleRef('groq:unknown')).toThrow(StateContractError);
  });

  it('DeepSeek direct = paid dormant', () => {
    try { parseOpenAiCompatibleRef('deepseek:deepseek-flash'); }
    catch (e) { expect((e as StateContractError).code).toBe('EXECUTOR_PAID_MODEL'); }
  });

  it('Z.AI Free ok ; flashx paid', () => {
    expect(parseOpenAiCompatibleRef('zai:glm-4.7-flash').model).toBe('glm-4.7-flash');
    try { parseOpenAiCompatibleRef('zai:glm-4.7-flashx'); }
    catch (e) { expect((e as StateContractError).code).toBe('EXECUTOR_PAID_MODEL'); }
  });

  it('OpenRouter :free inchangé', () => {
    expect(parseOpenAiCompatibleRef('openrouter:acme/model-x:free').model).toBe('acme/model-x:free');
    try { parseOpenAiCompatibleRef('openrouter:acme/model-x'); }
    catch (e) { expect((e as StateContractError).code).toBe('EXECUTOR_PAID_MODEL'); }
  });

  it('generate Groq mock — URL constante, pas de data_collection', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(GROQ_CHAT_COMPLETIONS_URL);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.provider).toBeUndefined();
      expect(body.model).toBe('openai/gpt-oss-20b');
      return okJson({
        choices: [{ message: { content: 'ok-groq' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    const adapter = createOpenAiCompatibleAdapter(
      { LLM_KEY_GROQ: 'k' },
      'groq:openai/gpt-oss-20b',
      { fetchImpl: fetchImpl as typeof fetch },
    );
    const result = await adapter.generate({ control: 'c', data: 'd', max_tokens: 8 });
    expect(result).toMatchObject({ text: 'ok-groq', provider: 'groq' });
  });

  it('generate Z.AI mock', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(ZAI_CHAT_COMPLETIONS_URL);
      return okJson({
        choices: [{ message: { content: 'ok-zai' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    const adapter = createOpenAiCompatibleAdapter(
      { LLM_KEY_ZAI: 'k' },
      'zai:glm-4.7-flash',
      { fetchImpl: fetchImpl as typeof fetch },
    );
    const result = await adapter.generate({ control: 'c', data: 'd', max_tokens: 8 });
    expect(result.provider).toBe('zai');
    expect(result.text).toBe('ok-zai');
  });

  it('secret absent → UNAVAILABLE sans réseau', () => {
    const fetchImpl = vi.fn();
    expect(() => createOpenAiCompatibleAdapter({}, 'groq:openai/gpt-oss-20b', {
      fetchImpl: fetchImpl as typeof fetch,
    })).toThrow(StateContractError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
