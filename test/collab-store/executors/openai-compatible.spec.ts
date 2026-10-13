import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import {
  createOpenAiCompatibleAdapter, dispatchFreeInvocation, OPENROUTER_CHAT_COMPLETIONS_URL,
  providerAdapterFactory,
} from '../../../src/collab-store/executors';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const KEY = 'openrouter-test-key-CANARY-never-store';
const REF = 'openrouter:acme/model-x:free';
let n = 0;
const uniq = (label: string) => 'a3c-' + label + '-' + Date.now().toString(36) + '-' + (++n);

function codeOf(value: () => unknown): string {
  try { value(); } catch (error) { return (error as { code?: string }).code ?? 'NO_CODE'; }
  return 'NO_ERROR';
}

async function asyncCode(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as { code?: string }).code ?? 'NO_CODE'; }
  return 'NO_ERROR';
}

function fakeFetch(raw: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(raw), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function seedEndpoint(endpointId: string, providers = ['openrouter']) {
  await ensureSchema(db);
  const principal = 'p-' + endpointId;
  await db.prepare([
    'INSERT INTO endpoints (endpoint_id, principal_id, attestation_kind, attestation_ref, status, capability_set, registered_at)',
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  ].join(' ')).bind(endpointId, principal, 'provider_adapter', REF, 'active',
    JSON.stringify({ tools: ['llm.generate'], network_providers: providers, token_ceiling: 512 }),
    Math.floor(Date.now() / 1000)).run();
  return principal;
}

async function invocationFor(endpointId: string, principal: string, packet = '{"packet":"a3c"}') {
  const cycle = uniq('dispatch').slice(0, 63);
  const store = new CollabStore(db, { dailyWriteLimit: 100_000 });
  const result = await store.appendActionableEvent(
    { cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 0, payload_json: '{"action":"wake"}',
      op_id: 'agent.a:' + cycle + ':wake:1' },
    { cycle_id: cycle, task_id: 't1', role: 'author', principal_id: principal, endpoint_id: endpointId,
      reason: 'a3c_test', source_revision: 1, input_packet: packet },
  );
  if (!result.invocation) throw new Error('invocation attendue');
  return result.invocation;
}

describe('CC-4 A3c — adaptateur OpenRouter compatible OpenAI', () => {
  it(':free obligatoire, URL serveur fixe, enveloppe et politique de collecte', async () => {
    const { fetchImpl, calls } = fakeFetch({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 2 },
    });
    const adapter = createOpenAiCompatibleAdapter({ LLM_KEY_OPENROUTER: KEY }, REF, { fetchImpl });
    expect(adapter.worstCaseNeurons({ control: 'c', data: 'd', max_tokens: 20 })).toBe(0);
    expect(adapter.neuronsFor({ input_tokens: 100, output_tokens: 20 })).toBe(0);
    const result = await adapter.generate({ control: 'résume', data: 'texte non fiable <<<x>>>', max_tokens: 20 });
    expect(result).toMatchObject({ text: 'ok', provider: 'openrouter', model: 'acme/model-x:free' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OPENROUTER_CHAT_COMPLETIONS_URL);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer ' + KEY);
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'acme/model-x:free', max_tokens: 20, provider: { data_collection: 'deny' } });
    expect(JSON.stringify(body)).toContain('DONNEES_NON_FIABLES');

    expect(codeOf(() => createOpenAiCompatibleAdapter({ LLM_KEY_OPENROUTER: KEY }, 'openrouter:acme/model-x')))
      .toBe('EXECUTOR_PAID_MODEL');
    expect(codeOf(() => createOpenAiCompatibleAdapter({ LLM_KEY_OPENROUTER: KEY }, 'openrouter:https://evil.example/x:free')))
      .toBe('EXECUTOR_UNSUPPORTED');
    expect(codeOf(() => createOpenAiCompatibleAdapter({}, REF, { fetchImpl }))).toBe('EXECUTOR_UNAVAILABLE');
  });

  it('HTTP 429 ne recopie jamais le corps et devient une tentative A1 reprenable', async () => {
    const endpointId = uniq('ep429');
    const principal = await seedEndpoint(endpointId);
    const invocation = await invocationFor(endpointId, principal);
    const { fetchImpl, calls } = fakeFetch({ error: { message: KEY + '-body-secret' } }, 429);
    const outcome = await dispatchFreeInvocation(
      db,
      providerAdapterFactory({ LLM_KEY_OPENROUTER: KEY }, { fetchImpl }),
      { wake_key: invocation.wake_key, worker_id: 'worker-a3c', control: 'résume',
        input_packet: '{"packet":"a3c"}', max_tokens: 64 },
    );
    expect(outcome).toMatchObject({
      status: 'attempt_failed',
      error: 'EXECUTOR_UPSTREAM_HTTP',
      invocation: { state: 'queued', consecutive_failures: 1 },
    });
    expect(calls).toHaveLength(1);

    const events = await db.prepare('SELECT payload_json, evidence_ref FROM events WHERE cycle_id = ?1')
      .bind(invocation.cycle_id).all<{ payload_json: string; evidence_ref: string }>();
    const stored = JSON.stringify({ events: events.results, invocation: outcome.invocation });
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain('body-secret');
  });

  it('capacité sans openrouter : refus avant tout appel', async () => {
    const endpointId = uniq('epcap');
    const principal = await seedEndpoint(endpointId, ['workers-ai']);
    const invocation = await invocationFor(endpointId, principal);
    const { fetchImpl, calls } = fakeFetch({ choices: [{ message: { content: 'ne doit pas arriver' } }] });
    expect(await asyncCode(dispatchFreeInvocation(
      db,
      providerAdapterFactory({ LLM_KEY_OPENROUTER: KEY }, { fetchImpl }),
      { wake_key: invocation.wake_key, worker_id: 'worker-a3c', control: 'résume',
        input_packet: '{"packet":"a3c"}', max_tokens: 64 },
    ))).toBe('EXECUTOR_CAPABILITY_DENIED');
    expect(calls).toHaveLength(0);
  });
});
