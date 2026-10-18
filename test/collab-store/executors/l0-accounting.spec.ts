import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { sha256Hex } from '../../../src/collab-store/store/hash';
import {
  attachUsage, createWorkersAiAdapter, dispatchFreeInvocation, MODEL_CALL_OPTIONS,
  probeEndpoint, readWorkersAiOutput, usageOf, workersAiFactory, type WorkersAiBinding,
} from '../../../src/collab-store/executors';
import { PROVIDER_TIMEOUT_MS, providerTimeoutMs } from '../../../src/collab-store/executors/fetch-timeout';

// CC-5 L0 — dettes de comptabilité X14 (usage réel sur échec, délai par
// fournisseur, sortie conservée au rejeu) et garde corps vide gemma (X4).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const ownerProof = { kind: 'secret' as const, subject: 'owner-secret' };
const REF = 'workers-ai:@cf/zai-org/glm-4.7-flash';
const GEMMA_REF = 'workers-ai:@cf/google/gemma-4-26b-a4b-it';
const CONTROL = 'Résume les données en une phrase.';
let seq = 0;
const tag = (base: string) => 'l0-' + base + '-' + Date.now().toString(36) + '-' + ++seq;

async function trap(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as { code: string }).code; }
  return 'NO_ERROR';
}

function capture(throwing: () => unknown): unknown {
  try { throwing(); } catch (error) { return error; }
  throw new Error('le cas devait lever');
}

/** Endpoint actif semé directement : le chemin owner complet est couvert par free-api.spec.ts. */
async function seedActiveEndpoint(endpointId: string, ceiling = 512): Promise<string> {
  await ensureSchema(db);
  await db.prepare(
    'INSERT INTO endpoints (endpoint_id, principal_id, attestation_kind, attestation_ref, status, capability_set, registered_at)'
    + " VALUES (?1, ?2, 'provider_adapter', ?3, 'active', ?4, ?5)",
  ).bind(endpointId, 'p-' + endpointId, REF,
    JSON.stringify({ tools: ['llm.generate'], network_providers: ['workers-ai'], token_ceiling: ceiling }),
    Math.floor(Date.now() / 1000)).run();
  return endpointId;
}

async function queuedInvocation(endpointId: string, principal = 'p-' + endpointId, packet = '{"packet":"l0"}') {
  const store = new CollabStore(db, { dailyWriteLimit: 100_000 });
  const cycle = tag('cyc');
  const appended = await store.appendActionableEvent(
    { cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 0,
      payload_json: '{"action":"wake"}', op_id: 'agent.a:' + cycle + ':wake:1' },
    { cycle_id: cycle, task_id: 't1', role: 'owner', principal_id: principal, endpoint_id: endpointId,
      reason: 'task_actionable', source_revision: 1, input_packet: packet, evidence_refs: ['github-mcp#l0'] },
  );
  if (appended.status !== 'applied' || !appended.invocation) throw new Error('fixture: invocation non créée');
  return appended.invocation;
}

describe('CC-5 L0 — délai par fournisseur (X14)', () => {
  it('défauts et bornes par fournisseur ; fournisseur inconnu : 30 s', () => {
    expect(providerTimeoutMs('groq')).toBe(30_000);
    expect(providerTimeoutMs('gemini')).toBe(60_000);
    expect(providerTimeoutMs('zai')).toBe(90_000);
    expect(providerTimeoutMs('workers-ai')).toBe(60_000);
    expect(providerTimeoutMs('deepseek')).toBe(60_000);
    expect(providerTimeoutMs('inconnu')).toBe(30_000);
    expect(providerTimeoutMs('groq', 20)).toBe(20);
    expect(providerTimeoutMs('groq', 999_999)).toBe(PROVIDER_TIMEOUT_MS.groq.max_ms);
    expect(providerTimeoutMs('gemini', 90_000)).toBe(90_000);
    expect(providerTimeoutMs('gemini', 999_999)).toBe(120_000);
    expect(providerTimeoutMs('workers-ai', 0)).toBe(1);
  });
});

describe('CC-5 L0 — usage réel sur échec (X14)', () => {
  it('readWorkersAiOutput : corps vide ou null → EXECUTOR_BAD_RESPONSE avec usage attaché', () => {
    const blank = capture(() => readWorkersAiOutput({ response: '   ', usage: { prompt_tokens: 12, completion_tokens: 3 } }));
    expect(blank).toMatchObject({ code: 'EXECUTOR_BAD_RESPONSE' });
    expect(usageOf(blank)).toEqual({ input_tokens: 12, output_tokens: 3 });
    const nullish = capture(() => readWorkersAiOutput({ choices: [{ message: { content: null } }], usage: { prompt_tokens: 5 } }));
    expect(nullish).toMatchObject({ code: 'EXECUTOR_BAD_RESPONSE' });
    expect(usageOf(nullish)).toEqual({ input_tokens: 5 });
    expect(usageOf(new Error('sans usage'))).toBeNull();
  });

  it('dispatch : échec fournisseur avec usage attaché → tentative comptée aux jetons réels, pas 0/0', async () => {
    const endpointId = await seedActiveEndpoint(tag('ep'));
    const invocation = await queuedInvocation(endpointId);
    const boom: WorkersAiBinding = {
      run: async () => {
        throw attachUsage(Object.assign(new Error('corps vide amont'), { code: 'UPSTREAM_EMPTY' }),
          { input_tokens: 11, output_tokens: 7 });
      },
    };
    const outcome = await dispatchFreeInvocation(db, workersAiFactory(boom), {
      wake_key: invocation.wake_key, worker_id: 'w-l0', control: CONTROL, input_packet: '{"packet":"l0"}', max_tokens: 256,
    });
    expect(outcome).toMatchObject({ status: 'attempt_failed', error: 'UPSTREAM_EMPTY' });
    expect(outcome.invocation).toMatchObject({ state: 'queued', consecutive_failures: 1,
      usage_input_tokens: 11, usage_output_tokens: 7, usage_operations: 1 });
  });

  it('sonde : échec avec usage attaché → décision owner aux jetons réels', async () => {
    const endpointId = await seedActiveEndpoint(tag('ep'));
    const boom: WorkersAiBinding = {
      run: async () => {
        throw attachUsage(Object.assign(new Error('amont vide'), { code: 'UPSTREAM_EMPTY' }), { input_tokens: 9, output_tokens: 4 });
      },
    };
    const probed = await probeEndpoint(db, workersAiFactory(boom), { endpoint_id: endpointId, proof: ownerProof, op: tag('probe') });
    expect(probed.ok).toBe(false);
    expect(JSON.parse(probed.event.payload_json)).toMatchObject({ action: 'endpoint_probe', ok: false,
      error: 'UPSTREAM_EMPTY', usage: { input_tokens: 9, output_tokens: 4 } });
  });
});

describe('CC-5 L0 — sortie conservée au rejeu (X14)', () => {
  it('succès : output_text stocké ; rejeu → terminal avec la sortie, aucun nouvel appel', async () => {
    const endpointId = await seedActiveEndpoint(tag('ep'));
    const invocation = await queuedInvocation(endpointId);
    const calls: Array<Record<string, unknown>> = [];
    const ai: WorkersAiBinding = {
      run: async (_model, input) => {
        calls.push(input);
        return { response: 'Sortie L0.', usage: { prompt_tokens: 40, completion_tokens: 6 } };
      },
    };
    const done = await dispatchFreeInvocation(db, workersAiFactory(ai), {
      wake_key: invocation.wake_key, worker_id: 'w-l0', control: CONTROL, input_packet: '{"packet":"l0"}', max_tokens: 256,
    });
    expect(done).toMatchObject({ status: 'succeeded', output: 'Sortie L0.' });
    const stored = await db.prepare('SELECT output_text, output_hash FROM invocations WHERE wake_key = ?1')
      .bind(invocation.wake_key).first<{ output_text: string; output_hash: string }>();
    expect(stored).toMatchObject({ output_text: 'Sortie L0.', output_hash: await sha256Hex('Sortie L0.') });

    const replay = await dispatchFreeInvocation(db, workersAiFactory(ai), {
      wake_key: invocation.wake_key, worker_id: 'w-l0', control: CONTROL, input_packet: '{"packet":"l0"}', max_tokens: 256,
    });
    expect(replay).toMatchObject({ status: 'terminal', output: 'Sortie L0.' });
    expect(replay.invocation.state).toBe('succeeded');
    expect(calls).toHaveLength(1);
  });

  it('sortie au-delà de 65 536 caractères : output_text borné, empreinte de la sortie complète', async () => {
    const endpointId = await seedActiveEndpoint(tag('ep'));
    const invocation = await queuedInvocation(endpointId);
    const huge = 'z'.repeat(70_000);
    const ai: WorkersAiBinding = {
      run: async () => ({ response: huge, usage: { prompt_tokens: 40, completion_tokens: 100 } }),
    };
    const done = await dispatchFreeInvocation(db, workersAiFactory(ai), {
      wake_key: invocation.wake_key, worker_id: 'w-l0', control: CONTROL, input_packet: '{"packet":"l0"}', max_tokens: 256,
    });
    expect(done.status).toBe('succeeded');
    const stored = await db.prepare('SELECT LENGTH(output_text) AS n, output_hash FROM invocations WHERE wake_key = ?1')
      .bind(invocation.wake_key).first<{ n: number; output_hash: string }>();
    expect(stored?.n).toBe(65_536);
    expect(stored?.output_hash).toBe(await sha256Hex(huge));
  });
});

describe('CC-5 L0 — gemma-4-26b : raisonnement coupé (X4)', () => {
  it('MODEL_CALL_OPTIONS porte enable_thinking=false pour gemma et le transmet à Workers AI', async () => {
    expect(MODEL_CALL_OPTIONS['@cf/google/gemma-4-26b-a4b-it']).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    const calls: Array<Record<string, unknown>> = [];
    const ai: WorkersAiBinding = {
      run: async (_model, input) => {
        calls.push(input);
        return { response: 'ok gemma', usage: { prompt_tokens: 20, completion_tokens: 4 } };
      },
    };
    const adapter = createWorkersAiAdapter(ai, GEMMA_REF);
    const result = await adapter.generate({ control: CONTROL, data: 'x', max_tokens: 64 });
    expect(result.model).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(calls[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, max_tokens: 64 });
  });
});

describe('CC-5 L0 — garde coroutine : usageOf ne lit que des compteurs', () => {
  it('usage attaché non numérique ou partiel : seulement les champs sûrs', () => {
    expect(usageOf(attachUsage(new Error('x'), { input_tokens: 3 }))).toEqual({ input_tokens: 3 });
    expect(usageOf(attachUsage(new Error('x'), {}))).toBeNull();
    expect(usageOf({ usage: 'corrompu' })).toBeNull();
    expect(usageOf(null)).toBeNull();
    expect(await trap(Promise.reject(Object.assign(new Error('y'), { code: 'Z' })))).toBe('Z');
  });
});
