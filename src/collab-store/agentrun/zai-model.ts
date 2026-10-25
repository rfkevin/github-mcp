/**
 * CC-7 L2 (PR 2.1, plan CC-PLAN-7 v0.2 S2) — adaptateur Z.ai du canal API :
 * un ModelClient compatible OpenAI avec appel d'outils (tool_calls), derrière
 * l'enveloppe de coût PAR PARTICIPANT (paid-model.ts) et le registre des
 * tarifs daté (executors/model-rates.ts, deny-by-default).
 *
 * - Secret LLM_KEY_ZAI, posé par Kevin seul sur le Worker : absent ou vide =
 *   refus typé EXECUTOR_UNAVAILABLE avant toute réservation, aucun quota touché.
 * - Timeout 90 s par défaut (providerTimeoutMs('zai')), aucun retry ; erreur
 *   incertaine du fournisseur = réserve laissée au pire cas, rejeu refusé
 *   fail-closed (PAID_STEP_ALREADY_SETTLED), jamais de seconde charge.
 * - Aucun repli inter-familles : la référence zai:<modèle> décide, hors
 *   registre daté = refus à la construction (ZAI_MODEL_UNSUPPORTED).
 * - Endpoint constant serveur (ZAI_CHAT_COMPLETIONS_URL) ; aucune clé
 *   manipulée par un agent, aucune URL lue hors des constantes.
 * - thinking désactivé pour la famille glm-5.3 (précédent glm-4.7-flash :
 *   le raisonnement consomme max_tokens avant la réponse) ; option à
 *   revalider à l'activation, aucun appel avant le GO de Kevin + secret.
 */
import { apiModelRate, centsOfApiTokens, type ApiModelRate } from '../executors/model-rates';
import { fetchWithTimeout, providerTimeoutMs, readUpstreamJson, requireSecret } from '../executors/fetch-timeout';
import { ZAI_CHAT_COMPLETIONS_URL } from '../executors/openai-compatible';
import { ensureSchema } from '../store/schema';
import { ModelCallError, type ModelClient, type ModelOutput, type ModelUsage } from './engine';
import {
  envelopeFunded, MAX_PAID_CENTS, prepareProviderCall, readPaidRun, readPaidStep,
  reserveParticipantStep, settleParticipantStep, type ParticipantEnvelope,
} from './paid-model';
import { bytes, readModelResponse, type ToolSchema } from './workers-ai-model';

export interface ZaiModelOptions {
  /** Environnement serveur : secret LLM_KEY_ZAI (posé par Kevin seul sur le Worker). */
  env: { LLM_KEY_ZAI?: string };
  /** Référence zai:<modèle> du registre daté API_MODEL_RATES (deny-by-default). */
  ref: string;
  db: D1Database;
  /** Exécution concernée : étape, participant et cycle relus dedans, jamais depuis les arguments du modèle. */
  runId: string;
  /** Enveloppe PAR PARTICIPANT (0 par défaut = PAID_ENVELOPE_NOT_FUNDED avant tout appel). */
  envelope: ParticipantEnvelope;
  /** Schémas des outils exposés au modèle (hôte, allowlist par type de tâche). */
  schemas: (taskKind: string) => ToolSchema[];
  /** Consigne système du rôle (persona) ; les données restent dans les messages. */
  system: string;
  maxOutputTokens: number;
  timeoutMs?: number;
  /** Tests seulement : fetch injecté ; la production utilise le fetch du Worker. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** Référence Z.ai du registre daté : deny-by-default, aucun repli inter-familles. */
export function parseZaiRef(ref: string): { model: string; rate: ApiModelRate } {
  const prefix = 'zai:';
  if (!ref.startsWith(prefix)) {
    throw new Error('ZAI_MODEL_UNSUPPORTED : fournisseur non pris en charge par l’adaptateur Z.ai : '
      + ref.split(':')[0] + ' (aucun repli inter-familles).');
  }
  const model = ref.slice(prefix.length);
  const rate = apiModelRate(ref);
  if (!rate) {
    throw new Error('ZAI_MODEL_UNSUPPORTED : ' + model + ' hors du registre des tarifs daté (deny-by-default).');
  }
  return { model, rate };
}

/** Le canal API demande des réponses directes : le raisonnement est coupé (précédent glm-4.7-flash). */
const ZAI_REQUEST_OPTIONS = { thinking: { type: 'disabled' } } as const;

/** Modèle Z.ai : même contrat ModelClient que les chemins Workers AI, coût borné par l'enveloppe par participant. */
export function createZaiModel(options: ZaiModelOptions): ModelClient {
  const { model, rate } = parseZaiRef(options.ref);
  if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens > 8192) {
    throw new Error('maxOutputTokens entre 1 et 8192.');
  }
  return {
    async complete(input): Promise<{ output: ModelOutput; usage: ModelUsage }> {
      // (1) Enveloppe par participant non financée : refus avant tout appel, aucun quota touché.
      if (!envelopeFunded(options.envelope)) {
        throw new ModelCallError('PAID_ENVELOPE_NOT_FUNDED : enveloppe owner par participant absente ou nulle ; aucun appel payant n’est fait.', null);
      }
      // Secret absent : refus typé avant toute réservation, aucun quota touché.
      let secret: string;
      try {
        secret = requireSecret(options.env.LLM_KEY_ZAI);
      } catch (error) {
        throw new ModelCallError('EXECUTOR_UNAVAILABLE : ' + (error instanceof Error ? error.message : String(error)), null);
      }
      const now = options.now?.() ?? new Date();
      const nowSec = Math.floor(now.getTime() / 1000);
      const day = now.toISOString().slice(0, 10);
      await ensureSchema(options.db);
      const run = await readPaidRun(options.db, options.runId);
      if (!run) throw new ModelCallError('PAID_RUN_UNKNOWN : exécution ' + options.runId + ' introuvable.', null);
      const n = run.steps_done;
      const previous = await readPaidStep(options.db, options.runId, n);
      if (previous?.settled) {
        // Coupure entre le règlement et la persistance de la sortie : fail-closed, aucune seconde charge.
        throw new ModelCallError('PAID_STEP_ALREADY_SETTLED : l’étape ' + n + ' est déjà réglée ; rejeu refusé pour éviter une seconde charge.', null);
      }
      const prepared = prepareProviderCall(options.schemas, options.system, input);
      const worstTokens = prepared.bound + options.maxOutputTokens;
      const worstCents = Math.min(centsOfApiTokens(rate, prepared.bound, options.maxOutputTokens), MAX_PAID_CENTS);
      // Borne par exécution : refus PRÉEMPTIF avant toute réservation (jamais de découvert).
      if (run.cost_cents + worstCents > run.max_cost_cents) {
        throw new ModelCallError('PAID_RUN_BUDGET_EXCEEDED : ' + run.cost_cents + ' + ' + worstCents + ' cents > plafond '
          + run.max_cost_cents + ' de l’exécution ; aucun appel n’est fait.', null);
      }
      let reserved: number;
      if (previous) {
        // Rejeu idempotent : l'étape a déjà réservé, jamais deux réservations.
        reserved = previous.reserved_cents;
      } else {
        await reserveParticipantStep(options.db, { runId: options.runId, n, participantId: run.participant_id, cycleId: run.cycle_id,
          day, cents: worstCents, tokens: worstTokens, envelope: options.envelope, nowSec });
        reserved = worstCents;
      }
      let raw: unknown;
      try {
        const response = await fetchWithTimeout(options.fetchImpl ?? fetch, ZAI_CHAT_COMPLETIONS_URL, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model, messages: prepared.messages, max_tokens: options.maxOutputTokens,
            ...ZAI_REQUEST_OPTIONS, ...(prepared.tools.length ? { tools: prepared.tools } : {}),
          }),
        }, providerTimeoutMs('zai', options.timeoutMs));
        raw = await readUpstreamJson(response);
      } catch (error) {
        // Erreur incertaine du fournisseur : la réserve reste au pire cas (cents et
        // jetons), l'étape est réglée au pire cas ; un rejeu sera refusé fail-closed.
        await settleParticipantStep(options.db, { runId: options.runId, n, participantId: run.participant_id, cycleId: run.cycle_id,
          day, reservedCents: reserved, actualCents: reserved, reservedTokens: worstTokens, actualTokens: worstTokens, nowSec });
        throw new ModelCallError('zai_error: ' + (error instanceof Error ? error.message : String(error)),
          { tokens: prepared.bound, cost_cents: reserved });
      }
      const parsed = readModelResponse(raw);
      const inputTokens = parsed.input ?? prepared.bound;
      const outputTokens = parsed.output_tokens ?? bytes(JSON.stringify(parsed.output));
      const actualCents = Math.min(centsOfApiTokens(rate, inputTokens, outputTokens), reserved);
      const actualTokens = inputTokens + outputTokens;
      await settleParticipantStep(options.db, { runId: options.runId, n, participantId: run.participant_id, cycleId: run.cycle_id,
        day, reservedCents: reserved, actualCents, reservedTokens: worstTokens, actualTokens, nowSec });
      return { output: parsed.output, usage: { tokens: actualTokens, cost_cents: actualCents } };
    },
  };
}
