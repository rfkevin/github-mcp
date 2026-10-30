import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ModelCallError,
  createZaiModel, parseZaiRef, parseParticipantEnvelope, envelopeFunded, participantDayKeys, participantCycleKey,
  type ModelClient,
} from '../../../src/collab-store/agentrun';
import {
  API_MODEL_RATES, API_RATE_SNAPSHOT_DATE, apiModelRate, centsOfApiTokens,
} from '../../../src/collab-store/executors/model-rates';
import {
  TASK_KIND_BOUNDS, normalizeTaskKind, resolveEffectiveMaxTokens, thinkingForTaskKind,
} from '../../../src/collab-store/executors/task-profiles';
import { ZAI_CHAT_COMPLETIONS_URL } from '../../../src/collab-store/executors/openai-compatible';
import { FUNDED, fetchStub, freshRun, quotaOf, reply, stepRow } from './cc7-l2-paid-harness';
import { paidAdapterContract, paidContractCall, type PaidContractCall } from './cc7-l2-paid-contract';

// CC-7 L2 (PR 2.1, plan CC-PLAN-7 v0.2 S2/S3) — fondation du canal payant : registre
// des tarifs daté (deny-by-default), enveloppe PAR PARTICIPANT (tout à 0 par
// défaut), plafonds de jetons par type de tâche, adaptateur Z.ai (tool_calls au
// format OpenAI) et câblage engineFor. Aucun appel réel : fetch scripté, secret
// factice, dates futures distinctes pour isoler les registres. Les invariants
// partagés avec xAI (PR 2.2) — gardes avant tout appel, réservation au pire
// cas, règlement au réel, rejeu fail-closed, jamais de découvert, plafond de
// l’exécution, câblage engineFor — sont conduits une seule fois par le contrat
// commun cc7-l2-paid-contract.ts (jours 01-08 du mois 2032-04) ; cette suite
// garde les spécificités Z.ai (jours 10 et suivants). Les helpers partagés
// (fetch scripté, exécution fraîche, registres, lignes d'étape) vivent dans
// cc7-l2-paid-harness.ts.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_975_000_000;

/** Modèle Z.ai de test : enveloppe financée, secret factice, fetch injecté, horloge fixée. */
function zaiModel(opts: PaidContractCall): ModelClient {
  return createZaiModel({
    env: (opts.env ?? { LLM_KEY_ZAI: 'zai-test-key-CANARY-never-store' }) as { LLM_KEY_ZAI?: string },
    ref: opts.ref ?? 'zai:glm-5.3', db, runId: opts.runId,
    envelope: opts.envelope ?? FUNDED,
    schemas: () => [{ name: 'store_context', description: 'Lit le contexte du cycle.', parameters: { type: 'object' } }],
    system: 'S', maxOutputTokens: 4_096, fetchImpl: opts.fetchImpl, now: () => opts.at,
  });
}

// Invariants communs des adaptateurs payants du canal API, conduits pour Z.ai.
paidAdapterContract(db, {
  prefix: 'l2z',
  ref: 'zai:glm-5.3',
  provider: 'zai',
  url: ZAI_CHAT_COMPLETIONS_URL,
  testSecret: 'zai-test-key-CANARY-never-store',
  worstCents: 2,
  actualCents: 1,
  month: '2032-04',
  offRegistryRef: 'zai:glm-4.7-flash',
  toolDescription: 'Lit le contexte du cycle.',
  expectBody: body => expect(body.thinking).toEqual({ type: 'disabled' }),
  model: opts => zaiModel(opts),
});

describe('CC-7 L2 — registre des tarifs daté (deny-by-default)', () => {
  it('exactement les 8 références relevées le 2026-10-25 plus les 5 du 2026-10-27 (CC-7 L8, L9b) et 1 du 2026-10-30 (Gemini 3.8 Flash), source par entrée, grok-4.1-fast absent', () => {
    expect(API_RATE_SNAPSHOT_DATE).toBe('2026-10-25');
    expect(Object.keys(API_MODEL_RATES).sort()).toEqual([
      'anthropic:claude-fable-5-1',
      'anthropic:claude-haiku-5-5',
      'anthropic:claude-opus-5-5',
      'anthropic:claude-sonnet-5-5',
      'gemini:gemini-3.5-flash-lite',
      'gemini:gemini-3.6-flash',
      'gemini:gemini-3.8-flash',
      'groq:openai/gpt-oss-120b',
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
    expect(apiModelRate('deepseek:deepseek-flash')).toBeNull();
    const flash = apiModelRate('gemini:gemini-3.6-flash')!;
    expect([flash.input_per_m, flash.output_per_m]).toEqual([75, 375]);
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
    const at = new Date('2032-04-12T10:00:00Z');
    const vibe = await freshRun(db, 'l2z', T + 300);
    const claude = await freshRun(db, 'l2z', T + 300, 10_000, 'claude');
    const stub = fetchStub([
      reply('ok', { prompt_tokens: 1_000, completion_tokens: 1_000 }),
      reply('ok aussi', { prompt_tokens: 1_000, completion_tokens: 1_000 }),
    ]);
    const first = await paidContractCall(zaiModel({ fetchImpl: stub.fetchImpl, runId: vibe.runId, at }));
    const second = await paidContractCall(zaiModel({ fetchImpl: stub.fetchImpl, runId: claude.runId, at }));
    expect(first.usage.cost_cents).toBe(1);
    expect(second.usage.cost_cents).toBe(1);
    // Sans outil allowlisté, le corps de l’appel part sans tools.
    expect(stub.seen[0].body.tools).toBeUndefined();
    for (const pid of ['vibe', 'claude']) {
      expect(await quotaOf(db, 'paid:participant:' + pid + ':day:2032-04-12')).toBe(1);
      expect(await quotaOf(db, 'paid:participant:' + pid + ':day:2032-04-12:tokens')).toBe(2_000);
      expect(await quotaOf(db, 'paid:participant:' + pid + ':day:2032-04-12:requests')).toBe(1);
    }
    expect(await quotaOf(db, 'paid:participant:vibe:cycle:' + vibe.cycleId)).toBe(1);
    expect(await quotaOf(db, 'paid:participant:claude:cycle:' + claude.cycleId)).toBe(1);
  });
});

describe('CC-7 L2 — adaptateur Z.ai : spécificités', () => {
  it('références refusées à la construction : hors registre Z.ai, autre fournisseur, maxOutputTokens', () => {
    expect(() => parseZaiRef('zai:glm-4.7-flash')).toThrow(/ZAI_MODEL_UNSUPPORTED/);
    expect(() => parseZaiRef('xai:grok-4.7')).toThrow(/ZAI_MODEL_UNSUPPORTED/);
    expect(() => parseZaiRef('workers-ai:@cf/zai-org/glm-5.3')).toThrow(/ZAI_MODEL_UNSUPPORTED/);
    const base = { env: { LLM_KEY_ZAI: 'zai-test-key-CANARY-never-store' }, fetchImpl: fetchStub([]).fetchImpl, db,
      runId: 'l2z-x', envelope: FUNDED, schemas: () => [], system: 'S' };
    expect(() => createZaiModel({ ...base, ref: 'zai:glm-5.3', maxOutputTokens: 0 })).toThrow(/maxOutputTokens/);
  });

  it('PAID_TOKEN_BUDGET_EXCEEDED : plafond de jetons du jour atteint pour ce participant, rien d’écrit', async () => {
    const at = new Date('2032-04-10T10:00:00Z');
    const run = await freshRun(db, 'l2z', T + 900);
    const stub = fetchStub([]);
    const error = await paidContractCall(zaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at,
      envelope: { dayCents: 200, cycleCents: 1_000, dayTokens: 100, dayRequests: 0 } })).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/PAID_TOKEN_BUDGET_EXCEEDED/);
    expect((error as ModelCallError).usage).toBeNull();
    expect(stub.seen.length).toBe(0);
    expect(await stepRow(db, run.runId, 0)).toBeNull();
    expect(await quotaOf(db, 'paid:participant:vibe:day:2032-04-10')).toBe(0);
    expect(await quotaOf(db, 'paid:participant:vibe:day:2032-04-10:tokens')).toBe(0);
  });

  it('PAID_REQUEST_BUDGET_EXCEEDED : plafond d’appels du jour par participant, le second appel n’écrit rien', async () => {
    const at = new Date('2032-04-11T10:00:00Z');
    const first = await freshRun(db, 'l2z', T + 1_000);
    const second = await freshRun(db, 'l2z', T + 1_000);
    const capped = { dayCents: 200, cycleCents: 1_000, dayTokens: 0, dayRequests: 1 };
    const stub = fetchStub([reply('premier', { prompt_tokens: 1_000, completion_tokens: 1_000 })]);
    const ok = await paidContractCall(zaiModel({ fetchImpl: stub.fetchImpl, runId: first.runId, at, envelope: capped }));
    expect(ok.usage.cost_cents).toBe(1);
    expect(await quotaOf(db, 'paid:participant:vibe:day:2032-04-11:requests')).toBe(1);
    const error = await paidContractCall(zaiModel({ fetchImpl: stub.fetchImpl, runId: second.runId, at, envelope: capped })).catch(e => e);
    expect((error as ModelCallError).message).toMatch(/PAID_REQUEST_BUDGET_EXCEEDED/);
    expect(stub.seen.length).toBe(1);
    expect(await stepRow(db, second.runId, 0)).toBeNull();
    // Toujours un seul appel décompté, un seul cent réglé.
    expect(await quotaOf(db, 'paid:participant:vibe:day:2032-04-11:requests')).toBe(1);
    expect(await quotaOf(db, 'paid:participant:vibe:day:2032-04-11')).toBe(1);
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
    // « research » est un kind réel du canal API depuis L5b (N1) : l'exemple inconnu devient « inconnu ».
    expect(normalizeTaskKind('inconnu')).toBe('default');
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

