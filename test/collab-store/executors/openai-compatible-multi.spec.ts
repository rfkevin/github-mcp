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
const prodOrigin = 'https://github-mcp.rfahedkevin.workers.dev';
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
  notes: '', created_at: '', updated_at: '',
} as never;

function deadFetch() {
  return vi.fn() as unknown as typeof fetch;
}

function expectUnavailable(fn: () => unknown, fetchImpl?: ReturnType<typeof vi.fn>) {
  expectCode(fn, 'EXECUTOR_UNAVAILABLE');
  if (fetchImpl) expect(fetchImpl).not.toHaveBeenCalled();
}

function probeOkFetch() {
  return vi.fn(async (url: string) => {
    expect(url).toBe(GROQ_CHAT_COMPLETIONS_URL);
    return okJson({
      choices: [{ message: { content: 'CC4-PROBE-OK' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  });
}

describe('R4 A — openai-compatible multi-provider', () => {
  it('détecte les préfixes supportés', () => {
    expect(openAiCompatibleProviderOf('groq:openai/gpt-oss-20b')).toBe('groq');
    expect(openAiCompatibleProviderOf('zai:glm-4.7-flash')).toBe('zai');
    expect(openAiCompatibleProviderOf('deepseek:deepseek-flash')).toBe('deepseek');
    expect(openAiCompatibleProviderOf('openrouter:x/y:free')).toBe('openrouter');
    expect(openAiCompatibleProviderOf('xai:grok-4.7')).toBe('xai');
    expect(openAiCompatibleProviderOf('workers-ai:@cf/x')).toBeNull();
  });

  it('groqFreeAttestedFromEnv : double condition TEST exacte', () => {
    expect(groqFreeAttestedFromEnv({})).toBe(false);
    expect(groqFreeAttestedFromEnv({ GROQ_FREE_PROJECT_ATTESTED: 'true' })).toBe(false);
    expect(groqFreeAttestedFromEnv({
      GROQ_FREE_PROJECT_ATTESTED: 'true', PUBLIC_ORIGIN: GROQ_CC3_TEST_PUBLIC_ORIGIN,
    })).toBe(true);
    expect(groqFreeAttestedFromEnv({
      GROQ_FREE_PROJECT_ATTESTED: 'true', PUBLIC_ORIGIN: prodOrigin,
    })).toBe(false);
    expect(groqFreeAttestedFromEnv({
      GROQ_FREE_PROJECT_ATTESTED: 'True', PUBLIC_ORIGIN: GROQ_CC3_TEST_PUBLIC_ORIGIN,
    })).toBe(false);
  });

  it('Groq fail-closed : parse, constructeur, factory (0 fetch)', () => {
    const fetchImpl = deadFetch();
    expectUnavailable(() => parseOpenAiCompatibleRef(freeRef));
    expectUnavailable(
      () => createOpenAiCompatibleAdapter({ LLM_KEY_GROQ: 'k' }, freeRef, { fetchImpl }),
      fetchImpl as unknown as ReturnType<typeof vi.fn>,
    );
    for (const env of [
      { LLM_KEY_GROQ: 'secret-must-not-leak', GROQ_FREE_PROJECT_ATTESTED: 'true', PUBLIC_ORIGIN: prodOrigin },
      { LLM_KEY_GROQ: 'secret-must-not-leak' },
    ]) {
      expectUnavailable(
        () => createOpenAiCompatibleAdapter(env, freeRef, {
          freeProjectAttested: true, fetchImpl,
        }),
        fetchImpl as unknown as ReturnType<typeof vi.fn>,
      );
    }
    expectUnavailable(
      () => providerAdapterFactory({ LLM_KEY_GROQ: 'k' }, { fetchImpl })(endpointStub),
      fetchImpl as unknown as ReturnType<typeof vi.fn>,
    );
    expectUnavailable(
      () => providerAdapterFactory({
        GROQ_FREE_PROJECT_ATTESTED: 'true', PUBLIC_ORIGIN: GROQ_CC3_TEST_PUBLIC_ORIGIN,
      }, { fetchImpl })(endpointStub),
      fetchImpl as unknown as ReturnType<typeof vi.fn>,
    );
    expectUnavailable(
      () => providerAdapterFactory({
        LLM_KEY_GROQ: 'k', GROQ_FREE_PROJECT_ATTESTED: 'true', PUBLIC_ORIGIN: prodOrigin,
      }, { freeProjectAttested: true, fetchImpl })(endpointStub),
      fetchImpl as unknown as ReturnType<typeof vi.fn>,
    );
  });

  it('constructeur et factory TEST → generate mock', async () => {
    for (const make of [
      () => {
        const fetchImpl = probeOkFetch();
        return {
          fetchImpl,
          adapter: createOpenAiCompatibleAdapter({ ...testEnvOk }, freeRef, {
            fetchImpl: fetchImpl as typeof fetch,
          }),
        };
      },
      () => {
        const fetchImpl = probeOkFetch();
        return {
          fetchImpl,
          adapter: providerAdapterFactory({ ...testEnvOk }, {
            fetchImpl: fetchImpl as typeof fetch,
          })(endpointStub),
        };
      },
    ]) {
      const { fetchImpl, adapter } = make();
      const result = await adapter.generate({ control: 'c', data: 'd', max_tokens: 16 });
      expect(result.text).toBe('CC4-PROBE-OK');
      expect(result.provider).toBe('groq');
      expect(result.model).toBe(GROQ_FREE_MODEL);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('Groq Paid / hors allowlist refusés même avec attestation', () => {
    const fetchImpl = deadFetch();
    const opts = { freeProjectAttested: true as const, fetchImpl };
    expectCode(() => parseOpenAiCompatibleRef('groq:llama-3.3-70b-versatile', opts), 'EXECUTOR_PAID_MODEL');
    expectCode(() => parseOpenAiCompatibleRef('groq:openai/gpt-oss-120b', opts), 'EXECUTOR_PAID_MODEL');
    expectCode(() => parseOpenAiCompatibleRef('groq:unknown-model', opts), 'EXECUTOR_UNSUPPORTED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Groq mock : 429 / timeout / vide sans fuite secret', async () => {
    const secretEnv = { ...testEnvOk, LLM_KEY_GROQ: 'secret-must-not-leak' };
    const { fetchImpl, calls } = countingStatusFetch(429);
    await expectRejectCode(
      createOpenAiCompatibleAdapter(secretEnv, freeRef, { fetchImpl })
        .generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_UPSTREAM_HTTP',
      ['secret-must-not-leak', 'upstream'],
    );
    expect(calls()).toBe(1);

    await expectRejectCode(
      createOpenAiCompatibleAdapter(secretEnv, freeRef, { fetchImpl: hangFetch(), timeout_ms: 20 })
        .generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_TIMEOUT',
      ['secret-must-not-leak'],
    );

    const empty = vi.fn(async () => okJson({
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 10, completion_tokens: 256 },
    }));
    await expectRejectCode(
      createOpenAiCompatibleAdapter({ ...testEnvOk }, freeRef, { fetchImpl: empty as typeof fetch })
        .generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_BAD_RESPONSE',
    );
  });

  it('DeepSeek / xAI Paid → PAID_MODEL avant fetch', () => {
    const fetchImpl = deadFetch();
    expectCode(() => parseOpenAiCompatibleRef('deepseek:deepseek-flash'), 'EXECUTOR_PAID_MODEL');
    expectCode(
      () => createOpenAiCompatibleAdapter({ LLM_KEY_DEEPSEEK: 'k' }, 'deepseek:deepseek-flash', { fetchImpl }),
      'EXECUTOR_PAID_MODEL',
    );
    expectCode(() => parseOpenAiCompatibleRef('xai:grok-4.7'), 'EXECUTOR_PAID_MODEL');
    expectCode(() => parseOpenAiCompatibleRef('xai:grok-3-mini'), 'EXECUTOR_PAID_MODEL');
    expectCode(
      () => createOpenAiCompatibleAdapter({ LLM_KEY_XAI: 'k' }, 'xai:grok-4.7', { fetchImpl }),
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
      { LLM_KEY_ZAI: 'present-secret' }, 'zai:glm-4.7-flash',
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
      { LLM_KEY_OPENROUTER: 'k' }, 'openrouter:acme/model-x:free',
      { fetchImpl: fetchImpl as typeof fetch },
    );
    expect((await adapter.generate({ control: 'c', data: 'd', max_tokens: 8 })).text).toBe('ok-or');
  });

  it('Z.AI vide / timeout / secret absent', async () => {
    await expectRejectCode(
      createOpenAiCompatibleAdapter({ LLM_KEY_ZAI: 'k' }, 'zai:glm-4.7-flash', {
        fetchImpl: vi.fn(async () => okJson({
          choices: [{ message: { content: '' } }],
          usage: { prompt_tokens: 10, completion_tokens: 256 },
        })) as typeof fetch,
      }).generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_BAD_RESPONSE',
    );
    await expectRejectCode(
      createOpenAiCompatibleAdapter({ LLM_KEY_ZAI: 'secret-must-not-leak' }, 'zai:glm-4.7-flash', {
        fetchImpl: hangFetch(), timeout_ms: 20,
      }).generate({ control: 'c', data: 'd', max_tokens: 8 }),
      'EXECUTOR_TIMEOUT',
      ['secret-must-not-leak'],
    );
    const fetchImpl = deadFetch();
    expectUnavailable(
      () => createOpenAiCompatibleAdapter({}, 'zai:glm-4.7-flash', { fetchImpl }),
      fetchImpl as unknown as ReturnType<typeof vi.fn>,
    );
  });
});
