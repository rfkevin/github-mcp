import { describe, expect, it } from 'vitest';
import { ModelCallError, type ModelClient, type ParticipantEnvelope } from '../../../src/collab-store/agentrun';
import { engineFor } from '../../../src/collab-store/agentrun/object';
import { fetchStub, freshRun, quotaOf, reply, stepRow } from './cc7-l2-paid-harness';

/**
 * CC-7 L2 — contrat commun des adaptateurs payants du canal API (Z.ai PR 2.1,
 * xAI PR 2.2, Anthropic PR 2.3) : une seule implémentation des invariants
 * (gardes avant tout appel, réservation au pire cas, règlement au réel, rejeu
 * fail-closed, jamais de découvert, plafond de l’exécution, dispatch
 * engineFor), conduite par une fixture par fournisseur. La base D1 vient de
 * la suite appelante ; chaque adaptateur occupe son propre mois de dates
 * futures (jours 01 à 08) pour isoler les registres du participant, ses tests
 * propres au-delà. La réponse du fournisseur, les en-têtes et la forme du
 * corps restent au protocole : makeResponse / expectHeaders /
 * expectRequestBody, avec les formes compatibles OpenAI par défaut (suites
 * Z.ai et xAI inchangées).
 */

/** Options d’un appel de test du contrat : fetch injecté, exécution, horloge ; enveloppe, secret et référence surchargables. */
export interface PaidContractCall {
  fetchImpl: typeof fetch;
  runId: string;
  at: Date;
  envelope?: ParticipantEnvelope;
  env?: Record<string, string | undefined>;
  ref?: string;
}

/** Ce que chaque adaptateur apporte au contrat commun. */
export interface PaidAdapterFixture {
  /** Préfixe unique des exécutions de test (une suite = un préfixe). */
  prefix: string;
  /** Référence du registre daté conduisant le contrat (ex. xai:grok-4.7). */
  ref: string;
  /** Préfixe fournisseur : erreurs <provider>_error, refus <PROVIDER>_MODEL_UNSUPPORTED. */
  provider: string;
  /** Endpoint constant serveur du fournisseur. */
  url: string;
  /** Secret factice de test (jamais un vrai secret). */
  testSecret: string;
  /** Réservation au pire cas du parcours nominal (cents, au tarif relevé). */
  worstCents: number;
  /** Règlement au réel du parcours nominal (cents, au tarif relevé). */
  actualCents: number;
  /** Mois des dates futures du contrat (ex. 2032-05) ; jours 01 à 08 réservés. */
  month: string;
  /** Référence hors registre : refusée à la construction par engineFor. */
  offRegistryRef: string;
  /** Description de l’outil store_context exposé par la fixture (assertion du corps). */
  toolDescription: string;
  /** Vérifications de corps propres au fournisseur (ex. thinking pour Z.ai). */
  expectBody?: (body: Record<string, unknown>) => void;
  /** Réponse du fournisseur pour ce protocole (PR 2.3) ; défaut : forme compatible OpenAI. */
  makeResponse?: (text: string, usage: { input: number; output: number }) => unknown;
  /** En-têtes du protocole (PR 2.3) ; défaut : Authorization Bearer. */
  expectHeaders?: (headers: Headers) => void;
  /** Forme du corps pour ce protocole (PR 2.3) ; défaut : messages système + outils au format OpenAI. */
  expectRequestBody?: (body: Record<string, unknown>) => void;
  /** CC-7 L8 : modèle et plafond de sortie dans le corps (Gemini : URL + generationConfig) ; défaut : body.model et body.max_tokens. */
  expectModelAndMax?: (body: Record<string, unknown>, model: string, maxTokens: number) => void;
  /** Modèle de test de l’adaptateur (enveloppe financée, secret factice, fetch injecté, horloge fixée). */
  model: (call: PaidContractCall) => ModelClient;
}

/** Appel de test du contrat : un message utilisateur, outils allowlistés au besoin. */
export function paidContractCall(model: ModelClient, tools: string[] = []) {
  return model.complete({ messages: [{ role: 'user', content: 'ping' }], tools, task_kind: 'answer' });
}

/** Invariants communs des adaptateurs payants : gardes, réservation, règlement, rejeu, engineFor. */
export function paidAdapterContract(db: D1Database, f: PaidAdapterFixture): void {
  const day = (n: number) => f.month + '-' + String(n).padStart(2, '0');
  const at = (n: number) => new Date(day(n) + 'T10:00:00Z');
  const caught = (promise: Promise<unknown>) => promise.catch(e => e);
  // Réponse du fournisseur : la forme reste au protocole, défaut compatible OpenAI (PR 2.3).
  const make = f.makeResponse ?? ((text: string, usage: { input: number; output: number }) =>
    reply(text, { prompt_tokens: usage.input, completion_tokens: usage.output }));
  // En-têtes du protocole : défaut Bearer (PR 2.3 ; ex. x-api-key + anthropic-version pour Anthropic).
  const checkHeaders = f.expectHeaders ?? ((headers: Headers) => {
    expect(headers.get('Authorization')).toBe('Bearer ' + f.testSecret);
  });
  // Forme du corps : défaut messages système + outils au format OpenAI (PR 2.3).
  const checkBody = f.expectRequestBody ?? ((body: Record<string, unknown>) => {
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'S' });
    expect(messages[1]).toEqual({ role: 'user', content: 'ping' });
    expect(body.tools).toEqual([{ type: 'function',
      function: { name: 'store_context', description: f.toolDescription, parameters: { type: 'object' } } }]);
  });

  describe('CC-7 L2 — contrat commun des adaptateurs payants (' + f.ref + ')', () => {
    it('enveloppe 0 : PAID_ENVELOPE_NOT_FUNDED avant tout appel, aucun quota touché', async () => {
      const run = await freshRun(db, f.prefix, 1_976_000_000);
      const stub = fetchStub([make('jamais', { input: 1, output: 1 })]);
      const error = await caught(paidContractCall(f.model({ fetchImpl: stub.fetchImpl, runId: run.runId, at: at(1),
        envelope: { dayCents: 0, cycleCents: 0, dayTokens: 0, dayRequests: 0 } })));
      expect(error).toBeInstanceOf(ModelCallError);
      expect((error as ModelCallError).message).toMatch(/PAID_ENVELOPE_NOT_FUNDED/);
      expect((error as ModelCallError).usage).toBeNull();
      expect(stub.seen.length).toBe(0);
      expect(await stepRow(db, run.runId, 0)).toBeNull();
      expect(await quotaOf(db, 'paid:participant:vibe:day:' + day(1))).toBe(0);
      expect(await quotaOf(db, 'paid:participant:vibe:cycle:' + run.cycleId)).toBe(0);
    });

    it('secret du fournisseur absent : EXECUTOR_UNAVAILABLE avant toute réservation, aucun quota touché', async () => {
      const run = await freshRun(db, f.prefix, 1_976_000_050);
      const stub = fetchStub([make('jamais', { input: 1, output: 1 })]);
      const error = await caught(paidContractCall(f.model({ fetchImpl: stub.fetchImpl, runId: run.runId, at: at(2), env: {} })));
      expect(error).toBeInstanceOf(ModelCallError);
      expect((error as ModelCallError).message).toMatch(/EXECUTOR_UNAVAILABLE/);
      expect((error as ModelCallError).usage).toBeNull();
      expect(stub.seen.length).toBe(0);
      expect(await stepRow(db, run.runId, 0)).toBeNull();
      expect(await quotaOf(db, 'paid:participant:vibe:day:' + day(2))).toBe(0);
      expect(await quotaOf(db, 'paid:participant:vibe:day:' + day(2) + ':requests')).toBe(0);
    });

    it('parcours nominal : endpoint et secret du fournisseur, réservation au pire cas, règlement au réel', async () => {
      const run = await freshRun(db, f.prefix, 1_976_000_100);
      const stub = fetchStub([make('lu', { input: 1_000, output: 1_000 })]);
      const result = await paidContractCall(f.model({ fetchImpl: stub.fetchImpl, runId: run.runId, at: at(3) }), ['store_context']);
      expect(stub.seen.length).toBe(1);
      expect(stub.seen[0].url).toBe(f.url);
      checkHeaders(stub.seen[0].headers);
      const body = stub.seen[0].body;
      const checkModelAndMax = f.expectModelAndMax ?? ((b: Record<string, unknown>, model: string, maxTokens: number) => {
        expect(b.model).toBe(model);
        expect(b.max_tokens).toBe(maxTokens);
      });
      checkModelAndMax(body, f.ref.slice(f.ref.indexOf(':') + 1), 4_096);
      f.expectBody?.(body);
      checkBody(body);
      // Pire cas réservé au tarif relevé, règlement au réel : trop-versé rendu.
      expect(result.usage.cost_cents).toBe(f.actualCents);
      expect(await stepRow(db, run.runId, 0)).toEqual({ reserved_cents: f.worstCents, actual_cents: f.actualCents, settled: 1 });
      expect(await quotaOf(db, 'paid:participant:vibe:day:' + day(3))).toBe(f.actualCents);
      expect(await quotaOf(db, 'paid:participant:vibe:cycle:' + run.cycleId)).toBe(f.actualCents);
      expect(await quotaOf(db, 'paid:participant:vibe:day:' + day(3) + ':tokens')).toBe(2_000);
      expect(await quotaOf(db, 'paid:participant:vibe:day:' + day(3) + ':requests')).toBe(1);
    });

    it('rejeu idempotent : une étape déjà réservée (non réglée) ne réserve jamais deux fois', async () => {
      const run = await freshRun(db, f.prefix, 1_976_000_150);
      await db.prepare('INSERT INTO agent_paid_steps (run_id, n, reserved_cents, actual_cents, settled, updated_at) VALUES (?1, 0, 100, 0, 0, 1)')
        .bind(run.runId).run();
      const stub = fetchStub([make('reprise', { input: 1_000, output: 1_000 })]);
      const result = await paidContractCall(f.model({ fetchImpl: stub.fetchImpl, runId: run.runId, at: at(4) }));
      expect(stub.seen.length).toBe(1);
      expect(result.usage.cost_cents).toBe(f.actualCents);
      expect(await stepRow(db, run.runId, 0)).toEqual({ reserved_cents: 100, actual_cents: f.actualCents, settled: 1 });
      // Aucune nouvelle réservation : les registres du participant restent absents.
      expect(await quotaOf(db, 'paid:participant:vibe:day:' + day(4))).toBe(0);
      expect(await quotaOf(db, 'paid:participant:vibe:cycle:' + run.cycleId)).toBe(0);
      expect(await quotaOf(db, 'paid:participant:vibe:day:' + day(4) + ':requests')).toBe(0);
    });

    it('PAID_STEP_ALREADY_SETTLED : une étape déjà réglée rejouée est refusée fail-closed, sans appel', async () => {
      const run = await freshRun(db, f.prefix, 1_976_000_200);
      await db.prepare('INSERT INTO agent_paid_steps (run_id, n, reserved_cents, actual_cents, settled, updated_at) VALUES (?1, 0, 3, 1, 1, 1)')
        .bind(run.runId).run();
      const stub = fetchStub([]);
      const error = await caught(paidContractCall(f.model({ fetchImpl: stub.fetchImpl, runId: run.runId, at: at(5) })));
      expect((error as ModelCallError).message).toMatch(/PAID_STEP_ALREADY_SETTLED/);
      expect((error as ModelCallError).usage).toBeNull();
      expect(stub.seen.length).toBe(0);
    });

    it('erreur du fournisseur : réserve laissée au pire cas, usage au pire cas, rejeu refusé', async () => {
      const run = await freshRun(db, f.prefix, 1_976_000_250);
      const stub = fetchStub([new Error('boom')]);
      const error = await caught(paidContractCall(f.model({ fetchImpl: stub.fetchImpl, runId: run.runId, at: at(6) }))) as ModelCallError;
      expect(error).toBeInstanceOf(ModelCallError);
      expect(error.message).toMatch(new RegExp(f.provider + '_error'));
      expect(error.usage!.tokens).toBeGreaterThan(0);
      expect(error.usage!.cost_cents).toBe(f.worstCents);
      expect(await quotaOf(db, 'paid:participant:vibe:day:' + day(6))).toBe(f.worstCents);
      expect(await quotaOf(db, 'paid:participant:vibe:cycle:' + run.cycleId)).toBe(f.worstCents);
      // Jetons réservés au pire cas (borne d’entrée + sortie maximale), aucun remboursement.
      expect(await quotaOf(db, 'paid:participant:vibe:day:' + day(6) + ':tokens')).toBeGreaterThan(4_000);
      expect(await quotaOf(db, 'paid:participant:vibe:day:' + day(6) + ':requests')).toBe(1);
      expect(await stepRow(db, run.runId, 0)).toEqual({ reserved_cents: f.worstCents, actual_cents: f.worstCents, settled: 1 });
      const replay = await caught(paidContractCall(f.model({ fetchImpl: stub.fetchImpl, runId: run.runId, at: at(6) })));
      expect((replay as ModelCallError).message).toMatch(/PAID_STEP_ALREADY_SETTLED/);
      expect(stub.seen.length).toBe(1);
    });

    it('jamais de découvert : un usage forgé énorme est plafonné à la réservation', async () => {
      const run = await freshRun(db, f.prefix, 1_976_000_300);
      const stub = fetchStub([make('gouffre', { input: 500_000_000, output: 500_000_000 })]);
      const result = await paidContractCall(f.model({ fetchImpl: stub.fetchImpl, runId: run.runId, at: at(7) }));
      expect(result.usage.cost_cents).toBe(f.worstCents);
      expect(await quotaOf(db, 'paid:participant:vibe:day:' + day(7))).toBe(f.worstCents);
      expect(await quotaOf(db, 'paid:participant:vibe:cycle:' + run.cycleId)).toBe(f.worstCents);
      expect(await stepRow(db, run.runId, 0)).toEqual({ reserved_cents: f.worstCents, actual_cents: f.worstCents, settled: 1 });
    });

    it('PAID_RUN_BUDGET_EXCEEDED : refus préemptif avant toute réservation si le pire cas dépasse le plafond de l’exécution', async () => {
      const run = await freshRun(db, f.prefix, 1_976_000_350, 1);
      const stub = fetchStub([]);
      const error = await caught(paidContractCall(f.model({ fetchImpl: stub.fetchImpl, runId: run.runId, at: at(8) })));
      expect((error as ModelCallError).message).toMatch(/PAID_RUN_BUDGET_EXCEEDED/);
      expect((error as ModelCallError).usage).toBeNull();
      expect(stub.seen.length).toBe(0);
      expect(await stepRow(db, run.runId, 0)).toBeNull();
      expect(await quotaOf(db, 'paid:participant:vibe:day:' + day(8))).toBe(0);
    });

    it('câblage engineFor : ' + f.ref + ' part sur l’adaptateur, pas sur le modèle simulé', async () => {
      // Contraste : un payant workers-ai sans binding AI retombe sur le simulé (garde 7c-1).
      const noAi = engineFor({ AGENT_RUN_PAID_MODEL: 'workers-ai:@cf/zai-org/glm-5.3' }, db)('r');
      expect((await noAi.model.complete({ messages: [], tools: [], task_kind: 'answer' })).output.text).toContain('simulée');
      // Sans secret, enveloppe financée : refus typé de l’adaptateur, preuve du dispatch.
      const paid = engineFor({ AGENT_RUN_PAID_MODEL: f.ref,
        AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS: '200', AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS: '1000' }, db)('r');
      const error = await caught(paid.model.complete({ messages: [{ role: 'user', content: 'q' }], tools: [], task_kind: 'answer' }));
      expect((error as ModelCallError).message).toMatch(/EXECUTOR_UNAVAILABLE/);
      // Sans variables d’enveloppe : fail-closed avant tout appel.
      const noEnvelope = engineFor({ AGENT_RUN_PAID_MODEL: f.ref }, db)('r');
      const rejected = await caught(noEnvelope.model.complete({ messages: [{ role: 'user', content: 'q' }], tools: [], task_kind: 'answer' }));
      expect((rejected as ModelCallError).message).toMatch(/PAID_ENVELOPE_NOT_FUNDED/);
      // Référence hors registre : refus à la construction.
      expect(() => engineFor({ AGENT_RUN_PAID_MODEL: f.offRegistryRef,
        AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS: '200', AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS: '1000' }, db)('r'))
        .toThrow(new RegExp(f.provider.toUpperCase() + '_MODEL_UNSUPPORTED'));
    });
  });
}
