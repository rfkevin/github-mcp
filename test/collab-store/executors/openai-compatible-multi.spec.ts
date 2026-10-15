import { describe, expect, it, vi } from 'vitest';
import { StateContractError } from '../../../src/collab/contracts';
import {
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

/** Échoue si fn ne jette pas, ou si le code d'erreur diffère. */
function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'exception attendue pour code ' + code).toBeInstanceOf(StateContractError);
  expect((thrown as StateContractError).code).toBe(code);
}

describe('R4 A — openai-compatible multi-provider', () => {
  it('détecte les préfixes supportés', () => {
    expect(openAiCompatibleProviderOf('groq:openai/gpt-oss-20b')).toBe('groq');
    expect(openAiCompatibleProviderOf('zai:glm-4.7-flash')).toBe('zai');
    expect(openAiCompatibleProviderOf('deepseek:deepseek-flash')).toBe('deepseek');
    expect(openAiCompatibleProviderOf('openrouter:x/y:free')).toBe('openrouter');
    expect(openAiCompatibleProviderOf('workers-ai:@cf/x')).toBeNull();
  });

  it('Groq : clé présente + modèle « free » catalogue → UNAVAILABLE, 0 fetch', () => {
    const fetchImpl = vi.fn();
    expectCode(
      () => parseOpenAiCompatibleRef('groq:openai/gpt-oss-20b'),
      'EXECUTOR_UNAVAILABLE',
    );
    expectCode(
      () => parseOpenAiCompatibleRef('groq:llama-3.3-70b-versatile'),
      'EXECUTOR_UNAVAILABLE',
    );
    expectCode(
      () => createOpenAiCompatibleAdapter(
        { LLM_KEY_GROQ: 'present-but-billing-unknown' },
        'groq:openai/gpt-oss-20b',
        { fetchImpl: fetchImpl as typeof fetch },
      ),
      'EXECUTOR_UNAVAILABLE',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('DeepSeek direct Paid → PAID_MODEL avant fetch', () => {
    const fetchImpl = vi.fn();
    expectCode(
      () => parseOpenAiCompatibleRef('deepseek:deepseek-flash'),
      'EXECUTOR_PAID_MODEL',
    );
    expectCode(
      () => createOpenAiCompatibleAdapter(
        { LLM_KEY_DEEPSEEK: 'k' },
        'deepseek:deepseek-flash',
        { fetchImpl: fetchImpl as typeof fetch },
      ),
      'EXECUTOR_PAID_MODEL',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Z.AI Free ok ; flashx paid', () => {
    expect(parseOpenAiCompatibleRef('zai:glm-4.7-flash').model).toBe('glm-4.7-flash');
    expectCode(() => parseOpenAiCompatibleRef('zai:glm-4.7-flashx'), 'EXECUTOR_PAID_MODEL');
  });

  it('OpenRouter :free inchangé', () => {
    expect(parseOpenAiCompatibleRef('openrouter:acme/model-x:free').model).toBe('acme/model-x:free');
    expectCode(() => parseOpenAiCompatibleRef('openrouter:acme/model-x'), 'EXECUTOR_PAID_MODEL');
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

  it('secret Z.AI absent → UNAVAILABLE sans réseau', () => {
    const fetchImpl = vi.fn();
    expectCode(
      () => createOpenAiCompatibleAdapter({}, 'zai:glm-4.7-flash', {
        fetchImpl: fetchImpl as typeof fetch,
      }),
      'EXECUTOR_UNAVAILABLE',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
