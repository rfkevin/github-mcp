import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  createRun, runStep, leaseKeyOf, ModelCallError, createReadToolHost,
  createPaidWorkersAiModel, centsOfNeurons, PAID_MODEL_RATES, type AgentMessage, type ModelClient,
} from '../../../src/collab-store/agentrun';
import { engineFor } from '../../../src/collab-store/agentrun/object';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { FREE_MODEL_RATES, WORKERS_AI_PAID_ONLY_MODELS } from '../../../src/collab-store/executors/adapter';
import { reserveNeurons } from '../../../src/collab-store/executors/run';

// CC-5 l7 incrément 7d (amendement A5) — modèles Workers AI payants derrière l’enveloppe
// owner : bornes typées, réservation par étape idempotente, règlement au réel,
// jamais de découvert. Aucun appel réel : binding AI simulé, tarifs datés en code.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const GLM53 = 'workers-ai:@cf/zai-org/glm-5.3';
const T = 1_975_000_000;
let seq = 0;

interface Seen { model: string; input: Record<string, unknown> }

/** Faux binding AI : la réponse scriptée suivante, ou l’erreur fournie. */
function aiStub(script: unknown[]) {
  const seen: Seen[] = [];
  return {
    seen,
    async run(model: string, input: Record<string, unknown>) {
      seen.push({ model, input });
      const next = script[seen.length - 1];
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error('ai_stub_exhausted');
      return next;
    },
  };
}

/** Réponse compatible OpenAI avec usage explicite. */
function reply(content: string, usage: { prompt_tokens: number; completion_tokens: number },
  calls: Array<{ id: string; name: string; args: unknown }> = []) {
  return {
    choices: [{ message: { content, tool_calls: calls.map(call => ({
      id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
    })) } }],
    usage,
  };
}

async function newRun(at: number, maxCostCents = 10_000) {
  await ensureSchema(db);
  const id = ++seq;
  const input = {
    runId: 'l7d-run-' + id + '-' + Date.now().toString(36), cycleId: 'l7d-cycle-' + id, participantId: 'vibe', taskId: 'l7d',
    taskKind: 'research', prompt: 'Lis le contexte et résume.', maxSteps: 10, maxTokens: 1_000_000,
    maxCostCents, deadlineAt: at + 86_400, now: at,
  };
  expect((await createRun(db, input)).created).toBe(true);
  return { ...input, leaseKey: leaseKeyOf(input.cycleId, input.participantId, input.taskId) };
}

async function seedCycle(cycle: string) {
  const store = new CollabStore(db);
  await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:seed', expected_rev: 0,
    payload_json: JSON.stringify({ note: 'amorce' }), op_id: 'agent.seed:' + cycle + ':seed:1' });
}

async function paidUsed(key: string): Promise<number> {
  return (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(key).first<{ writes: number }>())?.writes ?? 0;
}

async function paidStep(runId: string, n: number) {
  return db.prepare('SELECT reserved_cents, actual_cents, settled FROM agent_paid_steps WHERE run_id = ?1 AND n = ?2')
    .bind(runId, n).first<{ reserved_cents: number; actual_cents: number; settled: number }>();
}

function paid(opts: { ai: ReturnType<typeof aiStub>; runId: string; at: Date; envelopeCents: number;
  cycleCents?: number; maxOutputTokens?: number; ref?: string }) {
  return createPaidWorkersAiModel({
    ai: opts.ai, ref: opts.ref ?? GLM53, db, runId: opts.runId,
    envelopeCents: opts.envelopeCents, cycleCents: opts.cycleCents ?? opts.envelopeCents,
    schemas: () => [], system: 'S', maxOutputTokens: opts.maxOutputTokens ?? 4096, now: () => opts.at,
  });
}

function call(model: ModelClient) {
  return model.complete({ messages: [{ role: 'user', content: 'go' }], tools: [], task_kind: 'research' });
}

describe('CC-5 l7d — instantané daté et deny-by-default', () => {
  it('taux : exactement les 7 modèles payants du dépôt, aucun modèle gratuit ; centsOfNeurons arrondi au cent supérieur', () => {
    expect(Object.keys(PAID_MODEL_RATES).sort()).toEqual([...WORKERS_AI_PAID_ONLY_MODELS].sort());
    for (const model of Object.keys(PAID_MODEL_RATES)) expect(FREE_MODEL_RATES[model]).toBeUndefined();
    expect(centsOfNeurons(0)).toBe(0);
    expect(centsOfNeurons(1)).toBe(1);
    expect(centsOfNeurons(909)).toBe(1);
    expect(centsOfNeurons(910)).toBe(2);
    expect(centsOfNeurons(10_000)).toBe(11);
    expect(centsOfNeurons(-5)).toBe(0);
  });

  it('référence hors liste payante (modèle gratuit, inconnu, autre fournisseur) refusée à la construction', () => {
    const base = { ai: aiStub([]), db, runId: 'l7d-x', envelopeCents: 100, cycleCents: 100,
      schemas: () => [], system: 'S', maxOutputTokens: 64 };
    expect(() => createPaidWorkersAiModel({ ...base, ref: 'workers-ai:@cf/zai-org/glm-4.7-flash' })).toThrow(/PAID_MODEL_UNSUPPORTED/);
    expect(() => createPaidWorkersAiModel({ ...base, ref: 'workers-ai:@cf/nobody/inconnu' })).toThrow(/PAID_MODEL_UNSUPPORTED/);
    expect(() => createPaidWorkersAiModel({ ...base, ref: 'openrouter:v/x' })).toThrow(/PAID_MODEL_UNSUPPORTED/);
    expect(() => createPaidWorkersAiModel({ ...base, ref: GLM53, maxOutputTokens: 0 })).toThrow(/maxOutputTokens/);
  });
});

describe('CC-5 l7d — enveloppe et bornes typées', () => {
  it('enveloppe 0 ou absente : PAID_ENVELOPE_NOT_FUNDED avant tout appel, aucun quota touché', async () => {
    const at = new Date('2032-03-01T10:00:00Z');
    const run = await newRun(T);
    const stub = aiStub([reply('jamais', { prompt_tokens: 1, completion_tokens: 1 })]);
    const error = await call(paid({ ai: stub, runId: run.runId, at, envelopeCents: 0 })).catch(e => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).message).toMatch(/PAID_ENVELOPE_NOT_FUNDED/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
    expect(await paidStep(run.runId, 0)).toBeNull();
    expect(await paidUsed('paid:day:2032-03-01')).toBe(0);
    expect(await paidUsed('paid:cycle:' + run.cycleId)).toBe(0);
  });

  it('PAID_RUN_BUDGET_EXCEEDED : refus préemptif avant toute réservation si le pire cas dépasse le plafond', async () => {
    const at = new Date('2032-03-02T10:00:00Z');
    const run = await newRun(T + 100, 1);
    const stub = aiStub([]);
    const error = await call(paid({ ai: stub, runId: run.runId, at, envelopeCents: 1_000 })).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/PAID_RUN_BUDGET_EXCEEDED/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
    expect(await paidStep(run.runId, 0)).toBeNull();
    expect(await paidUsed('paid:day:2032-03-02')).toBe(0);
  });

  it('PAID_DAILY_BUDGET_EXCEEDED : le jour épuisé refuse la seconde exécution sans rien écrire', async () => {
    const at = new Date('2032-03-03T10:00:00Z');
    const first = await newRun(T + 200);
    const second = await newRun(T + 200);
    const stub = aiStub([reply('ok', { prompt_tokens: 100, completion_tokens: 20 })]);
    const ok = await call(paid({ ai: stub, runId: first.runId, at, envelopeCents: 2 }));
    expect(ok.usage.cost_cents).toBe(1);
    const error = await call(paid({ ai: stub, runId: second.runId, at, envelopeCents: 2 })).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/PAID_DAILY_BUDGET_EXCEEDED/);
    expect(stub.seen.length).toBe(1);
    expect(await paidStep(second.runId, 0)).toBeNull();
    expect(await paidUsed('paid:day:2032-03-03')).toBe(1);
    expect(await paidUsed('paid:cycle:' + second.cycleId)).toBe(0);
  });

  it('PAID_CYCLE_BUDGET_EXCEEDED : lot atomique — ni registre du jour ni ligne d’étape écrits', async () => {
    const at = new Date('2032-03-04T10:00:00Z');
    const run = await newRun(T + 300);
    const stub = aiStub([]);
    const error = await call(paid({ ai: stub, runId: run.runId, at, envelopeCents: 100, cycleCents: 1 })).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/PAID_CYCLE_BUDGET_EXCEEDED/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
    expect(await paidStep(run.runId, 0)).toBeNull();
    expect(await paidUsed('paid:day:2032-03-04')).toBe(0);
    expect(await paidUsed('paid:cycle:' + run.cycleId)).toBe(0);
  });
});

describe('CC-5 l7d — réservation, règlement, idempotence', () => {
  it('réserve le pire cas avant l’appel puis règle au réel : trop-versé rendu sur les deux registres', async () => {
    const at = new Date('2032-03-05T10:00:00Z');
    const run = await newRun(T + 400);
    const stub = aiStub([reply('lu', { prompt_tokens: 100, completion_tokens: 20 })]);
    const result = await call(paid({ ai: stub, runId: run.runId, at, envelopeCents: 1_000 }));
    expect(stub.seen.length).toBe(1);
    expect(stub.seen[0].model).toBe('@cf/zai-org/glm-5.3');
    const sent = stub.seen[0].input as { max_tokens: number; messages: Array<{ role: string; content: string }> };
    expect(sent.max_tokens).toBe(4096);
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'S' });
    // Pire cas : ~1 652 neurons → 2 cents ; réel : ~21 neurons → 1 cent.
    expect(result.usage.cost_cents).toBe(1);
    expect(await paidStep(run.runId, 0)).toEqual({ reserved_cents: 2, actual_cents: 1, settled: 1 });
    expect(await paidUsed('paid:day:2032-03-05')).toBe(1);
    expect(await paidUsed('paid:cycle:' + run.cycleId)).toBe(1);
    // B1 : les neurons réels (100 + 20 jetons → 21) décomptent le pool gratuit partagé du compte.
    expect(await paidUsed('neurons:workers-ai:2032-03-05')).toBe(21);
  });

  it('rejeu idempotent : une étape déjà réservée (non réglée) ne réserve jamais deux fois', async () => {
    const at = new Date('2032-03-06T10:00:00Z');
    const run = await newRun(T + 500);
    await db.prepare('INSERT INTO agent_paid_steps (run_id, n, reserved_cents, actual_cents, settled, updated_at) VALUES (?1, 0, 100, 0, 0, 1)')
      .bind(run.runId).run();
    const stub = aiStub([reply('reprise', { prompt_tokens: 100, completion_tokens: 20 })]);
    const result = await call(paid({ ai: stub, runId: run.runId, at, envelopeCents: 1_000 }));
    expect(stub.seen.length).toBe(1);
    expect(result.usage.cost_cents).toBe(1);
    // Aucune nouvelle réservation : les registres restent absents, la ligne existante est réglée.
    expect(await paidUsed('paid:day:2032-03-06')).toBe(0);
    expect(await paidUsed('paid:cycle:' + run.cycleId)).toBe(0);
    expect(await paidStep(run.runId, 0)).toEqual({ reserved_cents: 100, actual_cents: 1, settled: 1 });
  });

  it('PAID_STEP_ALREADY_SETTLED : une étape déjà réglée rejouée est refusée fail-closed, sans appel', async () => {
    const at = new Date('2032-03-07T10:00:00Z');
    const run = await newRun(T + 600);
    await db.prepare('INSERT INTO agent_paid_steps (run_id, n, reserved_cents, actual_cents, settled, updated_at) VALUES (?1, 0, 2, 1, 1, 1)')
      .bind(run.runId).run();
    const stub = aiStub([]);
    const error = await call(paid({ ai: stub, runId: run.runId, at, envelopeCents: 1_000 })).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/PAID_STEP_ALREADY_SETTLED/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
  });

  it('erreur du fournisseur : réserve laissée au pire cas, usage au pire cas, rejeu refusé', async () => {
    const at = new Date('2032-03-08T10:00:00Z');
    const run = await newRun(T + 700);
    const stub = aiStub([new Error('boom')]);
    const error = await call(paid({ ai: stub, runId: run.runId, at, envelopeCents: 1_000 })).catch(e => e) as ModelCallError;
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error.usage!.tokens).toBeGreaterThan(0);
    expect(error.usage!.cost_cents).toBe(2);
    expect(await paidUsed('paid:day:2032-03-08')).toBe(2);
    expect(await paidUsed('paid:cycle:' + run.cycleId)).toBe(2);
    // B1 : sur erreur fournisseur, le pire cas en neurons décompte aussi le pool gratuit partagé.
    expect(await paidUsed('neurons:workers-ai:2032-03-08')).toBeGreaterThan(0);
    expect(await paidStep(run.runId, 0)).toEqual({ reserved_cents: 2, actual_cents: 2, settled: 1 });
    const replay = await call(paid({ ai: stub, runId: run.runId, at, envelopeCents: 1_000 })).catch(e => e);
    expect((replay as ModelCallError).message).toMatch(/PAID_STEP_ALREADY_SETTLED/);
    expect(stub.seen.length).toBe(1);
  });

  it('jamais de découvert : un usage forgé énorme est plafonné à la réservation', async () => {
    const at = new Date('2032-03-09T10:00:00Z');
    const run = await newRun(T + 800);
    const stub = aiStub([reply('gouffre', { prompt_tokens: 500_000_000, completion_tokens: 500_000_000 })]);
    const result = await call(paid({ ai: stub, runId: run.runId, at, envelopeCents: 1_000 }));
    expect(result.usage.cost_cents).toBe(2);
    expect(await paidUsed('paid:day:2032-03-09')).toBe(2);
    expect(await paidUsed('paid:cycle:' + run.cycleId)).toBe(2);
    expect(await paidStep(run.runId, 0)).toEqual({ reserved_cents: 2, actual_cents: 2, settled: 1 });
  });

  it('B1 — les neurons payants décomptent le pool gratuit partagé : le budget restant diminue', async () => {
    const at = new Date('2032-03-13T10:00:00Z');
    const run = await newRun(T + 1_200);
    const stub = aiStub([reply('ok', { prompt_tokens: 100, completion_tokens: 20 })]);
    await call(paid({ ai: stub, runId: run.runId, at, envelopeCents: 1_000 }));
    expect(await paidUsed('neurons:workers-ai:2032-03-13')).toBe(21);
    // Contre-épreuve : avec un budget gratuit de 22 neurons pour ce jour, il n’en reste plus qu’un.
    await reserveNeurons(db, 1, 22, at);
    const refused = await reserveNeurons(db, 1, 22, at).catch(error => (error as { code?: string }).code);
    expect(refused).toBe('EXECUTOR_NEURON_BUDGET');
  });

  it('A1 — sans usage rapporté, les jetons sont bornés par les octets envoyés (jamais 0)', async () => {
    const at = new Date('2032-03-10T10:00:00Z');
    const small = await newRun(T + 900);
    const big = await newRun(T + 900);
    const stub = aiStub([{ response: 'fin' }, { response: 'fin' }]);
    const a = await call(paid({ ai: stub, runId: small.runId, at, envelopeCents: 1_000 }));
    const wide: AgentMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 'store_context', args: {} }] },
      { role: 'tool', tool_call_id: 'a', content: 'y'.repeat(16_000) },
    ];
    const b = await paid({ ai: stub, runId: big.runId, at, envelopeCents: 1_000 })
      .complete({ messages: wide, tools: [], task_kind: 'research' });
    expect(b.usage.tokens - a.usage.tokens).toBeGreaterThanOrEqual(16_000);
    expect(b.usage.cost_cents).toBeGreaterThanOrEqual(1);
  });
});

describe('CC-5 l7d — parcours moteur et câblage', () => {
  it('parcours complet : coût cumulé dans agent_runs, une ligne réglée par étape, Go-s à part', async () => {
    const at = new Date('2032-03-11T10:00:00Z');
    const run = await newRun(T + 1_000, 100);
    await seedCycle(run.cycleId);
    const stub = aiStub([
      reply('contexte', { prompt_tokens: 100, completion_tokens: 20 }, [{ id: 'a', name: 'store_context', args: {} }]),
      reply('Résumé : rien à signaler.', { prompt_tokens: 100, completion_tokens: 20 }),
    ]);
    const host = createReadToolHost({ db, repository: null, github: null });
    const model = createPaidWorkersAiModel({ ai: stub, ref: GLM53, db, runId: run.runId, envelopeCents: 100, cycleCents: 100,
      schemas: kind => host.schemas(kind), system: 'S', maxOutputTokens: 4096, now: () => at });
    const deps = { model, tools: host, now: () => T + 1_000, workerId: 'w' };
    expect((await runStep(db, run.runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, run.runId, deps)).outcome).toBe('completed');
    const row = await db.prepare('SELECT cost_cents, steps_done FROM agent_runs WHERE run_id = ?1').bind(run.runId)
      .first<{ cost_cents: number; steps_done: number }>();
    expect(row).toEqual({ cost_cents: 2, steps_done: 2 });
    expect(await paidStep(run.runId, 0)).toEqual({ reserved_cents: 2, actual_cents: 1, settled: 1 });
    expect(await paidStep(run.runId, 1)).toEqual({ reserved_cents: 2, actual_cents: 1, settled: 1 });
    expect(await paidUsed('paid:day:2032-03-11')).toBe(2);
    // Go-s à part ; B1 : les neurons réels des 2 étapes décomptent le pool gratuit partagé du compte.
    expect(await paidUsed('neurons:workers-ai:2032-03-11')).toBe(42);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM agent_run_quota WHERE day = ?1').bind('2032-03-11').first<{ c: number }>())?.c ?? 0).toBe(0);
  });

  it('câblage engineFor : simulé sans env ; payant refusé sans enveloppe ; prioritaire sur le chemin gratuit', async () => {
    expect((await engineFor({}, db)('r').model.complete({ messages: [], tools: [], task_kind: 'x' })).output.text).toContain('simulée');
    const noEnvelope = engineFor({ AGENT_RUN_PAID_MODEL: GLM53, AI: aiStub([]) }, db)('r');
    expect(noEnvelope.tools.list('research')).toEqual(['store_context', 'store_delta']);
    const refused = await noEnvelope.model.complete({ messages: [{ role: 'user', content: 'q' }], tools: [], task_kind: 'research' }).catch(e => e);
    expect((refused as ModelCallError).message).toMatch(/PAID_ENVELOPE_NOT_FUNDED/);
    const at = new Date('2032-03-12T10:00:00Z');
    const run = await newRun(T + 1_100);
    await seedCycle(run.cycleId);
    const stub = aiStub([reply('fin', { prompt_tokens: 100, completion_tokens: 20 })]);
    const deps = engineFor({ AGENT_RUN_PAID_MODEL: GLM53, AGENT_RUN_MODEL: 'workers-ai:@cf/zai-org/glm-4.7-flash',
      AI: stub, AGENT_RUN_PAID_ENVELOPE_CENTS: '100' }, db)(run.runId);
    const result = await deps.model.complete({ messages: [{ role: 'user', content: 'q' }], tools: deps.tools.list('research'), task_kind: 'research' });
    expect(result.usage.cost_cents).toBe(1);
    expect(await paidUsed('paid:cycle:' + run.cycleId)).toBe(1);
    expect(await paidUsed('neurons:workers-ai:2032-03-12')).toBe(21);
    expect(stub.seen[0].model).toBe('@cf/zai-org/glm-5.3');
  });
});
