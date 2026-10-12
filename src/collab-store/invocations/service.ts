/**
 * CC-4 A1 — leases, retries, reconciliation and result/usage ledger.
 * No provider call exists here. A1 always records zero cost.
 */
import { StateContractError } from '../../collab/contracts';
import { sha256Hex } from '../store/hash';
import { ensureSchema } from '../store/schema';
import {
  normalizeInvocationUsage,
  type InvocationRecord,
  type InvocationUsage,
} from './contracts';
import { deliverableInvocations, INVOCATION_COLUMNS, invocationById, invocationByWakeKey } from './repository';
import {
  assertAutomationRunning, assertCents, assertReservable, assertReservationInput, budgetReservation,
  GLOBAL_BUDGET_SCOPE, HALT_ACTIVE_SQL, reserveStatements, settleStatements,
} from '../owner/automation';

const WORKER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_FAILURES = 2;

export type LeaseOutcome =
  | { status: 'leased'; invocation: InvocationRecord }
  | { status: 'busy' | 'terminal'; invocation: InvocationRecord };

/**
 * CC-4 A2 (revue #115 R4) : budget d'une tentative. Le coût maximal est réservé
 * DANS le lot du lease (0 € par défaut : chemin gratuit/simulé) ; le solde est
 * écrit dans le lot qui clôt la tentative. Un adaptateur payant (A3) fournit
 * son pire cas ici avant toute exécution.
 */
export interface LeaseBudget {
  max_cost_cents?: number;
  scope?: string;
}

/** Une réservation par tentative : idempotence liée à l'invocation et au numéro de tentative. */
export function invocationReservationId(invocationId: string, attemptNo: number): string {
  return 'inv:' + invocationId + ':' + attemptNo;
}

/** 1 centime = 10 000 micro-unités (cost_microunits, A1). */
const MICROUNITS_PER_CENT = 10_000;

export interface InvocationServiceOptions {
  now?: () => Date;
}

function operationalError(code: string, message: string): StateContractError {
  return new StateContractError(code, message, 'invocation');
}

function validateWorker(workerId: string): void {
  if (!WORKER_RE.test(workerId ?? '')) {
    throw operationalError('INVALID_INVOCATION', 'worker_id is invalid');
  }
}

function validateLeaseSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3600) {
    throw operationalError('INVALID_INVOCATION', 'lease_seconds must be an integer between 1 and 3600');
  }
}

function evidenceJson(refs: string[] = []): string {
  if (!Array.isArray(refs) || refs.length > 20
      || !refs.every(ref => typeof ref === 'string' && ref.length > 0 && ref.length <= 1024)) {
    throw operationalError('INVALID_INVOCATION', 'evidence refs are invalid');
  }
  return JSON.stringify(refs);
}

export class InvocationService {
  private readonly now: () => Date;

  constructor(private readonly db: D1Database, options: InvocationServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private seconds(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  async getByWakeKey(wakeKey: string): Promise<InvocationRecord | null> {
    await ensureSchema(this.db);
    return invocationByWakeKey(this.db, wakeKey);
  }

  async getById(invocationId: string): Promise<InvocationRecord | null> {
    await ensureSchema(this.db);
    return invocationById(this.db, invocationId);
  }

  async listDeliverable(limit = 100): Promise<InvocationRecord[]> {
    await ensureSchema(this.db);
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return deliverableInvocations(this.db, bounded);
  }

  async lease(wakeKey: string, workerId: string, leaseSeconds = 300, budget: LeaseBudget = {}): Promise<LeaseOutcome> {
    await ensureSchema(this.db);
    validateWorker(workerId);
    validateLeaseSeconds(leaseSeconds);
    const cents = budget.max_cost_cents ?? 0;
    const scope = budget.scope ?? GLOBAL_BUDGET_SCOPE;
    const now = this.seconds();
    let current = await this.requireWake(wakeKey);
    if ((current.state === 'leased' || current.state === 'running')
        && current.lease_expires_at !== null && current.lease_expires_at <= now) {
      await this.expireOne(current, now);
      current = await this.requireWake(wakeKey);
    }
    if (current.state === 'succeeded' || current.state === 'failed') return { status: 'terminal', invocation: current };
    if (current.state === 'leased' || current.state === 'running') return { status: 'busy', invocation: current };
    if (current.state !== 'queued' && current.state !== 'expired') {
      throw operationalError('INVOCATION_INCONSISTENT', 'invocation state is not leaseable: ' + current.state);
    }
    // CC-4 A2 (revue #115 R3) : arrêt d'urgence — aucune nouvelle tentative ne démarre.
    // Pré-check lisible ; la garde du lot ci-dessous le revérifie dans la transaction.
    await assertAutomationRunning(this.db);
    const reservationId = invocationReservationId(current.invocation_id, current.attempt_count + 1);
    assertReservationInput(reservationId, scope, cents);
    const expires = now + leaseSeconds;
    try {
      await this.db.batch([
        this.db.prepare([
          'INSERT INTO invocation_guard (ok)',
          "SELECT CASE WHEN EXISTS (SELECT 1 FROM invocations WHERE wake_key = ?1 AND state IN ('queued','expired'))",
          ' AND NOT ' + HALT_ACTIVE_SQL + ' THEN 1 ELSE 0 END',
        ].join(' ')).bind(wakeKey),
        this.db.prepare([
          "UPDATE invocations SET state = 'leased', attempt_count = attempt_count + 1, lease_owner = ?2,",
          ' lease_expires_at = ?3, leased_at = ?4, running_at = NULL, finished_at = NULL, last_error = \'\'',
          " WHERE wake_key = ?1 AND state IN ('queued','expired')",
        ].join(' ')).bind(wakeKey, workerId, expires, now),
        this.db.prepare([
          'INSERT INTO invocation_attempts (invocation_id, attempt_no, endpoint_id, state, leased_at, running_at, finished_at,',
          ' input_hash, output_hash, error, usage_input_tokens, usage_output_tokens, usage_operations, cost_microunits, evidence_refs)',
          "SELECT invocation_id, attempt_count, endpoint_id, 'leased', ?2, NULL, NULL, input_hash, '', '', 0, 0, 0, 0, '[]'",
          ' FROM invocations WHERE wake_key = ?1',
        ].join(' ')).bind(wakeKey, now),
        this.db.prepare('DELETE FROM invocation_guard'),
        // CC-4 A2 (revue #115 R4) : réserve du pire cas dans le MÊME lot que le lease.
        ...reserveStatements(this.db, { reservation_id: reservationId, scope, cents, at: now }),
      ]);
    } catch (error) {
      const winner = await this.requireWake(wakeKey);
      if (winner.state === 'succeeded' || winner.state === 'failed') return { status: 'terminal', invocation: winner };
      if (winner.state === 'leased' || winner.state === 'running') return { status: 'busy', invocation: winner };
      // Ni gagnant ni rejeu : arrêt d'urgence (AUTOMATION_HALTED) puis budget (BUDGET_INSUFFICIENT).
      await assertReservable(this.db, scope, cents);
      throw error;
    }
    return { status: 'leased', invocation: await this.requireWake(wakeKey) };
  }

  async markRunning(wakeKey: string, workerId: string): Promise<InvocationRecord> {
    await ensureSchema(this.db);
    validateWorker(workerId);
    const now = this.seconds();
    try {
      await this.db.batch([
        this.db.prepare([
          'INSERT INTO invocation_guard (ok)',
          "SELECT CASE WHEN EXISTS (SELECT 1 FROM invocations WHERE wake_key = ?1 AND state = 'leased'",
          ' AND lease_owner = ?2 AND lease_expires_at > ?3) AND NOT ' + HALT_ACTIVE_SQL + ' THEN 1 ELSE 0 END',
        ].join(' ')).bind(wakeKey, workerId, now),
        this.db.prepare("UPDATE invocations SET state = 'running', running_at = ?3 WHERE wake_key = ?1 AND lease_owner = ?2")
          .bind(wakeKey, workerId, now),
        this.db.prepare([
          "UPDATE invocation_attempts SET state = 'running', running_at = ?3",
          ' WHERE invocation_id = (SELECT invocation_id FROM invocations WHERE wake_key = ?1)',
          ' AND attempt_no = (SELECT attempt_count FROM invocations WHERE wake_key = ?1)',
        ].join(' ')).bind(wakeKey, workerId, now),
        this.db.prepare('DELETE FROM invocation_guard'),
      ]);
    } catch (error) {
      const current = await this.requireWake(wakeKey);
      if (current.state !== 'leased' || current.lease_owner !== workerId || (current.lease_expires_at ?? 0) <= now) {
        throw operationalError('INVOCATION_LEASE_LOST', 'lease is no longer valid before running');
      }
      // CC-4 A2 : arrêt posé après le lease — l'exécution ne démarre pas (le bail expirera sans coût).
      await assertAutomationRunning(this.db);
      throw error;
    }
    return this.requireWake(wakeKey);
  }

  async succeed(
    wakeKey: string,
    workerId: string,
    output: string,
    usage: Partial<InvocationUsage> = {},
    evidenceRefs: string[] = [],
    costCents = 0,
  ): Promise<InvocationRecord> {
    const outputHash = await sha256Hex(typeof output === 'string' ? output : String(output));
    return this.settle(wakeKey, workerId, {
      success: true,
      outputHash,
      error: '',
      usage: normalizeInvocationUsage(usage),
      evidenceRefs,
      costCents,
    });
  }

  async fail(
    wakeKey: string,
    workerId: string,
    errorMessage: string,
    usage: Partial<InvocationUsage> = {},
    evidenceRefs: string[] = [],
    costCents = 0,
  ): Promise<InvocationRecord> {
    const message = typeof errorMessage === 'string' ? errorMessage.slice(0, 1000) : String(errorMessage).slice(0, 1000);
    if (!message) throw operationalError('INVALID_INVOCATION', 'failure reason is required');
    return this.settle(wakeKey, workerId, {
      success: false,
      outputHash: '',
      error: message,
      usage: normalizeInvocationUsage(usage),
      evidenceRefs,
      costCents,
    });
  }

  async reconcileExpired(limit = 100): Promise<number> {
    await ensureSchema(this.db);
    const now = this.seconds();
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const { results } = await this.db.prepare(
      "SELECT " + INVOCATION_COLUMNS + " FROM invocations WHERE state IN ('leased','running') AND lease_expires_at <= ?1 ORDER BY lease_expires_at LIMIT ?2"
    ).bind(now, bounded).all<InvocationRecord>();
    let changed = 0;
    for (const record of results) if (await this.expireOne(record, now)) changed += 1;
    return changed;
  }

  private async settle(
    wakeKey: string,
    workerId: string,
    result: {
      success: boolean;
      outputHash: string;
      error: string;
      usage: InvocationUsage;
      evidenceRefs: string[];
      costCents: number;
    },
  ): Promise<InvocationRecord> {
    await ensureSchema(this.db);
    validateWorker(workerId);
    const now = this.seconds();
    const current = await this.requireWake(wakeKey);
    if (current.state !== 'running' || current.lease_owner !== workerId || (current.lease_expires_at ?? 0) <= now) {
      throw operationalError('INVOCATION_LEASE_LOST', 'lease is no longer valid while settling the invocation');
    }
    const failures = result.success ? 0 : current.consecutive_failures + 1;
    const nextState = result.success ? 'succeeded' : failures >= MAX_FAILURES ? 'failed' : 'queued';
    const evidence = evidenceJson(result.evidenceRefs);
    // CC-4 A2 (revue #115 R4) : solde de la réserve de cette tentative, dans le même lot.
    assertCents(result.costCents, 'cost_cents');
    const reservationId = invocationReservationId(current.invocation_id, current.attempt_count);
    const reservation = await budgetReservation(this.db, reservationId);
    if (result.costCents > (reservation?.reserved_cents ?? 0)) {
      throw operationalError('BUDGET_OVERRUN', 'cost exceeds the reservation of this attempt: ' + result.costCents + ' > '
        + (reservation?.reserved_cents ?? 0) + ' cents');
    }
    const costMicro = result.costCents * MICROUNITS_PER_CENT;
    const settleBudget = reservation && reservation.status === 'reserved'
      ? settleStatements(this.db, { reservation_id: reservationId, scope: reservation.scope,
        reserved_cents: reservation.reserved_cents, actual_cents: result.costCents })
      : [];
    try {
      await this.db.batch([
        this.db.prepare([
          'INSERT INTO invocation_guard (ok)',
          "SELECT CASE WHEN EXISTS (SELECT 1 FROM invocations WHERE wake_key = ?1 AND state = 'running'",
          ' AND lease_owner = ?2 AND lease_expires_at > ?3) THEN 1 ELSE 0 END',
        ].join(' ')).bind(wakeKey, workerId, now),
        this.db.prepare([
          'UPDATE invocations SET state = ?4, consecutive_failures = ?5, output_hash = ?6, last_error = ?7,',
          ' finished_at = ?8, lease_owner = \'\', lease_expires_at = NULL,',
          ' usage_input_tokens = usage_input_tokens + ?9, usage_output_tokens = usage_output_tokens + ?10,',
          ' usage_operations = usage_operations + ?11, cost_microunits = cost_microunits + ?13, evidence_refs = ?12',
          ' WHERE wake_key = ?1 AND lease_owner = ?2',
        ].join(' ')).bind(
          wakeKey, workerId, now, nextState, failures, result.outputHash, result.error,
          nextState === 'queued' ? null : now,
          result.usage.input_tokens, result.usage.output_tokens, result.usage.operations, evidence, costMicro,
        ),
        this.db.prepare([
          'UPDATE invocation_attempts SET state = ?4, finished_at = ?3, output_hash = ?5, error = ?6,',
          ' usage_input_tokens = ?7, usage_output_tokens = ?8, usage_operations = ?9, cost_microunits = ?11, evidence_refs = ?10',
          ' WHERE invocation_id = (SELECT invocation_id FROM invocations WHERE wake_key = ?1)',
          ' AND attempt_no = (SELECT attempt_count FROM invocations WHERE wake_key = ?1)',
        ].join(' ')).bind(
          wakeKey, workerId, now, result.success ? 'succeeded' : 'failed', result.outputHash, result.error,
          result.usage.input_tokens, result.usage.output_tokens, result.usage.operations, evidence, costMicro,
        ),
        this.db.prepare('DELETE FROM invocation_guard'),
        ...settleBudget,
      ]);
    } catch (error) {
      const after = await this.requireWake(wakeKey);
      if (after.state !== 'running' || after.lease_owner !== workerId) {
        throw operationalError('INVOCATION_LEASE_LOST', 'invocation changed while settling');
      }
      throw error;
    }
    return this.requireWake(wakeKey);
  }

  private async expireOne(record: InvocationRecord, now: number): Promise<boolean> {
    if ((record.state !== 'leased' && record.state !== 'running')
        || record.lease_expires_at === null || record.lease_expires_at > now) return false;
    const failures = record.consecutive_failures + 1;
    const nextState = failures >= MAX_FAILURES ? 'failed' : 'expired';
    // CC-4 A2 (revue #115 R4) : solde de la réserve. Une tentative « running » a pu
    // consommer : on compte le pire cas réservé ; « leased » n'a rien exécuté : 0.
    const reservationId = invocationReservationId(record.invocation_id, record.attempt_count);
    const reservation = await budgetReservation(this.db, reservationId);
    const countedCents = reservation && reservation.status === 'reserved' && record.state === 'running'
      ? reservation.reserved_cents : 0;
    // Revue #115 R5 : le coût compté au budget est aussi porté au ledger A1 (invocation + tentative), même lot.
    const countedMicro = countedCents * MICROUNITS_PER_CENT;
    const settleBudget = reservation && reservation.status === 'reserved'
      ? settleStatements(this.db, { reservation_id: reservationId, scope: reservation.scope,
        reserved_cents: reservation.reserved_cents, actual_cents: countedCents })
      : [];
    try {
      await this.db.batch([
        this.db.prepare([
          'INSERT INTO invocation_guard (ok)',
          'SELECT CASE WHEN EXISTS (SELECT 1 FROM invocations WHERE invocation_id = ?1 AND state = ?2',
          ' AND lease_owner = ?3 AND lease_expires_at = ?4 AND lease_expires_at <= ?5) THEN 1 ELSE 0 END',
        ].join(' ')).bind(record.invocation_id, record.state, record.lease_owner, record.lease_expires_at, now),
        this.db.prepare([
          'UPDATE invocations SET state = ?2, consecutive_failures = ?3, last_error = \'lease_expired\',',
          ' lease_owner = \'\', lease_expires_at = NULL, finished_at = ?4, cost_microunits = cost_microunits + ?5',
          ' WHERE invocation_id = ?1',
        ].join(' ')).bind(record.invocation_id, nextState, failures, nextState === 'failed' ? now : null, countedMicro),
        this.db.prepare([
          "UPDATE invocation_attempts SET state = 'expired', finished_at = ?2, error = 'lease_expired', cost_microunits = ?4",
          ' WHERE invocation_id = ?1 AND attempt_no = ?3',
        ].join(' ')).bind(record.invocation_id, now, record.attempt_count, countedMicro),
        this.db.prepare('DELETE FROM invocation_guard'),
        ...settleBudget,
      ]);
      return true;
    } catch (error) {
      const after = await invocationById(this.db, record.invocation_id);
      if (after && (after.state !== record.state || after.lease_owner !== record.lease_owner
          || after.lease_expires_at !== record.lease_expires_at)) return false;
      throw error;
    }
  }

  private async requireWake(wakeKey: string): Promise<InvocationRecord> {
    const row = await invocationByWakeKey(this.db, wakeKey);
    if (!row) throw operationalError('INVOCATION_UNKNOWN', 'unknown invocation wake_key');
    return row;
  }
}
