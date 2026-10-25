/**
 * CC-7 L2 (S3 de CC-PLAN-7 v0.2) — enveloppe de coût par participant du canal
 * API payant : bornes refusées en code, par jour et par cycle (UTC), sur les
 * cents, les jetons et les requêtes. Généralise l’enveloppe owner de l7d
 * (cents, globaux) au périmètre par participant de CC-7.
 *
 * Tout est éteint par défaut : les bornes cents valent 0 tant que Kevin n’a pas
 * posé les variables d’enveloppe (GO de financement ; décision P5 Q1 : 200
 * cents/participant/jour, 1 000 cents/participant/cycle). Les bornes jetons et
 * requêtes sont des garde-fous secondaires qui ne coûtent rien : elles
 * s’appliquent à leurs plafonds en code tant que la variable est absente, et
 * une valeur explicite ne peut que resserrer.
 *
 * Garde-fous (hérités de l7d) :
 * 1. enveloppe non financée : refus en code, aucun appel ;
 * 2. rejeu idempotent AVANT réservation (agent_paid_steps, PK (run_id, n)) ;
 *    une étape déjà réglée rejouée est refusée fail-closed ;
 * 3. réservation au pire cas AVANT l’appel, ramenée au réel au règlement ;
 *    une erreur du fournisseur règle l’étape au pire cas (jamais sous-comptée) ;
 * 4. bornes jour et cycle vérifiées dans le MÊME lot D1 que la réservation :
 *    un refus n’écrit rien nulle part (ni registre, ni ligne d’étape) ;
 * 5. jamais de découvert : le réel est plafonné à la réservation.
 *
 * Les requêtes consommées ne sont jamais remboursées : l’appel a eu lieu.
 * Les bornes lignes et Go-s Durable Objects par participant (jour/cycle)
 * exigent le comptage réel des effets d’outils côté orchestrateur
 * (src/collab-store/agentrun) : elles arrivent avec le lot L5.
 *
 * Unités : cents de dollars US, jetons, requêtes ; jour UTC (ISO yyyy-mm-dd).
 */
import { ModelCallError } from '../agentrun/engine';

export interface ParticipantEnvelopeLimits {
  readonly dayCents: number;
  readonly cycleCents: number;
  readonly dayTokens: number;
  readonly cycleTokens: number;
  readonly dayRequests: number;
  readonly cycleRequests: number;
}

/** Plafonds en code (cents : décision Kevin P5 Q1) ; une valeur au-dessus vaut 0 (refus). */
export const MAX_PARTICIPANT_DAY_CENTS = 200;
export const MAX_PARTICIPANT_CYCLE_CENTS = 1_000;
export const MAX_PARTICIPANT_DAY_TOKENS = 1_000_000;
export const MAX_PARTICIPANT_CYCLE_TOKENS = 2_000_000;
export const MAX_PARTICIPANT_DAY_REQUESTS = 200;
export const MAX_PARTICIPANT_CYCLE_REQUESTS = 1_000;

/** Entier 1..max valide ; tout le reste (absent, 0, négatif, non entier, > max) vaut 0. */
export function parseParticipantCap(value: string | undefined, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : 0;
}

/** Garde-fou secondaire : défaut (absent/0/invalide) = plafond en code, jamais au-dessus. */
export function parseParticipantGuard(value: string | undefined, max: number): number {
  return parseParticipantCap(value, max) || max;
}

/**
 * Enveloppe par participant depuis l’environnement serveur : les bornes cents
 * (argent réel) exigent le GO explicite de Kevin, les garde-fous jetons et
 * requêtes s’appliquent par défaut à leurs plafonds en code.
 */
export function parseParticipantEnvelope(env: Record<string, string | undefined>): ParticipantEnvelopeLimits {
  return {
    dayCents: parseParticipantCap(env.AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS, MAX_PARTICIPANT_DAY_CENTS),
    cycleCents: parseParticipantCap(env.AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS, MAX_PARTICIPANT_CYCLE_CENTS),
    dayTokens: parseParticipantGuard(env.AGENT_RUN_PAID_PARTICIPANT_DAY_TOKENS, MAX_PARTICIPANT_DAY_TOKENS),
    cycleTokens: parseParticipantGuard(env.AGENT_RUN_PAID_PARTICIPANT_CYCLE_TOKENS, MAX_PARTICIPANT_CYCLE_TOKENS),
    dayRequests: parseParticipantGuard(env.AGENT_RUN_PAID_PARTICIPANT_DAY_REQUESTS, MAX_PARTICIPANT_DAY_REQUESTS),
    cycleRequests: parseParticipantGuard(env.AGENT_RUN_PAID_PARTICIPANT_CYCLE_REQUESTS, MAX_PARTICIPANT_CYCLE_REQUESTS),
  };
}

/** L’enveloppe est financée ssi les DEUX bornes cents sont posées (GO de Kevin). */
export function participantEnvelopeFunded(limits: ParticipantEnvelopeLimits): boolean {
  return limits.dayCents > 0 && limits.cycleCents > 0;
}

/** Clés des registres quota_counters (colonne day = clé, colonne writes = montant). */
export function participantRegistreKeys(participantId: string, cycleId: string, date: string): {
  readonly centsDay: string;
  readonly centsCycle: string;
  readonly tokensDay: string;
  readonly tokensCycle: string;
  readonly requestsDay: string;
  readonly requestsCycle: string;
} {
  const base = 'paid:participant:' + participantId;
  return {
    centsDay: base + ':day:' + date,
    centsCycle: base + ':cycle:' + cycleId,
    tokensDay: base + ':tok:day:' + date,
    tokensCycle: base + ':tok:cycle:' + cycleId,
    requestsDay: base + ':req:day:' + date,
    requestsCycle: base + ':req:cycle:' + cycleId,
  };
}

async function readCounter(db: D1Database, key: string): Promise<number> {
  return (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(key)
    .first<{ writes: number }>())?.writes ?? 0;
}

export interface ParticipantRegistreKeys extends ReturnType<typeof participantRegistreKeys> {}

export interface ReserveParticipantStepInput {
  readonly runId: string;
  readonly n: number;
  /** Pire cas des cents de l’étape. */
  readonly cents: number;
  /** Pire cas des jetons de l’étape (entrée bornée + sortie maximale). */
  readonly tokens: number;
  readonly keys: ParticipantRegistreKeys;
  readonly limits: ParticipantEnvelopeLimits;
  readonly nowSec: number;
}

/**
 * Réserve le pire cas d’une étape payante : les six registres (cents, jetons,
 * requêtes — jour et cycle) et la ligne d’étape sont écrits dans le MÊME lot D1
 * derrière collab_store_guard ; un refus ne laisse RIEN écrire nulle part.
 */
export async function reserveParticipantStep(db: D1Database, input: ReserveParticipantStepInput): Promise<void> {
  const keys = [input.keys.centsDay, input.keys.centsCycle, input.keys.tokensDay,
    input.keys.tokensCycle, input.keys.requestsDay, input.keys.requestsCycle];
  try {
    await db.batch([
      ...keys.map(key => db.prepare('INSERT INTO quota_counters (day, writes) VALUES (?1, 0) ON CONFLICT(day) DO NOTHING').bind(key)),
      db.prepare('INSERT INTO collab_store_guard (ok) SELECT CASE WHEN'
        + ' (SELECT writes FROM quota_counters WHERE day = ?1) + ?7 <= ?9'
        + ' AND (SELECT writes FROM quota_counters WHERE day = ?2) + ?7 <= ?10'
        + ' AND (SELECT writes FROM quota_counters WHERE day = ?3) + ?8 <= ?11'
        + ' AND (SELECT writes FROM quota_counters WHERE day = ?4) + ?8 <= ?12'
        + ' AND (SELECT writes FROM quota_counters WHERE day = ?5) + 1 <= ?13'
        + ' AND (SELECT writes FROM quota_counters WHERE day = ?6) + 1 <= ?14'
        + ' THEN 1 ELSE 0 END')
        .bind(input.keys.centsDay, input.keys.centsCycle, input.keys.tokensDay, input.keys.tokensCycle,
          input.keys.requestsDay, input.keys.requestsCycle,
          input.cents, input.tokens,
          input.limits.dayCents, input.limits.cycleCents, input.limits.dayTokens, input.limits.cycleTokens,
          input.limits.dayRequests, input.limits.cycleRequests),
      db.prepare('UPDATE quota_counters SET writes = writes + ?2 WHERE day = ?1').bind(input.keys.centsDay, input.cents),
      db.prepare('UPDATE quota_counters SET writes = writes + ?2 WHERE day = ?1').bind(input.keys.centsCycle, input.cents),
      db.prepare('UPDATE quota_counters SET writes = writes + ?2 WHERE day = ?1').bind(input.keys.tokensDay, input.tokens),
      db.prepare('UPDATE quota_counters SET writes = writes + ?2 WHERE day = ?1').bind(input.keys.tokensCycle, input.tokens),
      db.prepare('UPDATE quota_counters SET writes = writes + 1 WHERE day = ?1').bind(input.keys.requestsDay),
      db.prepare('UPDATE quota_counters SET writes = writes + 1 WHERE day = ?1').bind(input.keys.requestsCycle),
      db.prepare('INSERT INTO agent_paid_steps (run_id, n, reserved_cents, actual_cents, settled, updated_at) VALUES (?1, ?2, ?3, 0, 0, ?4)')
        .bind(input.runId, input.n, input.cents, input.nowSec),
      db.prepare('DELETE FROM collab_store_guard'),
    ]);
  } catch {
    // Refus : re-diagnostic typé, rien n’a été écrit (lot atomique).
    const centsDay = await readCounter(db, input.keys.centsDay);
    if (centsDay + input.cents > input.limits.dayCents) {
      throw new ModelCallError('PAID_DAILY_BUDGET_EXCEEDED : enveloppe du jour insuffisante (' + centsDay + ' + ' + input.cents
        + ' > ' + input.limits.dayCents + ' cents) ; aucun appel n’est fait.', null);
    }
    const centsCycle = await readCounter(db, input.keys.centsCycle);
    if (centsCycle + input.cents > input.limits.cycleCents) {
      throw new ModelCallError('PAID_CYCLE_BUDGET_EXCEEDED : borne du cycle insuffisante (' + centsCycle + ' + ' + input.cents
        + ' > ' + input.limits.cycleCents + ' cents) ; aucun appel n’est fait.', null);
    }
    const tokensDay = await readCounter(db, input.keys.tokensDay);
    if (tokensDay + input.tokens > input.limits.dayTokens) {
      throw new ModelCallError('PAID_TOKEN_DAILY_EXCEEDED : garde-fou de jetons du jour insuffisant (' + tokensDay + ' + ' + input.tokens
        + ' > ' + input.limits.dayTokens + ') ; aucun appel n’est fait.', null);
    }
    const tokensCycle = await readCounter(db, input.keys.tokensCycle);
    if (tokensCycle + input.tokens > input.limits.cycleTokens) {
      throw new ModelCallError('PAID_TOKEN_CYCLE_EXCEEDED : garde-fou de jetons du cycle insuffisant (' + tokensCycle + ' + ' + input.tokens
        + ' > ' + input.limits.cycleTokens + ') ; aucun appel n’est fait.', null);
    }
    const requestsDay = await readCounter(db, input.keys.requestsDay);
    if (requestsDay + 1 > input.limits.dayRequests) {
      throw new ModelCallError('PAID_REQUEST_DAILY_EXCEEDED : garde-fou de requêtes du jour atteint (' + requestsDay + ' + 1 > '
        + input.limits.dayRequests + ') ; aucun appel n’est fait.', null);
    }
    const requestsCycle = await readCounter(db, input.keys.requestsCycle);
    if (requestsCycle + 1 > input.limits.cycleRequests) {
      throw new ModelCallError('PAID_REQUEST_CYCLE_EXCEEDED : garde-fou de requêtes du cycle atteint (' + requestsCycle + ' + 1 > '
        + input.limits.cycleRequests + ') ; aucun appel n’est fait.', null);
    }
    throw new ModelCallError('PAID_RESERVE_FAILED : réservation de l’étape payante refusée ; rien n’a été écrit.', null);
  }
}

export interface SettleParticipantStepInput {
  readonly runId: string;
  readonly n: number;
  readonly keys: ParticipantRegistreKeys;
  readonly reservedCents: number;
  readonly actualCents: number;
  readonly reservedTokens: number;
  readonly actualTokens: number;
  readonly nowSec: number;
}

/**
 * Règle l’étape : remboursement du trop-versé (cents et jetons, jour et cycle),
 * requêtes conservées (l’appel a eu lieu), passage à settled dans le MÊME lot.
 * Le réel est plafonné à la réservation : jamais de découvert.
 */
export async function settleParticipantStep(db: D1Database, input: SettleParticipantStepInput): Promise<void> {
  const cents = Math.min(Math.max(Math.floor(input.actualCents), 0), input.reservedCents);
  const tokens = Math.min(Math.max(Math.floor(input.actualTokens), 0), input.reservedTokens);
  const refundCents = input.reservedCents - cents;
  const refundTokens = input.reservedTokens - tokens;
  await db.batch([
    ...(refundCents > 0 ? [
      db.prepare('UPDATE quota_counters SET writes = MAX(writes - ?2, 0) WHERE day = ?1').bind(input.keys.centsDay, refundCents),
      db.prepare('UPDATE quota_counters SET writes = MAX(writes - ?2, 0) WHERE day = ?1').bind(input.keys.centsCycle, refundCents),
    ] : []),
    ...(refundTokens > 0 ? [
      db.prepare('UPDATE quota_counters SET writes = MAX(writes - ?2, 0) WHERE day = ?1').bind(input.keys.tokensDay, refundTokens),
      db.prepare('UPDATE quota_counters SET writes = MAX(writes - ?2, 0) WHERE day = ?1').bind(input.keys.tokensCycle, refundTokens),
    ] : []),
    db.prepare('UPDATE agent_paid_steps SET actual_cents = ?3, settled = 1, updated_at = ?4 WHERE run_id = ?1 AND n = ?2 AND settled = 0')
      .bind(input.runId, input.n, cents, input.nowSec),
  ]);
}
