import { describe, expect, it, vi } from 'vitest';
import {
  GROQ_CC3_TEST_PUBLIC_ORIGIN,
  GROQ_CHAT_COMPLETIONS_URL,
  GROQ_FREE_MODEL,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  ZAI_CHAT_COMPLETIONS_URL,
  createOpenAiCompatibleAdapter,
  groqFreeAttestedFromEnv,
  openAiCompatibleProviderOf,
  parseOpenAiCompatibleRef,
} from '../../../src/collab-store/executors/openai-compatible';
import { providerAdapterFactory } from '../../../src/collab-store/executors/run';
import {
  countingStatusFetch, expectCode, expectRejectCode, hangFetch, okJson,
} from './test-helpers';

const freeRef = 'groq:' + GROQ_FREE_MODEL;

const testEnvOk = {
  LLM_KEY_GROQ: 'groq-secret',
  GROQ_FREE_PROJECT_ATTESTED: 'true',
  PUBLIC_ORIGIN: GROQ_CC3_TEST_PUBLIC_ORIGIN,
} as const;

const endpointStub = {
  endpoint_id: 'ep-groq',
  principal_id: 'groq-gptoss20b',
  status: 'probe_required',
  attestation_kind: 'provider_adapter',
  attestation_ref: freeRef,
  capability_set: { tools: ['llm.generate'], network_providers: ['groq'], token_ceiling: 256 },
  notes: '',
  created_at: '',
  updated_at: '',
} as never;

describe('R4 A — openai-compatible multi-provider', () => {
  it('détecte les préfixes supportés', () => {
    expect(openAiCompatibleProviderOf('groq:openai/gpt-oss-20b')).toBe('groq');
    expect(openAiCompatibleProviderOf('zai:glm-4.7-flash')).toBe('zai');
    expect(openAiCompatibleProviderOf('deepseek:deepseek-flash')).toBe('deepseek');
    expect(openAiCompatibleProviderOf('openrouter:x/y:free')).toBe('openrouter');
    expect(openAiCompatibleProviderOf('xai:grok-4.7')).toBe('xai');
    expect(openAiCompatibleProviderOf('workers-ai:@cf/x')).toBeNull();
  });

  it('groqFreeAttestedFromEnv : true + origin CC3-test uniquement', () => {
    expect(groqFreeAttestedFromEnv({})).toBe(false);
    expect(groqFreeAttestedFromEnv({ GROQ_FREE_PROJECT_ATTESTED: 'true' })).toBe(false);
    expect(groqFreeAttestedFromEnv({
      GROQ_FREE_PROJECT_ATTESTED: 'true',
      PUBLIC_ORIGIN: GROQ_CC3_TEST_PUBLIC_ORIGIN,
    })).toBe(true);
    expect(groqFreeAttestedFromEnv({
      GROQ_FREE_PROJECT_ATTESTED: 'true',
      PUBLIC_ORIGIN: 'https://github-mcp.rfahedkevin.workers.dev',
    })).toBe(false);
    expect(groqFreeAttestedFromEnv({
      GROQ_FREE_PROJECT_ATTESTED: 'True',
      PUBLIC_ORIGIN: GROQ_CC3_TEST_PUBLIC_ORIGIN,
    })).toBe(false);
  });

  it('Groq sans attestation → UNAVAILABLE, 0 fetch', () => {
    const fetchImpl = vi.fn();
    expectCode(() => parseOpenAiCompatibleRef('groq:openai/gpt-oss-20b'), 'EXECUTOR_UNAVAILABLE');
    expectCode(
      () => createOpenAiCompatibleAdapter(
        { LLM_KEY_GROQ: 'present-but-billing-unknown' },
        freeRef,
        { fetchImpl: fetchImpl as typeof fetch },
      ),
      'EXECUTOR_UNAVAILABLE',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('constructeur direct : options.freeProjectAttested=true + origin PROD → UNAVAILABLE, 0 fetch', () => {
    const fetchImpl = vi.fn();
    expectCode(
      () => createOpenAiCompatibleAdapter(
        {
          LLM_KEY_GROQ: 'secret-must-not-leak',
          GROQ_FREE_PROJECT_ATTESTED: 'true',
          PUBLIC_ORIGIN: 'https://github-mcp.rfahedkevin.workers.dev',
        },
        freeRef,
        { freeProjectAttested: true, fetchImpl: fetchImpl as typeof fetch },
      ),
      'EXECUTOR_UNAVAILABLE',
    );
    expectCode(
      () => createOpenAiCompatibleAdapter(
        { LLM_KEY_GROQ: 'secret-must-not-leak' },
        freeRef,
        { freeProjectAttested: true, fetchImpl: fetchImpl as typeof fetch },
      ),
      'EXECUTOR_UNAVAILABLE',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('constructeur direct : env TEST exacte → un seul fetch mock', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(GROQ_CHAT_COMPLETIONS_URL);
      return okJson({
        choices: [{ message: { content: 'CC4-PROBE-OK' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    const adapter = createOpenAiCompatibleAdapter(
      { ...testEnvOk },
      freeRef,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    const result = await adapter.generate({ control: 'c', data: 'd', max_tokens: 16 });
    expect(result.text).toBe('CC4-PROBE-OK');
    expect(result.provider).toBe('groq');
    expect(result.model).toBe(GROQ_FREE_MODEL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('factory : clé seule → UNAVAILABLE, 0 fetch', () => {
    const fetchImpl = vi.fn();
    const factory = providerAdapterFactory(
      { LLM_KEY_GROQ: 'present-in-env' },
      { fetchImpl: fetchImpl as typeof fetch },
    );
    expectCode(() => factory(endpointStub), 'EXECUTOR_UNAVAILABLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('factory : env TEST true + secret manquant → UNAVAILABLE, 0 fetch', () => {
    const fetchImpl = vi.fn();
    const factory = providerAdapterFactory(
      {
        GROQ_FREE_PROJECT_ATTESTED: 'true',
        PUBLIC_ORIGIN: GROQ_CC3_TEST_PUBLIC_ORIGIN,
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );
    expectCode(() => factory(endpointStub), 'EXECUTOR_UNAVAILABLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('factory : true + origin TEST → adapter, mock generate', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(GROQ_CHAT_COMPLETIONS_URL);
      return okJson({
        choices: [{ message: { content: 'CC4-PROBE-OK' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
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
        LLM_KEY_GROQ: 'k',
        GROQ_FREE_PROJECT_ATTESTED: 'true',
        PUBLIC_ORIGIN: 'https://github-mcp.rfahedkevin.workers.dev',
      },
      { freeProjectAttested: true, fetchImpl: fetchImpl as typeof fetch },
    );
    expectCode(() => factory(endpointStub), 'EXECUTOR_UNAVAILABLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Groq Paid / hors allowlist refusés même avec attestation', () => {
    const fetchImpl = vi.fn();
    const opts = { freeProjectAttested: true as const, fetchImpl: fetchImpl as typeof fetch };
    expectCode(() => parseOpenAiCompatibleRef('groq:llama-3.3-70b-versatile', opts), 'EXECUTOR_PAID_MODEL');
    expectCode(() => parseOpenAiCompatibleRef('groq:openai/gpt-oss-120b', opts), 'EXECUTOR_PAID_MODEL');
    expectCode(() => parseOpenAiCompatibleRef('groq:unknown-model', opts), 'EXECUTOR_UNSUPPORTED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Groq mock autorisé : HTTP 429 → UPSTREAM_HTTP, 0 secret', async () => {
    const { fetchImpl, calls } = countingStatusFetch(429);
    const adapter = createOpenAiCompatibleAdapter(
      { ...testEnvOk, LLM_KEY_GROQ: 'secret-must-not-leak' },
      freeRef,
      { fetchImpl },
    );
    await expectRejectCode(
      adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_UPSTREAM_HTTP',
      ['secret-must-not-leak', 'upstream'],
    );
    expect(calls()).toBe(1);
  });

  it('Groq mock autorisé : timeout → EXECUTOR_TIMEOUT, 0 secret', async () => {
    const adapter = createOpenAiCompatibleAdapter(
      { ...testEnvOk, LLM_KEY_GROQ: 'secret-must-not-leak' },
      freeRef,
      { fetchImpl: hangFetch(), timeout_ms: 20 },
    );
    await expectRejectCode(
      adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_TIMEOUT',
      ['secret-must-not-leak'],
    );
  });

  it('Groq mock autorisé : contenu vide → BAD_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => okJson({
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 10, completion_tokens: 256 },
    }));
    const adapter = createOpenAiCompatibleAdapter(
      { ...testEnvOk },
      freeRef,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    await expectRejectCode(
      adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_BAD_RESPONSE',
    );
  });

  it('DeepSeek direct Paid → PAID_MODEL avant fetch', () => {
    const fetchImpl = vi.fn();
    expectCode(() => parseOpenAiCompatibleRef('deepseek:deepseek-flash'), 'EXECUTOR_PAID_MODEL');
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

  it('xAI : tous modèles Paid dormant, 0 fetch', () => {
    const fetchImpl = vi.fn();
    expectCode(() => parseOpenAiCompatibleRef('xai:grok-4.7'), 'EXECUTOR_PAID_MODEL');
    expectCode(() => parseOpenAiCompatibleRef('xai:grok-3-mini'), 'EXECUTOR_PAID_MODEL');
    expectCode(
      () => createOpenAiCompatibleAdapter(
        { LLM_KEY_XAI: 'k' },
        'xai:grok-4.7',
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

  it('Z.AI glm-4.7-flash : body exact avec thinking.disabled (#145)', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(ZAI_CHAT_COMPLETIONS_URL);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe('glm-4.7-flash');
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.provider).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('present-secret');
      return okJson({
        choices: [{ message: { content: 'ok-zai' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    const adapter = createOpenAiCompatibleAdapter(
      { LLM_KEY_ZAI: 'present-secret' },
      'zai:glm-4.7-flash',
      { fetchImpl: fetchImpl as typeof fetch },
    );
    const result = await adapter.generate({ control: 'c', data: 'd', max_tokens: 8 });
    expect(result).toMatchObject({ text: 'ok-zai', provider: 'zai', model: 'glm-4.7-flash' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('OpenRouter :free : pas de thinking dans le body', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(OPENROUTER_CHAT_COMPLETIONS_URL);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.thinking).toBeUndefined();
      expect(body.provider).toEqual({ data_collection: 'deny' });
      return okJson({
        choices: [{ message: { content: 'ok-or' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    const adapter = createOpenAiCompatibleAdapter(
      { LLM_KEY_OPENROUTER: 'k' },
      'openrouter:acme/model-x:free',
      { fetchImpl: fetchImpl as typeof fetch },
    );
    const result = await adapter.generate({ control: 'c', data: 'd', max_tokens: 8 });
    expect(result.text).toBe('ok-or');
  });

  it('contenu message vide → EXECUTOR_BAD_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => okJson({
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 10, completion_tokens: 256 },
    }));
    const adapter = createOpenAiCompatibleAdapter(
      { LLM_KEY_ZAI: 'k' },
      'zai:glm-4.7-flash',
      { fetchImpl: fetchImpl as typeof fetch },
    );
    await expectRejectCode(
      adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_BAD_RESPONSE',
    );
  });

  it('timeout → EXECUTOR_TIMEOUT, 0 secret dans le message', async () => {
    const adapter = createOpenAiCompatibleAdapter(
      { LLM_KEY_ZAI: 'secret-must-not-leak' },
      'zai:glm-4.7-flash',
      { fetchImpl: hangFetch(), timeout_ms: 20 },
    );
    await expectRejectCode(
      adapter.generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_TIMEOUT',
      ['secret-must-not-leak'],
    );
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
