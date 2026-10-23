/**
 * CC-5 l7 (incrément 7b) — orchestration des exécutions d'agents : réveil, alarmes,
 * outbox, scan de secours et quotas Free. Plan v1.1, store seq 478.
 *
 * Les fonctions de ce module sont pures vis-à-vis de l'orchestrateur : elles
 * reçoivent le stockage de l'objet (`ObjectSlot`) et la base D1, si bien que la
 * classe Durable Object (`object.ts`) n'est qu'une coquille. D1 reste la source
 * de vérité : chaque alarme relit l'exécution avant d'appeler `runStep` et ne
 * croit jamais le run_id mémorisé sur parole.
 *
 * Inactif par défaut : tout est refusé sans écriture tant que
 * AGENT_RUNS_ENABLED n'est pas exactement « true » (en plus de HALT, vérifié par
 * le moteur à chaque écriture).
 */
import { runStep, type EngineDeps, type ModelClient, type ToolHost } from './engine';
import { meteredDb } from './metered-db';
import { ensureAgentRunSchema } from './schema';

/** Recul d'une alarme après `busy` : 5 s, 10 s, 20 s… plafonné à 300 s. */
export const BUSY_BACKOFF_BASE_S = 5;
export const BUSY_BACKOFF_MAX_S = 300;
export const RETRY_DELAY_S = 30;
export const ERROR_DELAY_S = 60;
/** Quota du jour épuisé : nouvel essai dans une heure (jamais d'étape hors quota). */
export const QUOTA_RETRY_S = 3600;
/** Une alarme annoncée et dépassée de plus que cela est considérée perdue (scan de secours). */
export const ALARM_GRACE_S = 120;
export const WAKEUP_CLAIM_S = 60;
export const MAX_WAKEUP_ATTEMPTS = 3;
export const PASS_LIMIT = 10;
/** Quotas Durable Objects Free (100 000/jour) : plafonds par défaut avec marge, réglables à la baisse. */
export const DEFAULT_DAILY_REQUESTS = 20_000;
export const DEFAULT_DAILY_ROWS = 20_000;
export const FREE_DAILY_CEILING = 100_000;
/**
 * Réservation de lignes écrites AVANT une étape (pire cas : réclamation, décision,
 * jusqu'à MAX_TOOL_CALLS_PER_STEP effets en trois transitions, checkpoint, arrêt,
 * index compris). 7c-1 : après l'étape, la réservation est ramenée au réel mesuré
 * (meta.rows_written des requêtes D1 du moteur, metered-db.ts) plus l'estimation
 * fixe des écritures du stockage du Durable Object (DO_ROWS_PER_ALARM).
 */
export const ROWS_PER_STEP = 64;
/** Écritures du stockage SQLite de l'objet par alarme (copie locale « busy », alarme), estimation fixe. */
export const DO_ROWS_PER_ALARM = 3;
/**
 * Troisième quota Durable Objects Free : durée facturée en Go-s (objet de 128 Mo).
 * Réservation avant l'étape au pire cas d'une étape longue (125 s, modèle et outils
 * bornés), puis ramenée à la durée mesurée de l'alarme, arrondie au Go-s supérieur.
 */
export const GB_S_PER_STEP = 16;
export const DO_MEMORY_GB = 0.128;
export const DEFAULT_DAILY_GB_S = 10_000;
export const FREE_DAILY_GB_S = 13_000;

export interface AgentRunEnv {
  AGENT_RUNS_ENABLED?: string;
  AGENT_RUN_DAILY_REQUESTS?: string;
  AGENT_RUN_DAILY_ROWS?: string;
  AGENT_RUN_DAILY_GB_S?: string;
}

export type QuotaKind = 'do_requests' | 'rows_written' | 'do_gb_s';

export function agentRunsEnabled(env: AgentRunEnv): boolean {
  return env.AGENT_RUNS_ENABLED === 'true';
}

function dailyLimit(raw: string | undefined, fallback: number, ceiling = FREE_DAILY_CEILING): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, ceiling);
}

export function utcDay(now: number): string {
  return new Date(now * 1000).toISOString().slice(0, 10);
}

/** Réserve `amount` unités d'un quota du jour, atomiquement, sans jamais dépasser le plafond. */
export async function consumeQuota(db: D1Database, kind: QuotaKind, amount: number, limit: number, now: number): Promise<boolean> {
  const result = await db.prepare([
    'INSERT INTO agent_run_quota (day, kind, used) SELECT ?1, ?2, ?3 WHERE ?3 <= ?4',
    'ON CONFLICT(day, kind) DO UPDATE SET used = agent_run_quota.used + excluded.used',
    '  WHERE agent_run_quota.used + excluded.used <= ?4',
  ].join(' ')).bind(utcDay(now), kind, amount, limit).run();
  return result.meta.changes === 1;
}

/**
 * 7c-1 : ramène une réservation au réel mesuré, sur le jour de la réservation.
 * Le réel peut dépasser la réservation (l'étape a déjà eu lieu) : le compteur le
 * reflète et bloque les étapes suivantes ; il ne descend jamais sous zéro.
 */
export async function settleQuota(db: D1Database, kind: QuotaKind, day: string, reserved: number, actual: number): Promise<void> {
  const delta = Math.max(0, Math.ceil(actual)) - reserved;
  if (delta === 0) return;
  await db.prepare('UPDATE agent_run_quota SET used = MAX(0, used + ?3) WHERE day = ?1 AND kind = ?2').bind(day, kind, delta).run();
}

async function journal(db: D1Database, now: number, kind: string, runId: string, detail: string): Promise<void> {
  await db.prepare('INSERT INTO agent_run_journal (at, kind, run_id, detail) VALUES (?1, ?2, ?3, ?4)')
    .bind(now, kind, runId, detail.slice(0, 500)).run();
}

// ---------------------------------------------------------------- objet (stockage local + alarme)

/** Ce que l'orchestrateur garde localement : une copie de travail, jamais une autorité. */
export interface ObjectSlot {
  get(key: 'run_id'): Promise<string | undefined>;
  get(key: 'busy'): Promise<number | undefined>;
  put(key: 'run_id', value: string): Promise<void>;
  put(key: 'busy', value: number): Promise<void>;
  delete(key: 'run_id' | 'busy'): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface OrchestratorDeps {
  db: D1Database;
  env: AgentRunEnv;
  slot: ObjectSlot;
  /** L'objet est bien celui de cette clé de bail (idFromName(lease_key)). */
  ownsLease: (leaseKey: string) => boolean;
  nowMs: () => number;
  /** Dépendances du moteur pour une exécution ; `db` = base mesurée de l'étape (7c-1), à utiliser pour toute écriture. */
  engine: (runId: string, db?: D1Database) => Omit<EngineDeps, 'workerId'>;
  workerId: () => string;
}

export type WakeResult = { accepted: true; reason?: 'terminal' } | { accepted: false; reason: string };

/** Pose l'alarme à `atMs` sauf si une alarme plus proche existe (jamais reculée) ; annonce l'échéance dans D1. */
async function scheduleAt(deps: OrchestratorDeps, runId: string, leaseKey: string, atMs: number): Promise<void> {
  const existing = await deps.slot.getAlarm();
  const target = existing !== null && existing <= atMs ? existing : atMs;
  if (existing === null || existing > atMs) await deps.slot.setAlarm(atMs);
  await deps.db.prepare([
    'INSERT INTO agent_run_alarms (run_id, lease_key, next_alarm_at, updated_at) VALUES (?1, ?2, ?3, ?4)',
    'ON CONFLICT(run_id) DO UPDATE SET next_alarm_at = excluded.next_alarm_at, updated_at = excluded.updated_at',
  ].join(' ')).bind(runId, leaseKey, Math.ceil(target / 1000), Math.floor(deps.nowMs() / 1000)).run();
}

async function forget(deps: OrchestratorDeps, runId: string, leaseKey: string): Promise<void> {
  await deps.slot.delete('run_id');
  await deps.slot.delete('busy');
  await deps.db.prepare([
    'INSERT INTO agent_run_alarms (run_id, lease_key, next_alarm_at, updated_at) VALUES (?1, ?2, NULL, ?3)',
    'ON CONFLICT(run_id) DO UPDATE SET next_alarm_at = NULL, updated_at = excluded.updated_at',
  ].join(' ')).bind(runId, leaseKey, Math.floor(deps.nowMs() / 1000)).run();
}

/** Réveil d'une exécution : idempotent (double wake = une seule alarme), refusé sans écriture si désactivé. */
export async function objectWake(deps: OrchestratorDeps, runId: string, leaseKey: string): Promise<WakeResult> {
  if (!agentRunsEnabled(deps.env)) return { accepted: false, reason: 'disabled' };
  if (!deps.ownsLease(leaseKey)) return { accepted: false, reason: 'wrong_object' };
  await ensureAgentRunSchema(deps.db);
  const now = Math.floor(deps.nowMs() / 1000);
  const run = await deps.db.prepare('SELECT status, lease_key FROM agent_runs WHERE run_id = ?1').bind(runId)
    .first<{ status: string; lease_key: string }>();
  if (!run || run.lease_key !== leaseKey) return { accepted: false, reason: 'unknown_run' };
  if (run.status !== 'running') return { accepted: true, reason: 'terminal' };
  if (!await consumeQuota(deps.db, 'do_requests', 1, dailyLimit(deps.env.AGENT_RUN_DAILY_REQUESTS, DEFAULT_DAILY_REQUESTS), now)) {
    await journal(deps.db, now, 'quota_exhausted', runId, 'do_requests (wake)');
    return { accepted: false, reason: 'quota_exhausted' };
  }
  const current = await deps.slot.get('run_id');
  if (current !== runId) {
    await deps.slot.put('run_id', runId);
    await deps.slot.put('busy', 0);
  }
  await scheduleAt(deps, runId, leaseKey, deps.nowMs());
  return { accepted: true };
}

export type AlarmResult = { action: 'none' | 'stepped' | 'rescheduled' | 'finished' | 'quota_wait' | 'error'; outcome?: string; next_at?: number };

/**
 * Une alarme = au plus une étape. L'exécution est relue dans D1 ; après toute
 * issue non terminale une alarme future existe ; une issue terminale libère l'objet.
 */
export async function objectAlarm(deps: OrchestratorDeps): Promise<AlarmResult> {
  if (!agentRunsEnabled(deps.env)) return { action: 'none' };
  const runId = await deps.slot.get('run_id');
  if (!runId) return { action: 'none' };
  await ensureAgentRunSchema(deps.db);
  const nowMs = deps.nowMs();
  const now = Math.floor(nowMs / 1000);
  const run = await deps.db.prepare('SELECT status, lease_key FROM agent_runs WHERE run_id = ?1').bind(runId)
    .first<{ status: string; lease_key: string }>();
  if (!run || !deps.ownsLease(run.lease_key)) {
    // Copie locale périmée (éviction, réattribution) : on oublie, D1 et le scan de secours font foi.
    await deps.slot.delete('run_id');
    await deps.slot.delete('busy');
    return { action: 'none' };
  }
  if (run.status !== 'running') {
    await forget(deps, runId, run.lease_key);
    return { action: 'finished', outcome: run.status };
  }
  const requestsOk = await consumeQuota(deps.db, 'do_requests', 1, dailyLimit(deps.env.AGENT_RUN_DAILY_REQUESTS, DEFAULT_DAILY_REQUESTS), now);
  const rowsOk = requestsOk && await consumeQuota(deps.db, 'rows_written', ROWS_PER_STEP, dailyLimit(deps.env.AGENT_RUN_DAILY_ROWS, DEFAULT_DAILY_ROWS), now);
  const gbOk = rowsOk && await consumeQuota(deps.db, 'do_gb_s', GB_S_PER_STEP,
    dailyLimit(deps.env.AGENT_RUN_DAILY_GB_S, DEFAULT_DAILY_GB_S, FREE_DAILY_GB_S), now);
  if (!gbOk) {
    // Une réservation de lignes déjà faite est rendue : l'étape n'a pas lieu.
    if (rowsOk) await settleQuota(deps.db, 'rows_written', utcDay(now), ROWS_PER_STEP, 0);
    await journal(deps.db, now, 'quota_exhausted', runId, !requestsOk ? 'do_requests' : !rowsOk ? 'rows_written' : 'do_gb_s');
    const next = nowMs + QUOTA_RETRY_S * 1000;
    await scheduleAt(deps, runId, run.lease_key, next);
    return { action: 'quota_wait', next_at: next };
  }
  // 7c-1 : lignes D1 mesurées pendant l'étape, durée mesurée pour le quota Go-s.
  const metered = meteredDb(deps.db);
  const startedMs = deps.nowMs();
  const settleStep = async () => {
    const day = utcDay(now);
    await settleQuota(deps.db, 'rows_written', day, ROWS_PER_STEP, metered.rowsWritten() + DO_ROWS_PER_ALARM);
    await settleQuota(deps.db, 'do_gb_s', day, GB_S_PER_STEP, Math.max(0, deps.nowMs() - startedMs) / 1000 * DO_MEMORY_GB);
  };
  let outcome: string;
  try {
    outcome = (await runStep(metered.db, runId, { ...deps.engine(runId, metered.db), workerId: deps.workerId() })).outcome;
  } catch (error) {
    // Panne (D1, fournisseur) : jamais d'alarme perdue, nouvel essai borné par le moteur (MAX_STEP_ATTEMPTS).
    await settleStep();
    await journal(deps.db, now, 'step_error', runId, error instanceof Error ? error.message : String(error));
    const next = nowMs + ERROR_DELAY_S * 1000;
    await scheduleAt(deps, runId, run.lease_key, next);
    return { action: 'error', next_at: next };
  }
  await settleStep();
  if (outcome === 'stepped') {
    await deps.slot.put('busy', 0);
    await scheduleAt(deps, runId, run.lease_key, deps.nowMs());
    return { action: 'stepped', outcome };
  }
  if (outcome === 'busy' || outcome === 'retry') {
    const busy = (await deps.slot.get('busy')) ?? 0;
    await deps.slot.put('busy', busy + 1);
    const delay = outcome === 'retry' ? RETRY_DELAY_S : Math.min(BUSY_BACKOFF_MAX_S, BUSY_BACKOFF_BASE_S * 2 ** Math.min(busy, 16));
    const next = deps.nowMs() + delay * 1000;
    await scheduleAt(deps, runId, run.lease_key, next);
    return { action: 'rescheduled', outcome, next_at: next };
  }
  await forget(deps, runId, run.lease_key);
  await journal(deps.db, now, 'run_finished', runId, outcome);
  return { action: 'finished', outcome };
}

// ---------------------------------------------------------------- passage (outbox + secours)

export type WakeFn = (leaseKey: string, runId: string) => Promise<WakeResult>;

export interface PassResult { delivered: number; failed: number; rescued: number; skipped?: 'disabled' }

/**
 * Livre l'outbox de réveil : réclamation par CAS avec expiration (un livreur à la
 * fois par réveil), ACK seulement après un wake accepté, tentatives bornées puis
 * état terminal journalisé. Un livreur coupé après la réclamation : la réclamation
 * expire et un passage suivant relivre (wake est idempotent).
 */
export async function deliverWakeups(db: D1Database, input: { now: number; deliverer: string; wake: WakeFn; limit?: number }): Promise<{ delivered: number; failed: number }> {
  await ensureAgentRunSchema(db);
  const { results } = await db.prepare([
    "SELECT run_id, lease_key FROM agent_run_wakeups WHERE status = 'pending' AND claimed_until <= ?1",
    'ORDER BY requested_at, run_id LIMIT ?2',
  ].join(' ')).bind(input.now, Math.max(1, Math.min(input.limit ?? PASS_LIMIT, 50))).all<{ run_id: string; lease_key: string }>();
  let delivered = 0;
  let failed = 0;
  for (const row of results) {
    const claim = await db.prepare([
      'UPDATE agent_run_wakeups SET claimed_by = ?2, claimed_until = ?3, attempts = attempts + 1',
      "WHERE run_id = ?1 AND status = 'pending' AND claimed_until <= ?4 AND attempts < ?5",
    ].join(' ')).bind(row.run_id, input.deliverer, input.now + WAKEUP_CLAIM_S, input.now, MAX_WAKEUP_ATTEMPTS).run();
    if (claim.meta.changes !== 1) {
      const exhausted = await db.prepare([
        "UPDATE agent_run_wakeups SET status = 'failed', last_error = 'delivery_attempts_exhausted'",
        "WHERE run_id = ?1 AND status = 'pending' AND claimed_until <= ?2 AND attempts >= ?3",
      ].join(' ')).bind(row.run_id, input.now, MAX_WAKEUP_ATTEMPTS).run();
      if (exhausted.meta.changes === 1) {
        failed += 1;
        await journal(db, input.now, 'wakeup_failed', row.run_id, 'delivery_attempts_exhausted');
      }
      continue;
    }
    let result: WakeResult;
    try {
      result = await input.wake(row.lease_key, row.run_id);
    } catch (error) {
      result = { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (result.accepted) {
      const ack = await db.prepare([
        "UPDATE agent_run_wakeups SET status = 'delivered', delivered_at = ?3",
        "WHERE run_id = ?1 AND claimed_by = ?2 AND status = 'pending'",
      ].join(' ')).bind(row.run_id, input.deliverer, input.now).run();
      if (ack.meta.changes === 1) delivered += 1;
    } else {
      // Réclamation rendue tout de suite : le passage suivant réessaie, dans la limite des tentatives.
      await db.prepare([
        'UPDATE agent_run_wakeups SET claimed_until = ?3, last_error = ?4',
        "WHERE run_id = ?1 AND claimed_by = ?2 AND status = 'pending'",
      ].join(' ')).bind(row.run_id, input.deliverer, input.now, ('reason' in result ? result.reason : '').slice(0, 200)).run();
      await journal(db, input.now, 'wakeup_rejected', row.run_id, 'reason' in result ? result.reason : '');
    }
  }
  return { delivered, failed };
}

/**
 * Scan de secours : exécution `running` dont aucune alarme vivante n'est annoncée
 * (jamais annoncée, ou échéance dépassée de plus de ALARM_GRACE_S). Ne se fie pas à
 * updated_at, rafraîchi par les écritures d'audit du moteur. Borné et journalisé.
 */
export async function rescueStalledRuns(db: D1Database, input: { now: number; wake: WakeFn; limit?: number }): Promise<number> {
  await ensureAgentRunSchema(db);
  const { results } = await db.prepare([
    'SELECT r.run_id, r.lease_key FROM agent_runs r LEFT JOIN agent_run_alarms a ON a.run_id = r.run_id',
    "LEFT JOIN agent_run_wakeups w ON w.run_id = r.run_id",
    "WHERE r.status = 'running' AND (w.run_id IS NULL OR w.status <> 'pending')",
    '  AND (a.run_id IS NULL OR a.next_alarm_at IS NULL OR a.next_alarm_at + ?2 < ?1)',
    'ORDER BY r.updated_at, r.run_id LIMIT ?3',
  ].join(' ')).bind(input.now, ALARM_GRACE_S, Math.max(1, Math.min(input.limit ?? PASS_LIMIT, 50))).all<{ run_id: string; lease_key: string }>();
  let rescued = 0;
  for (const row of results) {
    let result: WakeResult;
    try {
      result = await input.wake(row.lease_key, row.run_id);
    } catch (error) {
      result = { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
    await journal(db, input.now, result.accepted ? 'rescued' : 'rescue_rejected', row.run_id, 'reason' in result ? result.reason ?? '' : '');
    if (result.accepted) rescued += 1;
  }
  return rescued;
}

/** Passage complet appelé par le webhook ou le Cron : no-op sans écriture si désactivé. */
export async function agentRunPass(db: D1Database | undefined, env: AgentRunEnv, input: { now: number; deliverer: string; wake: WakeFn | null }): Promise<PassResult> {
  if (!agentRunsEnabled(env) || !db || !input.wake) return { delivered: 0, failed: 0, rescued: 0, skipped: 'disabled' };
  const { delivered, failed } = await deliverWakeups(db, { now: input.now, deliverer: input.deliverer, wake: input.wake });
  const rescued = await rescueStalledRuns(db, { now: input.now, wake: input.wake });
  return { delivered, failed, rescued };
}

// ---------------------------------------------------------------- dépendances par défaut (7b)

/**
 * 7b n'a ni fournisseur réel ni outil (B3) : le modèle simulé termine l'exécution
 * en une étape sans aucun effet. Les vrais modèles et outils arrivent en 7c, avec
 * le contrat d'hôte (lookup obligatoire et idempotence pour tout outil d'écriture).
 */
export const SIMULATED_MODEL: ModelClient = {
  async complete() {
    return { output: { text: 'Exécution simulée (7b) : aucun fournisseur branché.', tool_calls: [] }, usage: { tokens: 0, cost_cents: 0 } };
  },
};

export const EMPTY_TOOL_HOST: ToolHost = {
  spec: () => null,
  list: () => [],
  execute: async () => { throw new Error('no_tool_in_7b'); },
};
