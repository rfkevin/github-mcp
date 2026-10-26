import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  createRun, leaseKeyOf, ModelCallError,
  createXaiModel, parseXaiRef, type ModelClient, type ParticipantEnvelope,
} from '../../../src/collab-store/agentrun';
import { engineFor } from '../../../src/collab-store/agentrun/object';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { apiModelRate } from '../../../src/collab-store/executors/model-rates';
import { XAI_CHAT_COMPLETIONS_URL } from '../../../src/collab-store/executors/openai-compatible';

// CC-7 L2 (PR 2.2, plan CC-PLAN-7 v0.2 S2) — adaptateur xAI du canal payant :
// même contrat ModelClient que Z.ai derrière l’enveloppe PAR PARTICIPANT et le
// registre daté (refs xai: relevées en 2.1). Aucun appel réel : fetch scripté,
// secret factice, dates futures distinctes (2032-05-XX) pour isoler les registres.
// Spécificité xAI : aucune option de raisonnement dans le corps (contrastée
// avec Z.ai) ; les variantes non-reasoning sont des références distinctes du registre.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_976_000_000;
let seq = 0;

/** Enveloppe financée de référence (valeurs P5 Q1, plafonds optionnels à 0). */
const FUNDED: ParticipantEnvelope = { dayCents: 200, cycleCents: 1_000, dayTokens: 0, dayRequests: 0 };

/** Faux fetch : la réponse scriptée suivante, ou l’erreur fournie ; enregistre chaque appel. */
function fetchStub(script: unknown[]) {
  const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const next = script[seen.length - 1];
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('fetch_stub_exhausted');
    return new Response(JSON.stringify(next), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

/** Réponse compatible OpenAI avec usage explicite. */
function reply(content: string, usage: { prompt_tokens: number; completion_tokens: number }) {
  return { choices: [{ message: { content } }], usage };
}

async function freshRun(at: number, maxCostCents = 10_000, participantId = 'vibe') {
  await ensureSchema(db);
  const id = ++seq;
  const input = {
    runId: 'l2x-run-' + id + '-' + Date.now().toString(36), cycleId: 'l2x-cycle-' + id, participantId, taskId: 'l2x',
    taskKind: 'answer', prompt: 'Réponds à la question du cycle.', maxSteps: 10, maxTokens: 1_000_000,
    maxCostCents, deadlineAt: at + 86_400, now: at,
  };
  expect((await createRun(db, input)).created).toBe(true);
  return { ...input, leaseKey: leaseKeyOf(input.cycleId, input.participantId, input.taskId) };
}

async function quotaOf(key: string): Promise<number> {
  return (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(key).first<{ writes: number }>())?.writes ?? 0;
}

async function stepRow(runId: string, n: number) {
  return db.prepare('SELECT reserved_cents, actual_cents, settled FROM agent_paid_steps WHERE run_id = ?1 AND n = ?2')
    .bind(runId, n).first<{ reserved_cents: number; actual_cents: number; settled: number }>();
}

/** Modèle xAI de test : enveloppe financée, secret factice, fetch injecté, horloge fixée. */
function xaiModel(opts: { fetchImpl: typeof fetch; runId: string; at: Date; envelope?: ParticipantEnvelope;
  env?: { LLM_KEY_XAI?: string }; maxOutputTokens?: number; ref?: string }) {
  return createXaiModel({
    env: opts.env ?? { LLM_KEY_XAI: 'xai-test-key-CANARY-never-store' }, ref: opts.ref ?? 'xai:grok-4.7', db, runId: opts.runId,
    envelope: opts.envelope ?? FUNDED,
    schemas: () => [{ name: 'store_context', description: 'Lit le contexte du cycle.', parameters: { type: 'object' } }],
    system: 'S', maxOutputTokens: opts.maxOutputTokens ?? 4_096, fetchImpl: opts.fetchImpl, now: () => opts.at,
  });
}

function call(model: ModelClient, tools: string[] = []) {
  return model.complete({ messages: [{ role: 'user', content: 'go' }], tools, task_kind: 'answer' });
}

describe('CC-7 L2 PR 2.2 — adaptateur xAI : construction', () => {
  it('références refusées à la construction : hors registre xAI, autre fournisseur, maxOutputTokens', () => {
    expect(() => parseXaiRef('xai:grok-4.1-fast')).toThrow(/XAI_MODEL_UNSUPPORTED/);
    expect(() => parseXaiRef('xai:grok-3')).toThrow(/XAI_MODEL_UNSUPPORTED/);
    expect(() => parseXaiRef('zai:glm-5.3')).toThrow(/XAI_MODEL_UNSUPPORTED/);
    expect(() => parseXaiRef('workers-ai:@cf/moonshotai/kimi-k2.6')).toThrow(/XAI_MODEL_UNSUPPORTED/);
    const parsed = parseXaiRef('xai:grok-4.7');
    expect(parsed.model).toBe('grok-4.7');
    expect(parsed.rate).toBe(apiModelRate('xai:grok-4.7'));
    const base = { env: { LLM_KEY_XAI: 'xai-test-key-CANARY-never-store' }, fetchImpl: fetchStub([]).fetchImpl, db,
      runId: 'l2x-x', envelope: FUNDED, schemas: () => [], system: 'S' };
    expect(() => createXaiModel({ ...base, ref: 'xai:grok-4.7', maxOutputTokens: 0 })).toThrow(/maxOutputTokens/);
    expect(() => createXaiModel({ ...base, ref: 'xai:grok-4.7', maxOutputTokens: 8_193 })).toThrow(/maxOutputTokens/);
  });
});

describe('CC-7 L2 PR 2.2 — adaptateur xAI : gardes avant tout appel', () => {
  it('enveloppe 0 : PAID_ENVELOPE_NOT_FUNDED avant tout appel, aucun quota touché', async () => {
    const at = new Date('2032-05-01T10:00:00Z');
    const run = await freshRun(T + 100);
    const stub = fetchStub([reply('jamais', { prompt_tokens: 1, completion_tokens: 1 })]);
    const error = await call(xaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at,
      envelope: { dayCents: 0, cycleCents: 0, dayTokens: 0, dayRequests: 0 } })).catch(e => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).message).toMatch(/PAID_ENVELOPE_NOT_FUNDED/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
    expect(await stepRow(run.runId, 0)).toBeNull();
    expect(await quotaOf('paid:participant:vibe:day:2032-05-01')).toBe(0);
    expect(await quotaOf('paid:participant:vibe:cycle:' + run.cycleId)).toBe(0);
  });

  it('secret LLM_KEY_XAI absent : EXECUTOR_UNAVAILABLE avant toute réservation, aucun quota touché', async () => {
    const at = new Date('2032-05-02T10:00:00Z');
    const run = await freshRun(T + 150);
    const stub = fetchStub([reply('jamais', { prompt_tokens: 1, completion_tokens: 1 })]);
    const error = await call(xaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at, env: {} })).catch(e => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).message).toMatch(/EXECUTOR_UNAVAILABLE/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
    expect(await stepRow(run.runId, 0)).toBeNull();
    expect(await quotaOf('paid:participant:vibe:day:2032-05-02')).toBe(0);
    expect(await quotaOf('paid:participant:vibe:day:2032-05-02:requests')).toBe(0);
  });
});

describe('CC-7 L2 PR 2.2 — adaptateur xAI : réservation et règlement', () => {
  it('parcours nominal : URL et secret xAI, corps OpenAI SANS option thinking, réservation au pire cas, règlement au réel', async () => {
    const at = new Date('2032-05-03T10:00:00Z');
    const run = await freshRun(T + 200);
    const stub = fetchStub([reply('lu', { prompt_tokens: 1_000, completion_tokens: 1_000 })]);
    const result = await call(xaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at }), ['store_context']);
    expect(stub.seen.length).toBe(1);
    expect(stub.seen[0].url).toBe(XAI_CHAT_COMPLETIONS_URL);
    expect(stub.seen[0].headers.get('Authorization')).toBe('Bearer xai-test-key-CANARY-never-store');
    const body = stub.seen[0].body;
    expect(body.model).toBe('grok-4.7');
    expect(body.max_tokens).toBe(4_096);
    // Spécificité xAI : aucune option de raisonnement (contrastée avec Z.ai).
    expect(body.thinking).toBeUndefined();
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'S' });
    expect(messages[1]).toEqual({ role: 'user', content: 'go' });
    expect(body.tools).toEqual([{ type: 'function',
      function: { name: 'store_context', description: 'Lit le contexte du cycle.', parameters: { type: 'object' } } }]);
    // Pire cas : borne d’entrée (octets + forfait par message + schémas d’outils) + 4096 de sortie au
    // tarif relevé grok-4.7 (200/600) → 3 cents réservés ; réel : 1 000 + 1 000 jetons → 1 cent, trop-versé rendu.
    expect(result.usage.cost_cents).toBe(1);
    expect(await stepRow(run.runId, 0)).toEqual({ reserved_cents: 3, actual_cents: 1, settled: 1 });
    expect(await quotaOf('paid:participant:vibe:day:2032-05-03')).toBe(1);
    expect(await quotaOf('paid:participant:vibe:cycle:' + run.cycleId)).toBe(1);
    expect(await quotaOf('paid:participant:vibe:day:2032-05-03:tokens')).toBe(2_000);
    expect(await quotaOf('paid:participant:vibe:day:2032-05-03:requests')).toBe(1);
  });

  it('variante non-reasoning du registre : référence distincte, tarif 125/250', async () => {
    const at = new Date('2032-05-04T10:00:00Z');
    const run = await freshRun(T + 250);
    const stub = fetchStub([reply('ok', { prompt_tokens: 1_000, completion_tokens: 1_000 })]);
    const result = await call(xaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at,
      ref: 'xai:grok-4.20-0309-non-reasoning' }));
    expect(stub.seen[0].body.model).toBe('grok-4.20-0309-non-reasoning');
    expect(stub.seen[0].body.thinking).toBeUndefined();
    expect(result.usage.cost_cents).toBe(1);
  });

  it('rejeu idempotent : une étape déjà réservée (non réglée) ne réserve jamais deux fois', async () => {
    const at = new Date('2032-05-05T10:00:00Z');
    const run = await freshRun(T + 400);
    await db.prepare('INSERT INTO agent_paid_steps (run_id, n, reserved_cents, actual_cents, settled, updated_at) VALUES (?1, 0, 100, 0, 0, 1)')
      .bind(run.runId).run();
    const stub = fetchStub([reply('reprise', { prompt_tokens: 1_000, completion_tokens: 1_000 })]);
    const result = await call(xaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at }));
    expect(stub.seen.length).toBe(1);
    expect(result.usage.cost_cents).toBe(1);
    expect(await stepRow(run.runId, 0)).toEqual({ reserved_cents: 100, actual_cents: 1, settled: 1 });
    // Aucune nouvelle réservation : les registres du participant restent absents.
    expect(await quotaOf('paid:participant:vibe:day:2032-05-05')).toBe(0);
    expect(await quotaOf('paid:participant:vibe:cycle:' + run.cycleId)).toBe(0);
    expect(await quotaOf('paid:participant:vibe:day:2032-05-05:requests')).toBe(0);
  });

  it('PAID_STEP_ALREADY_SETTLED : une étape déjà réglée rejouée est refusée fail-closed, sans appel', async () => {
    const at = new Date('2032-05-06T10:00:00Z');
    const run = await freshRun(T + 500);
    await db.prepare('INSERT INTO agent_paid_steps (run_id, n, reserved_cents, actual_cents, settled, updated_at) VALUES (?1, 0, 3, 1, 1, 1)')
      .bind(run.runId).run();
    const stub = fetchStub([]);
    const error = await call(xaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at })).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/PAID_STEP_ALREADY_SETTLED/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
  });

  it('erreur du fournisseur : xai_error, réserve laissée au pire cas, usage au pire cas, rejeu refusé', async () => {
    const at = new Date('2032-05-07T10:00:00Z');
    const run = await freshRun(T + 600);
    const stub = fetchStub([new Error('boom')]);
    const error = await call(xaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at })).catch(e => e) as ModelCallError;
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error.message).toMatch(/xai_error/);
    expect(error.usage!.tokens).toBeGreaterThan(0);
    expect(error.usage!.cost_cents).toBe(3);
    expect(await quotaOf('paid:participant:vibe:day:2032-05-07')).toBe(3);
    expect(await quotaOf('paid:participant:vibe:cycle:' + run.cycleId)).toBe(3);
    // Jetons réservés au pire cas (borne d’entrée + sortie maximale), aucun remboursement.
    expect(await quotaOf('paid:participant:vibe:day:2032-05-07:tokens')).toBeGreaterThan(4_000);
    expect(await quotaOf('paid:participant:vibe:day:2032-05-07:requests')).toBe(1);
    expect(await stepRow(run.runId, 0)).toEqual({ reserved_cents: 3, actual_cents: 3, settled: 1 });
    const replay = await call(xaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at })).catch(e => e);
    expect((replay as ModelCallError).message).toMatch(/PAID_STEP_ALREADY_SETTLED/);
    expect(stub.seen.length).toBe(1);
  });

  it('jamais de découvert : un usage forgé énorme est plafonné à la réservation', async () => {
    const at = new Date('2032-05-08T10:00:00Z');
    const run = await freshRun(T + 700);
    const stub = fetchStub([reply('gouffre', { prompt_tokens: 500_000_000, completion_tokens: 500_000_000 })]);
    const result = await call(xaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at }));
    expect(result.usage.cost_cents).toBe(3);
    expect(await quotaOf('paid:participant:vibe:day:2032-05-08')).toBe(3);
    expect(await quotaOf('paid:participant:vibe:cycle:' + run.cycleId)).toBe(3);
    expect(await stepRow(run.runId, 0)).toEqual({ reserved_cents: 3, actual_cents: 3, settled: 1 });
  });

  it('PAID_RUN_BUDGET_EXCEEDED : refus préemptif avant toute réservation si le pire cas dépasse le plafond de l’exécution', async () => {
    const at = new Date('2032-05-09T10:00:00Z');
    const run = await freshRun(T + 800, 1);
    const stub = fetchStub([]);
    const error = await call(xaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at })).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/PAID_RUN_BUDGET_EXCEEDED/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
    expect(await stepRow(run.runId, 0)).toBeNull();
    expect(await quotaOf('paid:participant:vibe:day:2032-05-09')).toBe(0);
  });
});

describe('CC-7 L2 PR 2.2 — câblage engineFor', () => {
  it('xai: sans binding AI part sur l’adaptateur xAI, pas sur le modèle simulé', async () => {
    // Contraste : un payant workers-ai sans binding AI retombe sur le simulé (garde 7c-1).
    const noAi = engineFor({ AGENT_RUN_PAID_MODEL: 'workers-ai:@cf/zai-org/glm-5.3' }, db)('r');
    expect((await noAi.model.complete({ messages: [], tools: [], task_kind: 'answer' })).output.text).toContain('simulée');
    // xai: sans secret, enveloppe financée : refus typé de l’adaptateur, preuve du dispatch.
    const xai = engineFor({ AGENT_RUN_PAID_MODEL: 'xai:grok-4.7',
      AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS: '200', AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS: '1000' }, db)('r');
    const error = await xai.model.complete({ messages: [{ role: 'user', content: 'q' }], tools: [], task_kind: 'answer' }).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/EXECUTOR_UNAVAILABLE/);
    // Sans variables d’enveloppe : fail-closed avant tout appel.
    const noEnvelope = engineFor({ AGENT_RUN_PAID_MODEL: 'xai:grok-4.7' }, db)('r');
    const refused = await noEnvelope.model.complete({ messages: [{ role: 'user', content: 'q' }], tools: [], task_kind: 'answer' }).catch(e => e);
    expect((refused as ModelCallError).message).toMatch(/PAID_ENVELOPE_NOT_FUNDED/);
    // Référence xai: hors registre : refus à la construction.
    expect(() => engineFor({ AGENT_RUN_PAID_MODEL: 'xai:grok-4.1-fast',
      AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS: '200', AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS: '1000' }, db)('r'))
      .toThrow(/XAI_MODEL_UNSUPPORTED/);
  });
});
