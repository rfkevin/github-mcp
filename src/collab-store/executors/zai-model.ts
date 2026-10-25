/**
 * CC-7 L2 (S2 de CC-PLAN-7 v0.2) — adaptateur Z.ai du moteur d’exécution API :
 * un ModelClient avec appel d’outils (function calling, API compatible
 * OpenAI) derrière l’enveloppe de coût par participant.
 *
 * Inactif par défaut : secret Worker LLM_KEY_ZAI posé par Kevin seul (absent =
 * refus typé avant tout appel), enveloppe par participant financée par Kevin
 * (bornes cents, décision P5 Q1), modèle du registre daté API_MODEL_RATES
 * seulement (deny-by-default). Aucun repli vers une autre famille (S2) : un
 * modèle hors registre est refusé, jamais remplacé.
 *
 * Étape payante (hérité l7d) : réservation au pire cas avant l’appel (cents,
 * jetons, requêtes — jour et cycle par participant), règlement au réel après,
 * jamais de découvert ; rejeu idempotent par étape (agent_paid_steps) ; une
 * erreur du fournisseur règle l’étape au pire cas ; une étape déjà réglée
 * rejouée est refusée fail-closed.
 *
 * Plafond de sortie effectif : min(plafond hôte, borne par type de tâche S3 —
 * answer, planification, code, revue, test ; voir executors/task-profiles.ts).
 * Le contrôle de raisonnement (thinking) reste déclaratif côté profils.
 */
import { ModelCallError, type ModelClient, type ModelOutput, type ModelUsage } from '../agentrun/engine';
import { bytes, inputTokenBound, readModelResponse, toProviderMessages, type ToolSchema } from '../agentrun/workers-ai-model';
import { ensureSchema } from '../store/schema';
import { fetchWithTimeout, providerTimeoutMs, readUpstreamJson } from './fetch-timeout';
import { ZAI_CHAT_COMPLETIONS_URL } from './openai-compatible';
import { apiModelCents, parseApiModelRef } from './model-rates';
import { resolveEffectiveMaxTokens } from './task-profiles';
import {
  participantEnvelopeFunded, participantRegistreKeys, reserveParticipantStep, settleParticipantStep,
  type ParticipantEnvelopeLimits, type ParticipantRegistreKeys,
} from './paid-envelope';

export interface ZaiModelOptions {
  /** Référence zai:<modèle> du registre daté (deny-by-default). */
  readonly ref: string;
  readonly db: D1Database;
  /** Exécution concernée : étape, cycle et participant relus dedans, jamais depuis les arguments du modèle. */
  readonly runId: string;
  /** Secret Worker posé par Kevin seul ; absent = refus typé, aucun appel. */
  readonly secret: string | undefined;
  /** Enveloppe par participant (bornes cents = GO de financement de Kevin). */
  readonly limits: ParticipantEnvelopeLimits;
  /** Schémas des outils exposés au modèle (hôte, allowlist par type de tâche). */
  readonly schemas: (taskKind: string) => ToolSchema[];
  /** Consigne système du rôle (persona) ; les données restent dans les messages. */
  readonly system: string;
  /** Plafond hôte ; la borne par type de tâche (S3) s’applique en plus. */
  readonly maxOutputTokens: number;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

interface RunRow {
  cycle_id: string;
  participant_id: string;
  steps_done: number;
  tokens_used: number;
  max_tokens: number;
  cost_cents: number;
  max_cost_cents: number;
}

interface PaidStepRow { reserved_cents: number; actual_cents: number; settled: number }

const MAX_PAID_CENTS = 10_000_000;

/** Modèle Z.ai payant : même contrat ModelClient que le chemin gratuit, coût borné par l’enveloppe par participant. */
export function createZaiModel(options: ZaiModelOptions): ModelClient {
  const parsed = parseApiModelRef(options.ref);
  if (parsed.provider !== 'zai') {
    throw new Error('PAID_MODEL_UNSUPPORTED : createZaiModel ne sert que zai:<modèle>, reçu ' + options.ref
      + ' ; les adaptateurs xai et anthropic arrivent dans les lots suivants de L2.');
  }
  const model = parsed.model;
  const rate = parsed.rate;
  if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens > 8192) {
    throw new Error('maxOutputTokens entre 1 et 8192.');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async complete(input): Promise<{ output: ModelOutput; usage: ModelUsage }> {
      // (1) Secret absent : refus typé avant tout appel, aucun quota touché.
      const secret = options.secret?.trim() ?? '';
      if (!secret) {
        throw new ModelCallError('PAID_PROVIDER_SECRET_MISSING : secret LLM_KEY_ZAI absent de cet environnement ; aucun appel n’a lieu.', null);
      }
      // (2) Enveloppe par participant non financée : refus avant tout appel.
      if (!participantEnvelopeFunded(options.limits)) {
        throw new ModelCallError('PAID_ENVELOPE_NOT_FUNDED : enveloppe par participant absente ou nulle ; aucun appel payant n’est fait.', null);
      }
      const now = options.now?.() ?? new Date();
      const nowSec = Math.floor(now.getTime() / 1000);
      await ensureSchema(options.db);
      const run = await options.db.prepare(
        'SELECT cycle_id, participant_id, steps_done, tokens_used, max_tokens, cost_cents, max_cost_cents FROM agent_runs WHERE run_id = ?1')
        .bind(options.runId).first<RunRow>();
      if (!run) throw new ModelCallError('PAID_RUN_UNKNOWN : exécution ' + options.runId + ' introuvable.', null);
      // Étape en cours : le moteur réclame l’étape n = steps_done et ne l’incrémente qu’au checkpoint.
      const n = run.steps_done;
      const keys: ParticipantRegistreKeys = participantRegistreKeys(run.participant_id, run.cycle_id, now.toISOString().slice(0, 10));
      const previous = await options.db.prepare('SELECT reserved_cents, actual_cents, settled FROM agent_paid_steps WHERE run_id = ?1 AND n = ?2')
        .bind(options.runId, n).first<PaidStepRow>();
      if (previous?.settled) {
        // Coupure entre le règlement et la persistance de la sortie : fail-closed, aucune seconde charge.
        throw new ModelCallError('PAID_STEP_ALREADY_SETTLED : l’étape ' + n + ' est déjà réglée ; rejeu refusé pour éviter une seconde charge.', null);
      }
      // (3) Plafond de sortie effectif : min(hôte, borne par type de tâche S3).
      const maxTokens = resolveEffectiveMaxTokens({ task_kind: input.task_kind, model: options.ref, requested: options.maxOutputTokens });
      const allowed = new Set(input.tools);
      const tools = options.schemas(input.task_kind).filter(schema => allowed.has(schema.name))
        .map(schema => ({ type: 'function', function: { name: schema.name, description: schema.description, parameters: schema.parameters } }));
      const messages = toProviderMessages(options.system, input.messages);
      const bound = inputTokenBound(messages, tools);
      const worstTokens = bound + maxTokens;
      const worstCents = Math.min(apiModelCents(rate, bound, maxTokens), MAX_PAID_CENTS);
      // (4) Bornes par exécution : refus PRÉEMPTIF avant toute réservation (jamais de découvert).
      if (run.cost_cents + worstCents > run.max_cost_cents) {
        throw new ModelCallError('PAID_RUN_BUDGET_EXCEEDED : ' + run.cost_cents + ' + ' + worstCents + ' cents > plafond '
          + run.max_cost_cents + ' de l’exécution ; aucun appel n’est fait.', null);
      }
      if (run.tokens_used + worstTokens > run.max_tokens) {
        throw new ModelCallError('PAID_RUN_TOKEN_LIMIT : ' + run.tokens_used + ' + ' + worstTokens + ' jetons > plafond '
          + run.max_tokens + ' de l’exécution ; aucun appel n’est fait.', null);
      }
      let reservedCents: number;
      const reservedTokens = worstTokens;
      if (previous) {
        // (5) Rejeu idempotent : l’étape a déjà réservé, jamais deux réservations.
        reservedCents = previous.reserved_cents;
      } else {
        await reserveParticipantStep(options.db, { runId: options.runId, n, cents: worstCents, tokens: worstTokens,
          keys, limits: options.limits, nowSec });
        reservedCents = worstCents;
      }
      let raw: unknown;
      try {
        const response = await fetchWithTimeout(fetchImpl, ZAI_CHAT_COMPLETIONS_URL, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens, ...(tools.length ? { tools } : {}) }),
        }, providerTimeoutMs('zai', options.timeoutMs));
        raw = await readUpstreamJson(response);
      } catch (error) {
        // (6) Erreur du fournisseur (HTTP, timeout, JSON invalide) : la réserve reste au pire
        // cas, l’étape est réglée au pire cas ; un rejeu de cette étape sera refusé.
        await settleParticipantStep(options.db, { runId: options.runId, n, keys,
          reservedCents, actualCents: reservedCents, reservedTokens, actualTokens: reservedTokens, nowSec });
        throw new ModelCallError('zai_error: ' + (error instanceof Error ? error.message : String(error)),
          { tokens: bound, cost_cents: reservedCents });
      }
      const parsedResponse = readModelResponse(raw);
      const inputTokens = parsedResponse.input ?? bound;
      const outputTokens = parsedResponse.output_tokens ?? bytes(JSON.stringify(parsedResponse.output));
      const actualCents = Math.min(apiModelCents(rate, inputTokens, outputTokens), reservedCents);
      await settleParticipantStep(options.db, { runId: options.runId, n, keys,
        reservedCents, actualCents, reservedTokens, actualTokens: inputTokens + outputTokens, nowSec });
      return { output: parsedResponse.output, usage: { tokens: inputTokens + outputTokens, cost_cents: actualCents } };
    },
  };
}
