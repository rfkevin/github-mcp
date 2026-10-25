/**
 * CC-5 l7 (incrément 7d, amendement A5 du plan de clôture v1.1) — modèles
 * Workers AI payants derrière l’enveloppe de coût de l’owner.
 * CC-7 L2 (PR 2.1, plan CC-PLAN-7 v0.2 S2) — enveloppe généralisée PAR
 * PARTICIPANT : registres paid:participant:<pid>:… (cents du jour et du cycle,
 * jetons et requêtes du jour), tout à 0 par défaut tant que Kevin n’a pas posé
 * les variables = refus typé avant tout appel.
 *
 * Inactif par défaut : sans AGENT_RUN_PAID_MODEL le câblage ne change pas
 * (chemin gratuit de 7c-1 ou modèle simulé de 7b) ; et même posé, aucun appel n’a
 * lieu tant que l’enveloppe par participant (AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS
 * et AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS, variables posées par Kevin seul sur
 * le Worker) n’est pas financée (0, absent ou invalide : PAID_ENVELOPE_NOT_FUNDED,
 * refus avant tout appel, aucun quota touché).
 *
 * Garde-fous (A5, généralisés par participant en CC-7 L2) :
 * 1. enveloppe non financée : refus en code, aucun appel ;
 * 2. rejeu idempotent AVANT réservation : une étape déjà réservée ne réserve
 *    jamais deux fois (agent_paid_steps, PRIMARY KEY (run_id, n)) ; une étape
 *    déjà réglée rejouée — coupure entre le règlement et la persistance de la
 *    sortie — est refusée fail-closed (PAID_STEP_ALREADY_SETTLED) : aucune
 *    seconde charge possible, l’exécution échoue proprement ;
 * 3. réservation au pire cas AVANT l’appel (cents et jetons), ramenée au réel
 *    au règlement ; une erreur incertaine du fournisseur laisse la réserve au
 *    pire cas et règle l’étape au pire cas (un rejeu de cette étape est refusé) ;
 * 4. bornes typées : par exécution (max_cost_cents du moteur), par participant
 *    et par jour (cents, jetons, requêtes), par participant et par cycle (cents),
 *    vérifiées dans le même lot D1 que la réservation : un refus n’écrit rien
 *    nulle part (ni registre, ni ligne d’étape) ;
 * 5. jamais de découvert : le coût réglé est plafonné à la réservation ;
 * 6. les Go-s Durable Objects (do_gb_s, 7c-1) et les lignes écrites restent
 *    comptés à part, au niveau du compte : aucun centime n’y entre, aucun Go-s
 *    dans les registres payants (une borne par participant se câblera côté
 *    orchestrateur, hors périmètre 2.1) ;
 * 7. les neurons consommés décomptent aussi le pool gratuit partagé du compte
 *    (neurons:workers-ai:<date>, quota_counters) : au réel au règlement, au
 *    pire cas sur erreur fournisseur, sans contrôle de budget (B1).
 *
 * Unités : tous les montants monétaires sont en cents de dollars US.
 *
 * Taux : instantanés datés en code (PAID_MODEL_RATES et centsOfNeurons, page
 * tarifaire Workers AI relevée le 2026-10-24), deny-by-default — une référence
 * absente est refusée, y compris les modèles gratuits (chemin 7c-1). À
 * revalider avant tout financement réel de l’enveloppe.
 */
import { MODEL_CALL_OPTIONS, type WorkersAiBinding } from '../executors/adapter';
import { ensureSchema } from '../store/schema';
import { ModelCallError, type AgentMessage, type ModelClient, type ModelOutput, type ModelUsage } from './engine';
import { bytes, inputTokenBound, readModelResponse, toProviderMessages, withTimeout, type ToolSchema } from './workers-ai-model';

/** Taux payants relevés sur la page tarifaire Workers AI le 2026-10-24 (neurons par million de jetons). */
export const PAID_MODEL_RATES: Readonly<Record<string, { input_per_m: number; output_per_m: number }>> = {
  '@cf/moonshotai/kimi-k2.6': { input_per_m: 86_364, output_per_m: 363_636 },
  '@cf/moonshotai/kimi-k2.7-code': { input_per_m: 86_364, output_per_m: 363_636 },
  '@cf/zai-org/glm-5.2': { input_per_m: 127_273, output_per_m: 400_000 },
  '@cf/zai-org/glm-5.3': { input_per_m: 127_273, output_per_m: 400_000 },
  '@cf/zai-org/glm-5.3-flash': { input_per_m: 13_636, output_per_m: 45_455 },
  '@cf/deepseek-ai/deepseek-v4-flash-0731': { input_per_m: 40_000, output_per_m: 120_000 },
  '@cf/deepseek-ai/deepseek-v4-pro-0813': { input_per_m: 120_000, output_per_m: 360_000 },
};

/**
 * Cents facturés pour des neurons : 0,011 $ pour 1 000 neurons au-delà de
 * l’allocation gratuite (page tarifaire relevée le 2026-10-24), soit 1,1
 * milli-cent (11 micro-dollars) par neuron ; arrondi au cent supérieur, jamais sous-évalué.
 */
export function centsOfNeurons(neurons: number): number {
  return Math.ceil((Math.max(0, Math.floor(neurons)) * 11) / 10_000);
}

/** Référence workers-ai d’un modèle PAYANT : deny-by-default, tout le reste est refusé à la construction. */
export function parsePaidWorkersAiRef(ref: string): string {
  const prefix = 'workers-ai:';
  if (!ref.startsWith(prefix)) {
    throw new Error('PAID_MODEL_UNSUPPORTED : fournisseur non pris en charge pour le chemin payant : ' + ref.split(':')[0] + '.');
  }
  const model = ref.slice(prefix.length);
  if (!PAID_MODEL_RATES[model]) {
    throw new Error('PAID_MODEL_UNSUPPORTED : ' + model + ' hors de la liste payante vérifiée (deny-by-default).');
  }
  return model;
}

const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_PAID_CENTS = 10_000_000;
const MAX_PAID_TOKENS = 1_000_000_000;

/**
 * CC-7 L2 : enveloppe payante PAR PARTICIPANT. Variables posées par Kevin seul
 * sur le Worker ; TOUT est à 0 par défaut (fail-closed), y compris les plafonds
 * optionnels (0 = pas de plafond supplémentaire au-delà des bornes existantes).
 */
export interface ParticipantEnvelope {
  /** Cents US par participant et par jour (P5 Q1 : 200) ; 0 = non financée. */
  readonly dayCents: number;
  /** Cents US par participant et par cycle (P5 Q1 : 1000) ; 0 = non financée. */
  readonly cycleCents: number;
  /** Jetons par participant et par jour ; 0 = pas de plafond supplémentaire. */
  readonly dayTokens: number;
  /** Appels modèle par participant et par jour ; 0 = pas de plafond supplémentaire. */
  readonly dayRequests: number;
}

/** Variables d’environnement serveur de l’enveloppe par participant (CC-7 L2). */
export interface ParticipantEnvelopeEnv {
  AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS?: string;
  AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS?: string;
  AGENT_RUN_PAID_PARTICIPANT_DAY_TOKENS?: string;
  AGENT_RUN_PAID_PARTICIPANT_DAY_REQUESTS?: string;
}

/** Entier strictement positif borné ; tout le reste vaut 0 (fail-closed). */
function positiveBounded(value: string | undefined, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : 0;
}

/**
 * Enveloppe par participant depuis l’environnement serveur : TOUT à 0 par
 * défaut. Tant que Kevin n’a pas posé les deux bornes en cents, aucun appel
 * payant n’a lieu (envelopeFunded = false → PAID_ENVELOPE_NOT_FUNDED).
 */
export function parseParticipantEnvelope(env: ParticipantEnvelopeEnv): ParticipantEnvelope {
  return {
    dayCents: positiveBounded(env.AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS, MAX_PAID_CENTS),
    cycleCents: positiveBounded(env.AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS, MAX_PAID_CENTS),
    dayTokens: positiveBounded(env.AGENT_RUN_PAID_PARTICIPANT_DAY_TOKENS, MAX_PAID_TOKENS),
    dayRequests: positiveBounded(env.AGENT_RUN_PAID_PARTICIPANT_DAY_REQUESTS, 1_000_000),
  };
}

/** L’enveloppe n’est financée que si les deux bornes en cents sont posées (jour ET cycle). */
export function envelopeFunded(envelope: ParticipantEnvelope): boolean {
  return envelope.dayCents > 0 && envelope.cycleCents > 0;
}

/** Registres quota_counters d’un participant pour un jour donné : cents, jetons, requêtes. */
export function participantDayKeys(participantId: string, day: string): {
  readonly cents: string; readonly tokens: string; readonly requests: string;
} {
  const prefix = 'paid:participant:' + participantId + ':day:' + day;
  return { cents: prefix, tokens: prefix + ':tokens', requests: prefix + ':requests' };
}

/** Registre cents par participant et par cycle (jamais remis à zéro). */
export function participantCycleKey(participantId: string, cycleId: string): string {
  return 'paid:participant:' + participantId + ':cycle:' + cycleId;
}

/** Ligne d’exécution relue pour un appel payant : participant et cycle viennent de la base, jamais des arguments. */
export interface PaidRunRow { cycle_id: string; participant_id: string; steps_done: number; cost_cents: number; max_cost_cents: number }
/** Ligne d’étape payante : réservation en cours ou règlement passé. */
export interface PaidStepRow { reserved_cents: number; actual_cents: number; settled: number }

export async function readPaidRun(db: D1Database, runId: string): Promise<PaidRunRow | null> {
  return db.prepare('SELECT cycle_id, participant_id, steps_done, cost_cents, max_cost_cents FROM agent_runs WHERE run_id = ?1')
    .bind(runId).first<PaidRunRow>();
}

export async function readPaidStep(db: D1Database, runId: string, n: number): Promise<PaidStepRow | null> {
  return db.prepare('SELECT reserved_cents, actual_cents, settled FROM agent_paid_steps WHERE run_id = ?1 AND n = ?2')
    .bind(runId, n).first<PaidStepRow>();
}

/** Outil exposé au fournisseur au format compatible OpenAI. */
export interface ProviderTool {
  readonly type: 'function';
  readonly function: { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> };
}

/**
 * Prépare l’appel fournisseur (chemins payants Workers AI et Z.ai) : outils
 * allowlistés par le moteur, messages, borne haute des jetons d’entrée.
 */
export function prepareProviderCall(schemas: (taskKind: string) => ToolSchema[], system: string,
  input: { messages: AgentMessage[]; tools: string[]; task_kind: string }): {
  tools: ProviderTool[]; messages: Record<string, unknown>[]; bound: number;
} {
  const allowed = new Set(input.tools);
  const tools: ProviderTool[] = schemas(input.task_kind).filter(schema => allowed.has(schema.name))
    .map(schema => ({ type: 'function' as const, function: { name: schema.name, description: schema.description, parameters: schema.parameters } }));
  const messages = toProviderMessages(system, input.messages);
  return { tools, messages, bound: inputTokenBound(messages, tools) };
}

export interface ParticipantStepReservation {
  runId: string; n: number; participantId: string; cycleId: string; day: string;
  /** Pire cas en cents, réservé avant l’appel. */
  cents: number;
  /** Pire cas en jetons (entrée bornée + sortie maximale), réservé avant l’appel. */
  tokens: number;
  envelope: ParticipantEnvelope; nowSec: number;
}

/**
 * Réserve le pire cas d’une étape payante PAR PARTICIPANT : registres cents du
 * jour et du cycle, jetons et requêtes du jour, et ligne d’étape, écrits dans le
 * MÊME lot D1 derrière collab_store_guard ; un refus ne laisse RIEN écrire
 * nulle part (aucun remboursement nécessaire).
 */
export async function reserveParticipantStep(db: D1Database, input: ParticipantStepReservation): Promise<void> {
  const day = participantDayKeys(input.participantId, input.day);
  const cycleKey = participantCycleKey(input.participantId, input.cycleId);
  const guardOk = '(SELECT writes FROM quota_counters WHERE day = ?1) + ?3 <= ?4'
    + ' AND (SELECT writes FROM quota_counters WHERE day = ?2) + ?3 <= ?5'
    + ' AND (?6 = 0 OR (SELECT writes FROM quota_counters WHERE day = ?7) + ?8 <= ?6)'
    + ' AND (?9 = 0 OR (SELECT writes FROM quota_counters WHERE day = ?10) + 1 <= ?9)';
  try {
    await db.batch([
      db.prepare('INSERT INTO quota_counters (day, writes) VALUES (?1, 0) ON CONFLICT(day) DO NOTHING').bind(day.cents),
      db.prepare('INSERT INTO quota_counters (day, writes) VALUES (?1, 0) ON CONFLICT(day) DO NOTHING').bind(cycleKey),
      db.prepare('INSERT INTO quota_counters (day, writes) VALUES (?1, 0) ON CONFLICT(day) DO NOTHING').bind(day.tokens),
      db.prepare('INSERT INTO quota_counters (day, writes) VALUES (?1, 0) ON CONFLICT(day) DO NOTHING').bind(day.requests),
      db.prepare('INSERT INTO collab_store_guard (ok) SELECT CASE WHEN ' + guardOk + ' THEN 1 ELSE 0 END')
        .bind(day.cents, cycleKey, input.cents, input.envelope.dayCents, input.envelope.cycleCents,
          input.envelope.dayTokens, day.tokens, input.tokens, input.envelope.dayRequests, day.requests),
      db.prepare('UPDATE quota_counters SET writes = writes + ?2 WHERE day = ?1').bind(day.cents, input.cents),
      db.prepare('UPDATE quota_counters SET writes = writes + ?2 WHERE day = ?1').bind(cycleKey, input.cents),
      db.prepare('UPDATE quota_counters SET writes = writes + ?2 WHERE day = ?1').bind(day.tokens, input.tokens),
      db.prepare('UPDATE quota_counters SET writes = writes + 1 WHERE day = ?1').bind(day.requests),
      db.prepare('INSERT INTO agent_paid_steps (run_id, n, reserved_cents, actual_cents, settled, updated_at) VALUES (?1, ?2, ?3, 0, 0, ?4)')
        .bind(input.runId, input.n, input.cents, input.nowSec),
      db.prepare('DELETE FROM collab_store_guard'),
    ]);
  } catch {
    const used = async (key: string) =>
      (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(key).first<{ writes: number }>())?.writes ?? 0;
    if ((await used(day.cents)) + input.cents > input.envelope.dayCents) {
      throw new ModelCallError('PAID_DAILY_BUDGET_EXCEEDED : enveloppe du jour insuffisante pour ce participant ; aucun appel n’est fait.', null);
    }
    if ((await used(cycleKey)) + input.cents > input.envelope.cycleCents) {
      throw new ModelCallError('PAID_CYCLE_BUDGET_EXCEEDED : borne du cycle insuffisante pour ce participant ; aucun appel n’est fait.', null);
    }
    if (input.envelope.dayTokens > 0 && (await used(day.tokens)) + input.tokens > input.envelope.dayTokens) {
      throw new ModelCallError('PAID_TOKEN_BUDGET_EXCEEDED : plafond de jetons du jour atteint pour ce participant ; aucun appel n’est fait.', null);
    }
    if (input.envelope.dayRequests > 0 && (await used(day.requests)) + 1 > input.envelope.dayRequests) {
      throw new ModelCallError('PAID_REQUEST_BUDGET_EXCEEDED : plafond d’appels du jour atteint pour ce participant ; aucun appel n’est fait.', null);
    }
    throw new ModelCallError('PAID_RESERVE_FAILED : réservation de l’étape payante refusée ; rien n’a été écrit.', null);
  }
}

export interface ParticipantStepSettlement {
  runId: string; n: number; participantId: string; cycleId: string; day: string;
  reservedCents: number; actualCents: number; reservedTokens: number; actualTokens: number; nowSec: number;
}

/**
 * Règle une étape payante PAR PARTICIPANT : remboursement du trop-versé (cents
 * du jour et du cycle, jetons du jour ; jamais de découvert — le coût réglé est
 * plafonné à la réservation), requêtes conservées (l’appel a eu lieu), passage
 * à settled dans le même lot D1. `extra` étend le lot (B1 : décompte du pool
 * gratuit partagé pour le chemin Workers AI).
 */
export async function settleParticipantStep(db: D1Database, input: ParticipantStepSettlement,
  extra: D1PreparedStatement[] = []): Promise<void> {
  const settled = Math.min(Math.max(Math.floor(input.actualCents), 0), input.reservedCents);
  const refundCents = input.reservedCents - settled;
  const refundTokens = Math.max(0, Math.floor(input.reservedTokens) - Math.max(0, Math.floor(input.actualTokens)));
  const day = participantDayKeys(input.participantId, input.day);
  const cycleKey = participantCycleKey(input.participantId, input.cycleId);
  await db.batch([
    ...(refundCents > 0 ? [
      db.prepare('UPDATE quota_counters SET writes = MAX(writes - ?2, 0) WHERE day = ?1').bind(day.cents, refundCents),
      db.prepare('UPDATE quota_counters SET writes = MAX(writes - ?2, 0) WHERE day = ?1').bind(cycleKey, refundCents),
    ] : []),
    ...(refundTokens > 0 ? [
      db.prepare('UPDATE quota_counters SET writes = MAX(writes - ?2, 0) WHERE day = ?1').bind(day.tokens, refundTokens),
    ] : []),
    ...extra,
    db.prepare('UPDATE agent_paid_steps SET actual_cents = ?3, settled = 1, updated_at = ?4 WHERE run_id = ?1 AND n = ?2 AND settled = 0')
      .bind(input.runId, input.n, settled, input.nowSec),
  ]);
}

export interface PaidModelOptions {
  ai: WorkersAiBinding;
  /** Référence workers-ai:@cf/vendor/model d’un modèle payant (liste PAID_MODEL_RATES seulement). */
  ref: string;
  db: D1Database;
  /** Exécution concernée : étape, participant et cycle relus dedans, jamais depuis les arguments du modèle. */
  runId: string;
  /** CC-7 L2 : enveloppe PAR PARTICIPANT (0 par défaut = PAID_ENVELOPE_NOT_FUNDED avant tout appel). */
  envelope: ParticipantEnvelope;
  /** Schémas des outils exposés au modèle (hôte, allowlist par type de tâche). */
  schemas: (taskKind: string) => ToolSchema[];
  /** Consigne système du rôle (persona) ; les données restent dans les messages. */
  system: string;
  maxOutputTokens: number;
  timeoutMs?: number;
  now?: () => Date;
}

/** B1 : décompte du pool gratuit partagé (sans contrôle de budget) dans le lot de règlement. */
function neuronsStatements(db: D1Database, neuronsKey: string, usedNeurons: number): D1PreparedStatement[] {
  const used = Math.max(0, Math.floor(usedNeurons));
  return [
    db.prepare('INSERT INTO quota_counters (day, writes) VALUES (?1, 0) ON CONFLICT(day) DO NOTHING').bind(neuronsKey),
    db.prepare('UPDATE quota_counters SET writes = writes + ?2 WHERE day = ?1').bind(neuronsKey, used),
  ];
}

/** Modèle Workers AI payant : même contrat ModelClient que le chemin gratuit, coût en cents borné par l’owner. */
export function createPaidWorkersAiModel(options: PaidModelOptions): ModelClient {
  const model = parsePaidWorkersAiRef(options.ref);
  const rates = PAID_MODEL_RATES[model];
  const neurons = (input: number, output: number) => Math.ceil((input * rates.input_per_m + output * rates.output_per_m) / 1_000_000);
  if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens > 8192) {
    throw new Error('maxOutputTokens entre 1 et 8192.');
  }
  return {
    async complete(input): Promise<{ output: ModelOutput; usage: ModelUsage }> {
      // (1) Enveloppe par participant non financée : refus avant tout appel, aucun quota touché.
      if (!envelopeFunded(options.envelope)) {
        throw new ModelCallError('PAID_ENVELOPE_NOT_FUNDED : enveloppe owner par participant absente ou nulle ; aucun appel payant n’est fait.', null);
      }
      const now = options.now?.() ?? new Date();
      const nowSec = Math.floor(now.getTime() / 1000);
      const day = now.toISOString().slice(0, 10);
      const neuronsKey = 'neurons:workers-ai:' + day;
      await ensureSchema(options.db);
      const run = await readPaidRun(options.db, options.runId);
      if (!run) throw new ModelCallError('PAID_RUN_UNKNOWN : exécution ' + options.runId + ' introuvable.', null);
      // Étape en cours : le moteur réclame l’étape n = steps_done et ne l’incrémente qu’au checkpoint.
      const n = run.steps_done;
      const previous = await readPaidStep(options.db, options.runId, n);
      if (previous?.settled) {
        // (2) Coupure entre le règlement et la persistance de la sortie : fail-closed, aucune seconde charge.
        throw new ModelCallError('PAID_STEP_ALREADY_SETTLED : l’étape ' + n + ' est déjà réglée ; rejeu refusé pour éviter une seconde charge.', null);
      }
      const prepared = prepareProviderCall(options.schemas, options.system, input);
      const worstNeurons = neurons(prepared.bound, options.maxOutputTokens);
      const worstCents = Math.min(centsOfNeurons(worstNeurons), MAX_PAID_CENTS);
      const worstTokens = prepared.bound + options.maxOutputTokens;
      // (4) Borne par exécution : refus PRÉEMPTIF avant toute réservation (jamais de découvert).
      if (run.cost_cents + worstCents > run.max_cost_cents) {
        throw new ModelCallError('PAID_RUN_BUDGET_EXCEEDED : ' + run.cost_cents + ' + ' + worstCents + ' cents > plafond '
          + run.max_cost_cents + ' de l’exécution ; aucun appel n’est fait.', null);
      }
      let reserved: number;
      if (previous) {
        // (2) Rejeu idempotent : l’étape a déjà réservé, jamais deux réservations.
        reserved = previous.reserved_cents;
      } else {
        await reserveParticipantStep(options.db, { runId: options.runId, n, participantId: run.participant_id, cycleId: run.cycle_id,
          day, cents: worstCents, tokens: worstTokens, envelope: options.envelope, nowSec });
        reserved = worstCents;
      }
      let raw: unknown;
      try {
        raw = await withTimeout(options.ai.run(model, {
          ...MODEL_CALL_OPTIONS[model], messages: prepared.messages, max_tokens: options.maxOutputTokens,
          ...(prepared.tools.length ? { tools: prepared.tools } : {}),
        }), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      } catch (error) {
        // (3) Erreur incertaine du fournisseur : la réserve reste au pire cas (cents et
        // jetons), l’étape est réglée au pire cas ; un rejeu sera refusé fail-closed.
        await settleParticipantStep(options.db, { runId: options.runId, n, participantId: run.participant_id, cycleId: run.cycle_id,
          day, reservedCents: reserved, actualCents: reserved, reservedTokens: worstTokens, actualTokens: worstTokens, nowSec },
        neuronsStatements(options.db, neuronsKey, worstNeurons));
        throw new ModelCallError('workers_ai_error: ' + (error instanceof Error ? error.message : String(error)),
          { tokens: prepared.bound, cost_cents: reserved });
      }
      const parsed = readModelResponse(raw);
      const inputTokens = parsed.input ?? prepared.bound;
      const outputTokens = parsed.output_tokens ?? bytes(JSON.stringify(parsed.output));
      const actualNeurons = neurons(inputTokens, outputTokens);
      const actualCents = Math.min(centsOfNeurons(actualNeurons), reserved);
      const actualTokens = inputTokens + outputTokens;
      await settleParticipantStep(options.db, { runId: options.runId, n, participantId: run.participant_id, cycleId: run.cycle_id,
        day, reservedCents: reserved, actualCents, reservedTokens: worstTokens, actualTokens, nowSec },
      neuronsStatements(options.db, neuronsKey, actualNeurons));
      return { output: parsed.output, usage: { tokens: actualTokens, cost_cents: actualCents } };
    },
  };
}
