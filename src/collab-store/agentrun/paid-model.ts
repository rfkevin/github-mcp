/**
 * CC-5 l7 (incrément 7d, amendement A5 du plan de clôture v1.1) — modèles
 * Workers AI payants derrière l’enveloppe de coût de l’owner.
 *
 * Inactif par défaut : sans AGENT_RUN_PAID_MODEL le câblage ne change pas
 * (chemin gratuit de 7c-1 ou modèle simulé de 7b) ; et même posé, aucun appel n’a
 * lieu tant que l’enveloppe owner AGENT_RUN_PAID_ENVELOPE_CENTS n’est pas
 * financée (0, absent ou invalide : PAID_ENVELOPE_NOT_FUNDED, refus avant tout
 * appel, aucun quota touché).
 *
 * Garde-fous (A5) :
 * 1. enveloppe non financée : refus en code, aucun appel ;
 * 2. rejeu idempotent AVANT réservation : une étape déjà réservée ne réserve
 *    jamais deux fois (agent_paid_steps, PRIMARY KEY (run_id, n)) ; une étape
 *    déjà réglée rejouée — coupure entre le règlement et la persistance de la
 *    sortie — est refusée fail-closed (PAID_STEP_ALREADY_SETTLED) : aucune
 *    seconde charge possible, l’exécution échoue proprement ;
 * 3. réservation au pire cas AVANT l’appel, ramenée au réel au règlement ; une
 *    erreur incertaine du fournisseur laisse la réserve au pire cas et règle
 *    l’étape au pire cas (un rejeu de cette étape est refusé) ;
 * 4. bornes typées par exécution (max_cost_cents existant du moteur), par jour
 *    et par cycle, vérifiées dans le même lot D1 que la réservation : un refus
 *    n’écrit rien nulle part (ni registre, ni ligne d’étape) ;
 * 5. jamais de découvert : le coût réglé est plafonné à la réservation ;
 * 6. les Go-s Durable Objects (do_gb_s, 7c-1) restent comptés à part : aucun
 *    centime n’y entre, aucun Go-s dans les registres payants.
 *
 * Taux : instantanés datés en code (PAID_MODEL_RATES et centsOfNeurons, page
 * tarifaire Workers AI relevée le 2026-10-24), deny-by-default — une référence
 * absente est refusée, y compris les modèles gratuits (chemin 7c-1). À
 * revalider avant tout financement réel de l’enveloppe.
 */
import { MODEL_CALL_OPTIONS, type WorkersAiBinding } from '../executors/adapter';
import { ensureSchema } from '../store/schema';
import { ModelCallError, type ModelClient, type ModelOutput, type ModelUsage } from './engine';
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
 * l’allocation gratuite (page tarifaire relevée le 2026-10-24), soit 11
 * milli-cents par neuron ; arrondi au cent supérieur, jamais sous-évalué.
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

/** Enveloppe owner : entier de cents strictement positif et borné ; tout le reste vaut 0 (non financée). */
export function parsePaidEnvelope(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 10_000_000 ? parsed : 0;
}

/** Borne par cycle : défaut et plafond = l’enveloppe du jour. */
export function parsePaidCycleCap(value: string | undefined, envelopeCents: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= envelopeCents ? parsed : envelopeCents;
}

export interface PaidModelOptions {
  ai: WorkersAiBinding;
  /** Référence workers-ai:@cf/vendor/model d’un modèle payant (liste PAID_MODEL_RATES seulement). */
  ref: string;
  db: D1Database;
  /** Exécution concernée : étape en cours et cycle relus dedans, jamais depuis les arguments du modèle. */
  runId: string;
  /** Enveloppe owner du jour en cents ; 0 = aucun appel payant (PAID_ENVELOPE_NOT_FUNDED). */
  envelopeCents: number;
  /** Borne par cycle en cents (défaut et plafond : l’enveloppe). */
  cycleCents: number;
  /** Schémas des outils exposés au modèle (hôte, allowlist par type de tâche). */
  schemas: (taskKind: string) => ToolSchema[];
  /** Consigne système du rôle (persona) ; les données restent dans les messages. */
  system: string;
  maxOutputTokens: number;
  timeoutMs?: number;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PAID_CENTS = 10_000_000;

interface RunCostRow { cycle_id: string; steps_done: number; cost_cents: number; max_cost_cents: number }
interface PaidStepRow { reserved_cents: number; actual_cents: number; settled: number }

/**
 * Réserve le pire cas d’une étape payante : les deux registres (jour, cycle) et
 * la ligne d’étape sont écrits dans le MÊME lot D1 derrière collab_store_guard ;
 * un refus ne laisse RIEN écrire nulle part (aucun remboursement nécessaire).
 */
async function reservePaidStep(db: D1Database, input: {
  runId: string; n: number; cents: number; dayKey: string; cycleKey: string; dayBudget: number; cycleBudget: number; nowSec: number;
}): Promise<void> {
  try {
    await db.batch([
      db.prepare('INSERT INTO quota_counters (day, writes) VALUES (?1, 0) ON CONFLICT(day) DO NOTHING').bind(input.dayKey),
      db.prepare('INSERT INTO quota_counters (day, writes) VALUES (?1, 0) ON CONFLICT(day) DO NOTHING').bind(input.cycleKey),
      db.prepare('INSERT INTO collab_store_guard (ok) SELECT CASE WHEN (SELECT writes FROM quota_counters WHERE day = ?1) + ?3 <= ?4'
        + ' AND (SELECT writes FROM quota_counters WHERE day = ?2) + ?3 <= ?5 THEN 1 ELSE 0 END')
        .bind(input.dayKey, input.cycleKey, input.cents, input.dayBudget, input.cycleBudget),
      db.prepare('UPDATE quota_counters SET writes = writes + ?2 WHERE day = ?1').bind(input.dayKey, input.cents),
      db.prepare('UPDATE quota_counters SET writes = writes + ?2 WHERE day = ?1').bind(input.cycleKey, input.cents),
      db.prepare('INSERT INTO agent_paid_steps (run_id, n, reserved_cents, actual_cents, settled, updated_at) VALUES (?1, ?2, ?3, 0, 0, ?4)')
        .bind(input.runId, input.n, input.cents, input.nowSec),
      db.prepare('DELETE FROM collab_store_guard'),
    ]);
  } catch {
    const day = (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(input.dayKey).first<{ writes: number }>())?.writes ?? 0;
    const cycle = (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(input.cycleKey).first<{ writes: number }>())?.writes ?? 0;
    if (day + input.cents > input.dayBudget) {
      throw new ModelCallError('PAID_DAILY_BUDGET_EXCEEDED : enveloppe du jour insuffisante (' + day + ' + ' + input.cents
        + ' > ' + input.dayBudget + ' cents) ; aucun appel n’est fait.', null);
    }
    if (cycle + input.cents > input.cycleBudget) {
      throw new ModelCallError('PAID_CYCLE_BUDGET_EXCEEDED : borne du cycle insuffisante (' + cycle + ' + ' + input.cents
        + ' > ' + input.cycleBudget + ' cents) ; aucun appel n’est fait.', null);
    }
    throw new ModelCallError('PAID_RESERVE_FAILED : réservation de l’étape payante refusée ; rien n’a été écrit.', null);
  }
}

/**
 * Règle une étape payante : remboursement du trop-versé sur les DEUX registres
 * et passage à settled dans le même lot D1 (avant le lot, un rejeu reprend la
 * réservation existante ; après, il est refusé fail-closed).
 */
async function settlePaidStep(db: D1Database, input: {
  runId: string; n: number; dayKey: string; cycleKey: string; reserved: number; actual: number; nowSec: number;
}): Promise<void> {
  const settled = Math.min(Math.max(Math.floor(input.actual), 0), input.reserved);
  const refund = input.reserved - settled;
  await db.batch([
    ...(refund > 0 ? [
      db.prepare('UPDATE quota_counters SET writes = MAX(writes - ?2, 0) WHERE day = ?1').bind(input.dayKey, refund),
      db.prepare('UPDATE quota_counters SET writes = MAX(writes - ?2, 0) WHERE day = ?1').bind(input.cycleKey, refund),
    ] : []),
    db.prepare('UPDATE agent_paid_steps SET actual_cents = ?3, settled = 1, updated_at = ?4 WHERE run_id = ?1 AND n = ?2 AND settled = 0')
      .bind(input.runId, input.n, settled, input.nowSec),
  ]);
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
      // (1) Enveloppe owner non financée : refus avant tout appel, aucun quota touché.
      if (!(options.envelopeCents > 0)) {
        throw new ModelCallError('PAID_ENVELOPE_NOT_FUNDED : enveloppe owner absente ou nulle ; aucun appel payant n’est fait.', null);
      }
      const now = options.now?.() ?? new Date();
      const nowSec = Math.floor(now.getTime() / 1000);
      await ensureSchema(options.db);
      const run = await options.db.prepare('SELECT cycle_id, steps_done, cost_cents, max_cost_cents FROM agent_runs WHERE run_id = ?1')
        .bind(options.runId).first<RunCostRow>();
      if (!run) throw new ModelCallError('PAID_RUN_UNKNOWN : exécution ' + options.runId + ' introuvable.', null);
      // Étape en cours : le moteur réclame l’étape n = steps_done et ne l’incrémente qu’au checkpoint.
      const n = run.steps_done;
      const dayKey = 'paid:day:' + now.toISOString().slice(0, 10);
      const cycleKey = 'paid:cycle:' + run.cycle_id;
      const previous = await options.db.prepare('SELECT reserved_cents, actual_cents, settled FROM agent_paid_steps WHERE run_id = ?1 AND n = ?2')
        .bind(options.runId, n).first<PaidStepRow>();
      if (previous?.settled) {
        // (2) Coupure entre le règlement et la persistance de la sortie : fail-closed, aucune seconde charge.
        throw new ModelCallError('PAID_STEP_ALREADY_SETTLED : l’étape ' + n + ' est déjà réglée ; rejeu refusé pour éviter une seconde charge.', null);
      }
      const allowed = new Set(input.tools);
      const tools = options.schemas(input.task_kind).filter(schema => allowed.has(schema.name))
        .map(schema => ({ type: 'function', function: { name: schema.name, description: schema.description, parameters: schema.parameters } }));
      const messages = toProviderMessages(options.system, input.messages);
      const bound = inputTokenBound(messages, tools);
      const worstCents = Math.min(centsOfNeurons(neurons(bound, options.maxOutputTokens)), MAX_PAID_CENTS);
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
        await reservePaidStep(options.db, { runId: options.runId, n, cents: worstCents, dayKey, cycleKey,
          dayBudget: options.envelopeCents, cycleBudget: Math.min(options.cycleCents, options.envelopeCents), nowSec });
        reserved = worstCents;
      }
      let raw: unknown;
      try {
        raw = await withTimeout(options.ai.run(model, {
          ...MODEL_CALL_OPTIONS[model], messages, max_tokens: options.maxOutputTokens,
          ...(tools.length ? { tools } : {}),
        }), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      } catch (error) {
        // (3) Erreur incertaine du fournisseur : la réserve reste au pire cas, l’étape est réglée au pire
        // cas ; un rejeu de cette étape sera refusé fail-closed : aucune seconde charge possible.
        await settlePaidStep(options.db, { runId: options.runId, n, dayKey, cycleKey, reserved, actual: reserved, nowSec });
        throw new ModelCallError('workers_ai_error: ' + (error instanceof Error ? error.message : String(error)),
          { tokens: bound, cost_cents: reserved });
      }
      const parsed = readModelResponse(raw);
      const inputTokens = parsed.input ?? bound;
      const outputTokens = parsed.output_tokens ?? bytes(JSON.stringify(parsed.output));
      const actualCents = Math.min(centsOfNeurons(neurons(inputTokens, outputTokens)), reserved);
      await settlePaidStep(options.db, { runId: options.runId, n, dayKey, cycleKey, reserved, actual: actualCents, nowSec });
      return { output: parsed.output, usage: { tokens: inputTokens + outputTokens, cost_cents: actualCents } };
    },
  };
}
