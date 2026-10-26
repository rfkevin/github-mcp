import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  createRun, leaseKeyOf, ModelCallError,
  createZaiModel, parseZaiRef, parseParticipantEnvelope, envelopeFunded, participantDayKeys, participantCycleKey,
  type ModelClient, type ParticipantEnvelope,
} from '../../../src/collab-store/agentrun';
import { engineFor } from '../../../src/collab-store/agentrun/object';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import {
  API_MODEL_RATES, API_RATE_SNAPSHOT_DATE, apiModelRate, centsOfApiTokens,
} from '../../../src/collab-store/executors/model-rates';
import {
  TASK_KIND_BOUNDS, normalizeTaskKind, resolveEffectiveMaxTokens, thinkingForTaskKind,
} from '../../../src/collab-store/executors/task-profiles';
import { ZAI_CHAT_COMPLETIONS_URL } from '../../../src/collab-store/executors/openai-compatible';

// CC-7 L2 (PR 2.1, plan CC-PLAN-7 v0.2 S2/S3) — fondation du canal payant : registre
// des tarifs daté (deny-by-default), enveloppe PAR PARTICIPANT (tout à 0 par
// défaut), plafonds de jetons par type de tâche, adaptateur Z.ai (tool_calls au
// format OpenAI) et câblage engineFor. Aucun appel réel : fetch scripté, secret
// factice, dates futures distinctes (2032-04-XX) pour isoler les registres.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_975_000_000;
let seq = 0;

/** Enveloppe financée de référence (valeurs P5 Q1 de Kevin, plafonds optionnels à 0). */
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
    runId: 'l2z-run-' + id + '-' + Date.now().toString(36), cycleId: 'l2z-cycle-' + id, participantId, taskId: 'l2z',
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

/** Modèle Z.ai de test : enveloppe financée, secret factice, fetch injecté, horloge fixée. */
function zaiModel(opts: { fetchImpl: typeof fetch; runId: string; at: Date; envelope?: ParticipantEnvelope;
  env?: { LLM_KEY_ZAI?: string }; maxOutputTokens?: number }) {
  return createZaiModel({
    env: opts.env ?? { LLM_KEY_ZAI: 'zai-test-key-CANARY-never-store' }, ref: 'zai:glm-5.3', db, runId: opts.runId,
    envelope: opts.envelope ?? FUNDED,
    schemas: () => [{ name: 'store_context', description: 'Lit le contexte du cycle.', parameters: { type: 'object' } }],
    system: 'S', maxOutputTokens: opts.maxOutputTokens ?? 4_096, fetchImpl: opts.fetchImpl, now: () => opts.at,
  });
}

function call(model: ModelClient, tools: string[] = []) {
  return model.complete({ messages: [{ role: 'user', content: 'go' }], tools, task_kind: 'answer' });
}

describe('CC-7 L2 — registre des tarifs daté (deny-by-default)', () => {
  it('exactement les 8 références relevées le 2026-10-25, source par entrée, grok-4.1-fast absent', () => {
    expect(API_RATE_SNAPSHOT_DATE).toBe('2026-10-25');
    expect(Object.keys(API_MODEL_RATES).sort()).toEqual([
      'anthropic:claude-haiku-5-5',
      'anthropic:claude-sonnet-5-5',
      'xai:grok-4.20-0309-non-reasoning',
      'xai:grok-4.7',
      'xai:grok-build-0.1',
      'zai:glm-5.3',
      'zai:glm-5.3-flash',
      'zai:glm-5.3-flashx',
    ]);
    for (const rate of Object.values(API_MODEL_RATES)) expect(rate.source_url).toMatch(/^https:\/\//);
    expect(apiModelRate('xai:grok-4.1-fast')).toBeNull();
    expect(apiModelRate('zai:inconnu')).toBeNull();
    const glm = apiModelRate('zai:glm-5.3')!;
    expect([glm.input_per_m, glm.output_per_m]).toEqual([140, 440]);
  });

  it('centsOfApiTokens : tarif au million arrondi au cent supérieur, jamais sous-évalué', () => {
    const glm = apiModelRate('zai:glm-5.3')!;
    const haiku = apiModelRate('anthropic:claude-haiku-5-5')!;
    expect(centsOfApiTokens(glm, 1_000_000, 1_000_000)).toBe(580);
    expect(centsOfApiTokens(haiku, 1_000_000, 1_000_000)).toBe(60);
    expect(centsOfApiTokens(glm, 1, 0)).toBe(1);
    expect(centsOfApiTokens(haiku, 0, 1)).toBe(1);
    expect(centsOfApiTokens(glm, 0, 0)).toBe(0);
  });
});

describe('CC-7 L2 — enveloppe par participant', () => {
  it('parseParticipantEnvelope : tout à 0 par défaut, refus des valeurs invalides, financée seulement avec les deux bornes en cents', () => {
    expect(parseParticipantEnvelope({})).toEqual({ dayCents: 0, cycleCents: 0, dayTokens: 0, dayRequests: 0 });
    expect(envelopeFunded(parseParticipantEnvelope({}))).toBe(false);
    // Valeurs P5 Q1 de Kevin.
    const kevin = parseParticipantEnvelope({
      AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS: '200', AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS: '1000',
    });
    expect(kevin).toEqual({ dayCents: 200, cycleCents: 1_000, dayTokens: 0, dayRequests: 0 });
    expect(envelopeFunded(kevin)).toBe(true);
    // Jour seul ne finance rien (fail-closed).
    expect(envelopeFunded(parseParticipantEnvelope({ AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS: '200' }))).toBe(false);
    // Invalides : texte, négatif, nul, décimal, hors borne → 0.
    for (const value of ['abc', '-5', '0', '1.5', '99999999999']) {
      expect(parseParticipantEnvelope({ AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS: value }).dayCents).toBe(0);
    }
    // Plafonds optionnels entiers positifs.
    expect(parseParticipantEnvelope({
      AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS: '200', AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS: '1000',
      AGENT_RUN_PAID_PARTICIPANT_DAY_TOKENS: '5000', AGENT_RUN_PAID_PARTICIPANT_DAY_REQUESTS: '20',
    })).toEqual({ dayCents: 200, cycleCents: 1_000, dayTokens: 5_000, dayRequests: 20 });
  });

  it('clés de registre par participant : jour et cycle préfixés, jamais partagés', () => {
    expect(participantDayKeys('vibe', '2032-04-01')).toEqual({
      cents: 'paid:participant:vibe:day:2032-04-01',
      tokens: 'paid:participant:vibe:day:2032-04-01:tokens',
      requests: 'paid:participant:vibe:day:2032-04-01:requests',
    });
    expect(participantDayKeys('claude', '2032-04-01').cents).not.toBe(participantDayKeys('vibe', '2032-04-01').cents);
    expect(participantCycleKey('vibe', 'c1')).toBe('paid:participant:vibe:cycle:c1');
    expect(participantCycleKey('claude', 'c1')).not.toBe(participantCycleKey('vibe', 'c1'));
  });

  it('isolation : deux participants le même jour ne touchent que leurs propres registres', async () => {
    const at = new Date('2032-04-04T10:00:00Z');
    const vibe = await freshRun(T + 300);
    const claude = await freshRun(T + 300, 10_000, 'claude');
    const stub = fetchStub([
      reply('ok', { prompt_tokens: 1_000, completion_tokens: 1_000 }),
      reply('ok aussi', { prompt_tokens: 1_000, completion_tokens: 1_000 }),
    ]);
    const first = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: vibe.runId, at }));
    const second = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: claude.runId, at }));
    expect(first.usage.cost_cents).toBe(1);
    expect(second.usage.cost_cents).toBe(1);
    // Sans outil allowlisté, le corps de l’appel part sans tools.
    expect(stub.seen[0].body.tools).toBeUndefined();
    for (const pid of ['vibe', 'claude']) {
      expect(await quotaOf('paid:participant:' + pid + ':day:2032-04-04')).toBe(1);
      expect(await quotaOf('paid:participant:' + pid + ':day:2032-04-04:tokens')).toBe(2_000);
      expect(await quotaOf('paid:participant:' + pid + ':day:2032-04-04:requests')).toBe(1);
    }
    expect(await quotaOf('paid:participant:vibe:cycle:' + vibe.cycleId)).toBe(1);
    expect(await quotaOf('paid:participant:claude:cycle:' + claude.cycleId)).toBe(1);
  });
});

describe('CC-7 L2 — adaptateur Z.ai', () => {
  it('références refusées à la construction : hors registre Z.ai, autre fournisseur, maxOutputTokens', () => {
    expect(() => parseZaiRef('zai:glm-4.7-flash')).toThrow(/ZAI_MODEL_UNSUPPORTED/);
    expect(() => parseZaiRef('xai:grok-4.7')).toThrow(/ZAI_MODEL_UNSUPPORTED/);
    expect(() => parseZaiRef('workers-ai:@cf/zai-org/glm-5.3')).toThrow(/ZAI_MODEL_UNSUPPORTED/);
    const base = { env: { LLM_KEY_ZAI: 'zai-test-key-CANARY-never-store' }, fetchImpl: fetchStub([]).fetchImpl, db,
      runId: 'l2z-x', envelope: FUNDED, schemas: () => [], system: 'S' };
    expect(() => createZaiModel({ ...base, ref: 'zai:glm-5.3', maxOutputTokens: 0 })).toThrow(/maxOutputTokens/);
  });

  it('enveloppe 0 : PAID_ENVELOPE_NOT_FUNDED avant tout appel, aucun quota touché', async () => {
    const at = new Date('2032-04-01T10:00:00Z');
    const run = await freshRun(T + 100);
    const stub = fetchStub([reply('jamais', { prompt_tokens: 1, completion_tokens: 1 })]);
    const error = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at,
      envelope: { dayCents: 0, cycleCents: 0, dayTokens: 0, dayRequests: 0 } })).catch(e => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).message).toMatch(/PAID_ENVELOPE_NOT_FUNDED/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
    expect(await stepRow(run.runId, 0)).toBeNull();
    expect(await quotaOf('paid:participant:vibe:day:2032-04-01')).toBe(0);
    expect(await quotaOf('paid:participant:vibe:cycle:' + run.cycleId)).toBe(0);
  });

  it('secret LLM_KEY_ZAI absent : EXECUTOR_UNAVAILABLE avant toute réservation, aucun quota touché', async () => {
    const at = new Date('2032-04-02T10:00:00Z');
    const run = await freshRun(T + 150);
    const stub = fetchStub([reply('jamais', { prompt_tokens: 1, completion_tokens: 1 })]);
    const error = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at, env: {} })).catch(e => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).message).toMatch(/EXECUTOR_UNAVAILABLE/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
    expect(await stepRow(run.runId, 0)).toBeNull();
    expect(await quotaOf('paid:participant:vibe:day:2032-04-02')).toBe(0);
    expect(await quotaOf('paid:participant:vibe:day:2032-04-02:requests')).toBe(0);
  });

  it('parcours nominal : réservation au pire cas, règlement au réel, remboursement, requêtes, corps de l’appel', async () => {
    const at = new Date('2032-04-03T10:00:00Z');
    const run = await freshRun(T + 200);
    const stub = fetchStub([reply('lu', { prompt_tokens: 1_000, completion_tokens: 1_000 })]);
    const result = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at }), ['store_context']);
    expect(stub.seen.length).toBe(1);
    expect(stub.seen[0].url).toBe(ZAI_CHAT_COMPLETIONS_URL);
    expect(stub.seen[0].headers.get('Authorization')).toBe('Bearer zai-test-key-CANARY-never-store');
    const body = stub.seen[0].body;
    expect(body.model).toBe('glm-5.3');
    expect(body.max_tokens).toBe(4_096);
    expect(body.thinking).toEqual({ type: 'disabled' });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'S' });
    expect(messages[1]).toEqual({ role: 'user', content: 'go' });
    expect(body.tools).toEqual([{ type: 'function',
      function: { name: 'store_context', description: 'Lit le contexte du cycle.', parameters: { type: 'object' } } }]);
    // Pire cas : borne d’entrée (octets + forfait par message) + 4096 de sortie au tarif relevé
    // → 2 cents réservés ; réel : 1 000 + 1 000 jetons glm-5.3 → 1 cent ; trop-versé rendu.
    expect(result.usage.cost_cents).toBe(1);
    expect(await stepRow(run.runId, 0)).toEqual({ reserved_cents: 2, actual_cents: 1, settled: 1 });
    expect(await quotaOf('paid:participant:vibe:day:2032-04-03')).toBe(1);
    expect(await quotaOf('paid:participant:vibe:cycle:' + run.cycleId)).toBe(1);
    expect(await quotaOf('paid:participant:vibe:day:2032-04-03:tokens')).toBe(2_000);
    expect(await quotaOf('paid:participant:vibe:day:2032-04-03:requests')).toBe(1);
  });

  it('rejeu idempotent : une étape déjà réservée (non réglée) ne réserve jamais deux fois', async () => {
    const at = new Date('2032-04-05T10:00:00Z');
    const run = await freshRun(T + 400);
    await db.prepare('INSERT INTO agent_paid_steps (run_id, n, reserved_cents, actual_cents, settled, updated_at) VALUES (?1, 0, 100, 0, 0, 1)')
      .bind(run.runId).run();
    const stub = fetchStub([reply('reprise', { prompt_tokens: 1_000, completion_tokens: 1_000 })]);
    const result = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at }));
    expect(stub.seen.length).toBe(1);
    expect(result.usage.cost_cents).toBe(1);
    expect(await stepRow(run.runId, 0)).toEqual({ reserved_cents: 100, actual_cents: 1, settled: 1 });
    // Aucune nouvelle réservation : les registres du participant restent absents.
    expect(await quotaOf('paid:participant:vibe:day:2032-04-05')).toBe(0);
    expect(await quotaOf('paid:participant:vibe:cycle:' + run.cycleId)).toBe(0);
    expect(await quotaOf('paid:participant:vibe:day:2032-04-05:requests')).toBe(0);
  });

  it('PAID_STEP_ALREADY_SETTLED : une étape déjà réglée rejouée est refusée fail-closed, sans appel', async () => {
    const at = new Date('2032-04-06T10:00:00Z');
    const run = await freshRun(T + 500);
    await db.prepare('INSERT INTO agent_paid_steps (run_id, n, reserved_cents, actual_cents, settled, updated_at) VALUES (?1, 0, 2, 1, 1, 1)')
      .bind(run.runId).run();
    const stub = fetchStub([]);
    const error = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at })).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/PAID_STEP_ALREADY_SETTLED/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
  });

  it('erreur du fournisseur : réserve laissée au pire cas, usage au pire cas, rejeu refusé', async () => {
    const at = new Date('2032-04-07T10:00:00Z');
    const run = await freshRun(T + 600);
    const stub = fetchStub([new Error('boom')]);
    const error = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at })).catch(e => e) as ModelCallError;
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error.message).toMatch(/zai_error/);
    expect(error.usage!.tokens).toBeGreaterThan(0);
    expect(error.usage!.cost_cents).toBe(2);
    expect(await quotaOf('paid:participant:vibe:day:2032-04-07')).toBe(2);
    expect(await quotaOf('paid:participant:vibe:cycle:' + run.cycleId)).toBe(2);
    // Jetons réservés au pire cas (borne d’entrée + sortie maximale), aucun remboursement.
    expect(await quotaOf('paid:participant:vibe:day:2032-04-07:tokens')).toBeGreaterThan(4_000);
    expect(await quotaOf('paid:participant:vibe:day:2032-04-07:requests')).toBe(1);
    expect(await stepRow(run.runId, 0)).toEqual({ reserved_cents: 2, actual_cents: 2, settled: 1 });
    const replay = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at })).catch(e => e);
    expect((replay as ModelCallError).message).toMatch(/PAID_STEP_ALREADY_SETTLED/);
    expect(stub.seen.length).toBe(1);
  });

  it('jamais de découvert : un usage forgé énorme est plafonné à la réservation', async () => {
    const at = new Date('2032-04-08T10:00:00Z');
    const run = await freshRun(T + 700);
    const stub = fetchStub([reply('gouffre', { prompt_tokens: 500_000_000, completion_tokens: 500_000_000 })]);
    const result = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at }));
    expect(result.usage.cost_cents).toBe(2);
    expect(await quotaOf('paid:participant:vibe:day:2032-04-08')).toBe(2);
    expect(await quotaOf('paid:participant:vibe:cycle:' + run.cycleId)).toBe(2);
    expect(await stepRow(run.runId, 0)).toEqual({ reserved_cents: 2, actual_cents: 2, settled: 1 });
  });

  it('PAID_RUN_BUDGET_EXCEEDED : refus préemptif avant toute réservation si le pire cas dépasse le plafond de l’exécution', async () => {
    const at = new Date('2032-04-09T10:00:00Z');
    const run = await freshRun(T + 800, 1);
    const stub = fetchStub([]);
    const error = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at })).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/PAID_RUN_BUDGET_EXCEEDED/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
    expect(await stepRow(run.runId, 0)).toBeNull();
    expect(await quotaOf('paid:participant:vibe:day:2032-04-09')).toBe(0);
  });

  it('PAID_TOKEN_BUDGET_EXCEEDED : plafond de jetons du jour atteint pour ce participant, rien d’écrit', async () => {
    const at = new Date('2032-04-10T10:00:00Z');
    const run = await freshRun(T + 900);
    const stub = fetchStub([]);
    const error = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at,
      envelope: { dayCents: 200, cycleCents: 1_000, dayTokens: 100, dayRequests: 0 } })).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/PAID_TOKEN_BUDGET_EXCEEDED/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
    expect(await stepRow(run.runId, 0)).toBeNull();
    expect(await quotaOf('paid:participant:vibe:day:2032-04-10')).toBe(0);
    expect(await quotaOf('paid:participant:vibe:day:2032-04-10:tokens')).toBe(0);
  });

  it('PAID_REQUEST_BUDGET_EXCEEDED : plafond d’appels du jour par participant, le second appel n’écrit rien', async () => {
    const at = new Date('2032-04-11T10:00:00Z');
    const first = await freshRun(T + 1_000);
    const second = await freshRun(T + 1_000);
    const capped = { dayCents: 200, cycleCents: 1_000, dayTokens: 0, dayRequests: 1 };
    const stub = fetchStub([reply('premier', { prompt_tokens: 1_000, completion_tokens: 1_000 })]);
    const ok = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: first.runId, at, envelope: capped }));
    expect(ok.usage.cost_cents).toBe(1);
    expect(await quotaOf('paid:participant:vibe:day:2032-04-11:requests')).toBe(1);
    const error = await call(zaiModel({ fetchImpl: stub.fetchImpl, runId: second.runId, at, envelope: capped })).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/PAID_REQUEST_BUDGET_EXCEEDED/);
    expect(stub.seen.length).toBe(1);
    expect(await stepRow(second.runId, 0)).toBeNull();
    // Toujours un seul appel décompté, un seul cent réglé.
    expect(await quotaOf('paid:participant:vibe:day:2032-04-11:requests')).toBe(1);
    expect(await quotaOf('paid:participant:vibe:day:2032-04-11')).toBe(1);
  });
});

describe('CC-7 L2 — plafonds de jetons par type de tâche', () => {
  it('bornes des kinds du canal API et normalisation fail-closed', () => {
    expect(TASK_KIND_BOUNDS.answer).toEqual({ max_tokens: 2_048, thinking: 'off' });
    expect(TASK_KIND_BOUNDS.planification).toEqual({ max_tokens: 4_096, thinking: 'low' });
    expect(TASK_KIND_BOUNDS.code).toEqual({ max_tokens: 4_096, thinking: 'low' });
    expect(TASK_KIND_BOUNDS.revue).toEqual({ max_tokens: 2_048, thinking: 'low' });
    expect(TASK_KIND_BOUNDS.test).toEqual({ max_tokens: 2_048, thinking: 'low' });
    expect(normalizeTaskKind('code')).toBe('code');
    expect(normalizeTaskKind('revue')).toBe('revue');
    // Absent, inconnu ou casse différente → default (politique volontaire).
    expect(normalizeTaskKind('research')).toBe('default');
    expect(normalizeTaskKind('ANSWER')).toBe('default');
    expect(normalizeTaskKind(undefined)).toBe('default');
  });

  it('plafond effectif et effort de réflexion par type de tâche', () => {
    expect(resolveEffectiveMaxTokens({ task_kind: 'code' })).toBe(4_096);
    expect(resolveEffectiveMaxTokens({ task_kind: 'revue' })).toBe(2_048);
    expect(resolveEffectiveMaxTokens({ task_kind: 'code', requested: 100 })).toBe(100);
    // Un demandé énorme reste borné par la borne du kind.
    expect(resolveEffectiveMaxTokens({ task_kind: 'code', requested: 99_999 })).toBe(4_096);
    expect(thinkingForTaskKind('answer')).toBe('off');
    expect(thinkingForTaskKind('revue')).toBe('low');
    expect(thinkingForTaskKind('inconnu')).toBe('off');
  });
});

describe('CC-7 L2 — câblage engineFor', () => {
  it('zai: sans binding AI part sur l’adaptateur Z.ai, pas sur le modèle simulé', async () => {
    // Contraste : un payant workers-ai sans binding AI retombe sur le simulé (garde 7c-1).
    const noAi = engineFor({ AGENT_RUN_PAID_MODEL: 'workers-ai:@cf/zai-org/glm-5.3' }, db)('r');
    expect((await noAi.model.complete({ messages: [], tools: [], task_kind: 'answer' })).output.text).toContain('simulée');
    // zai: sans secret, enveloppe financée : refus typé de l’adaptateur, preuve du dispatch.
    const zai = engineFor({ AGENT_RUN_PAID_MODEL: 'zai:glm-5.3',
      AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS: '200', AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS: '1000' }, db)('r');
    const error = await zai.model.complete({ messages: [{ role: 'user', content: 'q' }], tools: [], task_kind: 'answer' }).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/EXECUTOR_UNAVAILABLE/);
    // Sans variables d’enveloppe : fail-closed avant tout appel.
    const noEnvelope = engineFor({ AGENT_RUN_PAID_MODEL: 'zai:glm-5.3' }, db)('r');
    const refused = await noEnvelope.model.complete({ messages: [{ role: 'user', content: 'q' }], tools: [], task_kind: 'answer' }).catch(e => e);
    expect((refused as ModelCallError).message).toMatch(/PAID_ENVELOPE_NOT_FUNDED/);
    // Référence zai: hors registre : refus à la construction.
    expect(() => engineFor({ AGENT_RUN_PAID_MODEL: 'zai:glm-4.7-flash',
      AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS: '200', AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS: '1000' }, db)('r'))
      .toThrow(/ZAI_MODEL_UNSUPPORTED/);
  });
});
