/**
 * CC-4 A2 (plan §6.5, §7) — arrêt d'urgence et contrat d'enveloppe budgétaire.
 *
 * - `halt` : drapeau posé ou levé UNIQUEMENT par le canal owner (owner.decision
 *   sur le cycle système owner-registry, même lot CAS que le drapeau). Tant
 *   qu'il est posé, aucune action automatique mutante ne démarre : avance de
 *   phase par policy, nouvelle réservation budgétaire (donc nouvelle
 *   invocation, A1). L'état du store est conservé tel quel.
 * - Enveloppes : plafond par scope en centimes, 0 par défaut (aucune ligne =
 *   0 €). Une invocation réserve son coût maximal AVANT l'appel ; une réserve
 *   qui dépasserait le reste est refusée sans aucune écriture
 *   (BUDGET_INSUFFICIENT) ; le solde après usage libère la réserve et compte
 *   le coût réel. Relever un plafond est un acte owner (demande préparée,
 *   lot ultérieur) : aucun chemin agent n'écrit budget_envelopes.limit_cents.
 */
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { ownerAppend, REGISTRY_CYCLE, type OwnerWriteResult } from './decisions';
import type { OwnerProof } from './proof';

export const HALT_FLAG = 'halt';
/**
 * Prédicat SQL « arrêt d'urgence posé », à placer DANS la garde transactionnelle
 * de toute écriture automatique : le pré-check hors lot ne suffit pas (un halt
 * posé entre le pré-check et le lot doit annuler le lot — revue #115 R1).
 */
export const HALT_ACTIVE_SQL = "EXISTS (SELECT 1 FROM owner_flags WHERE name = 'halt' AND value = '1')";
export const GLOBAL_BUDGET_SCOPE = 'global';
const RESERVATION_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const SCOPE_RE = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;

/** true quand le propriétaire a posé l'arrêt d'urgence. */
export async function isAutomationHalted(db: D1Database): Promise<boolean> {
  await ensureSchema(db);
  const row = await db.prepare('SELECT value FROM owner_flags WHERE name = ?1').bind(HALT_FLAG).first<{ value: string }>();
  return row?.value === '1';
}

/** Refus typé quand l'arrêt d'urgence est posé (aucune écriture n'a eu lieu). */
export async function assertAutomationRunning(db: D1Database): Promise<void> {
  if (await isAutomationHalted(db)) {
    throw new CollabStoreError('AUTOMATION_HALTED',
      'Arrêt d’urgence posé par le propriétaire sur /owner : aucune action automatique ne démarre ; l’état est conservé.');
  }
}

/** Pose ou lève l'arrêt d'urgence (canal owner seulement). */
export async function setAutomationHalt(db: D1Database, input: {
  halted: boolean; proof: OwnerProof; op: string; now?: () => Date;
}): Promise<OwnerWriteResult> {
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  return ownerAppend(db, {
    cycleId: REGISTRY_CYCLE,
    key: 'owner-halt:' + input.op,
    payload: { action: input.halted ? 'halt_automation' : 'resume_automation' },
    proof: input.proof,
    sideEffects: key => [db.prepare([
      'INSERT INTO owner_flags (name, value, event_seq, updated_at)',
      'VALUES (?1, ?2, (SELECT seq FROM events WHERE idempotency_key = ?3), ?4)',
      'ON CONFLICT(name) DO UPDATE SET value = excluded.value, event_seq = excluded.event_seq, updated_at = excluded.updated_at',
    ].join(' ')).bind(HALT_FLAG, input.halted ? '1' : '0', key, at)],
    now: input.now,
  });
}

export interface BudgetEnvelope {
  scope: string;
  limit_cents: number;
  reserved_cents: number;
  spent_cents: number;
  remaining_cents: number;
}

/** Enveloppe d'un scope ; sans ligne, plafond 0 (Free d'abord). */
export async function budgetEnvelope(db: D1Database, scope = GLOBAL_BUDGET_SCOPE): Promise<BudgetEnvelope> {
  await ensureSchema(db);
  const row = await db.prepare('SELECT limit_cents, reserved_cents, spent_cents FROM budget_envelopes WHERE scope = ?1')
    .bind(scope).first<{ limit_cents: number; reserved_cents: number; spent_cents: number }>();
  const limit = row?.limit_cents ?? 0;
  const reserved = row?.reserved_cents ?? 0;
  const spent = row?.spent_cents ?? 0;
  return { scope, limit_cents: limit, reserved_cents: reserved, spent_cents: spent, remaining_cents: Math.max(0, limit - reserved - spent) };
}

export function assertCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new CollabStoreError('INVALID_BUDGET_AMOUNT', field + ' : entier de centimes >= 0 attendu.');
}

/** Validation commune d'une réserve (identifiant, scope, montant). */
export function assertReservationInput(reservationId: string, scope: string, cents: number): void {
  if (!RESERVATION_RE.test(reservationId)) throw new CollabStoreError('INVALID_RESERVATION_ID', 'Identifiant de réservation invalide.');
  if (!SCOPE_RE.test(scope)) throw new CollabStoreError('INVALID_BUDGET_SCOPE', 'Scope budgétaire invalide.');
  assertCents(cents, 'cents');
}

/**
 * Instructions d'une réserve, à placer dans le lot de l'action qu'elle couvre
 * (CC-4 A2, revue #115 R4 : le lease d'invocation A1 les embarque). La garde
 * annule tout le lot si l'arrêt d'urgence est posé ou si le reste est insuffisant.
 */
export function reserveStatements(db: D1Database, input: {
  reservation_id: string; scope: string; cents: number; at: number;
}): D1PreparedStatement[] {
  return [
    db.prepare('INSERT INTO budget_envelopes (scope, updated_at) VALUES (?1, ?2) ON CONFLICT(scope) DO NOTHING').bind(input.scope, input.at),
    db.prepare([
      'INSERT INTO collab_store_guard (ok)',
      'SELECT CASE WHEN NOT ' + HALT_ACTIVE_SQL,
      '  AND (SELECT limit_cents - reserved_cents - spent_cents FROM budget_envelopes WHERE scope = ?1) >= ?2',
      '  THEN 1 ELSE 0 END',
    ].join(' ')).bind(input.scope, input.cents),
    db.prepare('UPDATE budget_envelopes SET reserved_cents = reserved_cents + ?2, updated_at = ?3 WHERE scope = ?1')
      .bind(input.scope, input.cents, input.at),
    db.prepare("INSERT INTO budget_reservations (reservation_id, scope, reserved_cents, status, created_at) VALUES (?1, ?2, ?3, 'reserved', ?4)")
      .bind(input.reservation_id, input.scope, input.cents, input.at),
    db.prepare('DELETE FROM collab_store_guard'),
  ];
}

/** Instructions du solde d'une réserve (garde : encore « reserved »), à placer dans le lot qui clôt l'action. */
export function settleStatements(db: D1Database, input: {
  reservation_id: string; scope: string; reserved_cents: number; actual_cents: number;
}): D1PreparedStatement[] {
  return [
    db.prepare([
      'INSERT INTO collab_store_guard (ok)',
      "SELECT CASE WHEN EXISTS (SELECT 1 FROM budget_reservations WHERE reservation_id = ?1 AND status = 'reserved') THEN 1 ELSE 0 END",
    ].join(' ')).bind(input.reservation_id),
    db.prepare("UPDATE budget_reservations SET status = 'settled', actual_cents = ?2 WHERE reservation_id = ?1")
      .bind(input.reservation_id, input.actual_cents),
    db.prepare('UPDATE budget_envelopes SET reserved_cents = reserved_cents - ?2, spent_cents = spent_cents + ?3 WHERE scope = ?1')
      .bind(input.scope, input.reserved_cents, input.actual_cents),
    db.prepare('DELETE FROM collab_store_guard'),
  ];
}

/** Réservation enregistrée (lecture). */
export async function budgetReservation(db: D1Database, reservationId: string): Promise<{
  scope: string; reserved_cents: number; actual_cents: number | null; status: string;
} | null> {
  return db.prepare('SELECT scope, reserved_cents, actual_cents, status FROM budget_reservations WHERE reservation_id = ?1')
    .bind(reservationId).first();
}

/** Diagnostic d'un refus de réserve : arrêt d'urgence d'abord, puis reste insuffisant. */
export async function assertReservable(db: D1Database, scope: string, cents: number): Promise<void> {
  await assertAutomationRunning(db);
  const envelope = await budgetEnvelope(db, scope);
  if (envelope.remaining_cents < cents) {
    throw new CollabStoreError('BUDGET_INSUFFICIENT', 'Enveloppe « ' + scope + ' » insuffisante : reste ' + envelope.remaining_cents
      + ' centimes, réserve demandée ' + cents + '. Aucune dépense sans enveloppe approuvée par le propriétaire.');
  }
}

/**
 * Réserve `cents` sur l'enveloppe AVANT une invocation. Fail-closed : arrêt
 * d'urgence posé ou reste insuffisant → refus typé, aucune écriture (garde
 * CAS dans le même lot). Idempotent par reservation_id.
 */
export async function reserveBudget(db: D1Database, input: {
  reservation_id: string; cents: number; scope?: string; now?: () => Date;
}): Promise<{ status: 'reserved' | 'duplicate'; envelope: BudgetEnvelope }> {
  const scope = input.scope ?? GLOBAL_BUDGET_SCOPE;
  assertReservationInput(input.reservation_id, scope, input.cents);
  await ensureSchema(db);
  const existing = await db.prepare('SELECT scope, reserved_cents FROM budget_reservations WHERE reservation_id = ?1')
    .bind(input.reservation_id).first<{ scope: string; reserved_cents: number }>();
  if (existing) {
    if (existing.scope !== scope || existing.reserved_cents !== input.cents) {
      throw new CollabStoreError('IDEMPOTENCY_CONFLICT', 'Réservation déjà enregistrée avec un autre montant ou scope.');
    }
    return { status: 'duplicate', envelope: await budgetEnvelope(db, scope) };
  }
  await assertAutomationRunning(db);
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  try {
    await db.batch(reserveStatements(db, { reservation_id: input.reservation_id, scope, cents: input.cents, at }));
  } catch (error) {
    // Revue #115 R2 : une livraison concurrente du même reservation_id a pu gagner
    // (PK) — on juge d'abord l'état durable, jamais un faux manque de budget.
    const winner = await db.prepare('SELECT scope, reserved_cents FROM budget_reservations WHERE reservation_id = ?1')
      .bind(input.reservation_id).first<{ scope: string; reserved_cents: number }>();
    if (winner) {
      if (winner.scope !== scope || winner.reserved_cents !== input.cents) {
        throw new CollabStoreError('IDEMPOTENCY_CONFLICT', 'Réservation déjà enregistrée avec un autre montant ou scope.');
      }
      return { status: 'duplicate', envelope: await budgetEnvelope(db, scope) };
    }
    await assertReservable(db, scope, input.cents);
    throw error;
  }
  return { status: 'reserved', envelope: await budgetEnvelope(db, scope) };
}

/** Solde une réservation : libère la réserve, compte le coût réel (≤ réserve). Idempotent. */
export async function settleBudget(db: D1Database, input: {
  reservation_id: string; actual_cents: number;
}): Promise<{ status: 'settled' | 'duplicate'; envelope: BudgetEnvelope }> {
  assertCents(input.actual_cents, 'actual_cents');
  await ensureSchema(db);
  const row = await db.prepare('SELECT scope, reserved_cents, actual_cents, status FROM budget_reservations WHERE reservation_id = ?1')
    .bind(input.reservation_id).first<{ scope: string; reserved_cents: number; actual_cents: number | null; status: string }>();
  if (!row) throw new CollabStoreError('UNKNOWN_RESERVATION', 'Réservation inconnue.');
  if (row.status === 'settled') {
    if (row.actual_cents !== input.actual_cents) throw new CollabStoreError('IDEMPOTENCY_CONFLICT', 'Réservation déjà soldée avec un autre montant.');
    return { status: 'duplicate', envelope: await budgetEnvelope(db, row.scope) };
  }
  if (input.actual_cents > row.reserved_cents) {
    throw new CollabStoreError('BUDGET_OVERRUN', 'Coût réel supérieur à la réserve : ' + input.actual_cents + ' > ' + row.reserved_cents + ' centimes.');
  }
  try {
    // Garde CAS : un solde concurrent de la même réservation annule tout le lot.
    await db.batch(settleStatements(db, { reservation_id: input.reservation_id, scope: row.scope,
      reserved_cents: row.reserved_cents, actual_cents: input.actual_cents }));
  } catch (error) {
    const after = await db.prepare('SELECT actual_cents, status FROM budget_reservations WHERE reservation_id = ?1')
      .bind(input.reservation_id).first<{ actual_cents: number | null; status: string }>();
    if (after?.status === 'settled' && after.actual_cents === input.actual_cents) {
      return { status: 'duplicate', envelope: await budgetEnvelope(db, row.scope) };
    }
    throw error;
  }
  return { status: 'settled', envelope: await budgetEnvelope(db, row.scope) };
}
