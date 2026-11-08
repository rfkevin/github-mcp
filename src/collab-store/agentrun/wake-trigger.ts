/**
 * CC8 S8 B — réveil durable, transactionnel et borné.
 * CollabStore insère les intentions et wake_queued dans le même batch CAS qu'un event APPLIED.
 * eventWake tente une livraison immédiate, une alarme DO indépendante reprend si bail occupé
 * ou si le passage échoue. Le cron reste le filet de secours.
 */
import { agentRunPass, type WakeFn } from './orchestrator';
import { agentRunDb, wakeViaNamespace, type AgentRunObjectEnv } from './object';
import { ensureAgentRunSchema } from './schema';
import { durableWakeWorthy, DURABLE_WAKE_EVENT_TYPES } from '../store/collab-store';
import { ensureSchema } from '../store/schema';

export const WAKE_EVENT_TYPES = DURABLE_WAKE_EVENT_TYPES;
export const wakeWorthy = durableWakeWorthy;
export const PASS_LEASE_TTL_S = 60;
export const WAKE_BATCH_LIMIT = 20;
export const WAKE_MAX_FAILURES = 6;
export const EVENT_WAKE_OBJECT_NAME = 'cc8-agent-event-pass-v1';

export async function acquireEventPassLease(db: D1Database, now: number, holder: string): Promise<boolean> {
  await ensureAgentRunSchema(db);
  const result = await db.prepare([
    'INSERT INTO agent_run_pass_lease (id, holder, expires_at) VALUES (1, ?1, ?2)',
    'ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at',
    '  WHERE agent_run_pass_lease.expires_at <= ?3',
  ].join(' ')).bind(holder, now + PASS_LEASE_TTL_S, now).run();
  return result.meta.changes === 1;
}

export type WakeEvent = { type: string; payload_json: string };
interface Intent { event_key: string; attempts: number; next_at: number }
export interface EventWakeDrain { delivered: number; deferred: number; errors: number; next_at: number | null }

async function markIntent(db: D1Database, row: Intent, now: number, status: 'delivered' | 'deferred' | 'error',
  nextAt: number, reason: string): Promise<void> {
  const nextAttempts = row.attempts + (reason === 'PASS_FAILED' || reason === 'DISABLED' ? 1 : 0);
  const audit = status === 'delivered' ? 'wake_delivered' : status === 'error' ? 'wake_error' : 'wake_deferred';
  await db.batch([
    db.prepare([
      'UPDATE agent_event_wake_intents',
      'SET status=?1,attempts=?2,next_at=?3,updated_at=?4,last_error=?5',
      "WHERE event_key=?6 AND status IN ('queued','deferred')",
    ].join(' ')).bind(status, nextAttempts, nextAt, now, reason, row.event_key),
    db.prepare('INSERT INTO agent_event_wake_audit(event_key,at,kind,detail) VALUES(?1,?2,?3,?4)')
      .bind(row.event_key, now, audit, reason),
  ]);
}

function backoff(attempt: number): number {
  return Math.min(60, 5 * 2 ** Math.min(attempt, 4));
}

/** À chaque appel : une seule décision de planification, jamais de modèle/outil directement ici.
 * Le bail D1 garantit qu'un seul drain livre les événements concurrents. Les reprises se font
 * via l'alarme du DO et non dans waitUntil. Les erreurs restent typées et auditables.
 */
export async function drainDurableEventWakes(db: D1Database, env: AgentRunObjectEnv,
  opts: { now: number; deliverer: string; wake: WakeFn }): Promise<EventWakeDrain> {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  const now = opts.now;
  const queued = (await db.prepare([
    'SELECT event_key,attempts,next_at FROM agent_event_wake_intents',
    "WHERE status IN ('queued','deferred') AND next_at <= ?1",
    'ORDER BY next_at,event_key LIMIT ?2',
  ].join(' ')).bind(now, WAKE_BATCH_LIMIT).all<Intent>()).results;
  const nextDue = async (): Promise<number | null> => {
    const due = await db.prepare([
      'SELECT MIN(next_at) AS at FROM agent_event_wake_intents',
      "WHERE status IN ('queued','deferred')",
    ].join(' ')).first<{ at: number | null }>();
    return due?.at ?? null;
  };
  if (!queued.length) return { delivered: 0, deferred: 0, errors: 0, next_at: await nextDue() };
  if (env.AGENT_RUNS_ENABLED !== 'true' || !env.AGENT_RUN) {
    return { delivered: 0, deferred: queued.length, errors: 0, next_at: null };
  }
  const halt = await db.prepare("SELECT value FROM owner_flags WHERE name='halt'").first<{value:string}>();
  if (halt?.value === '1') {
    for (const item of queued) await markIntent(db, item, now, 'deferred', now + PASS_LEASE_TTL_S, 'HALT');
    return { delivered: 0, deferred: queued.length, errors: 0, next_at: await nextDue() };
  }
  if (!await acquireEventPassLease(db, now, opts.deliverer)) {
    const lease = await db.prepare('SELECT expires_at FROM agent_run_pass_lease WHERE id=1')
      .first<{ expires_at: number }>();
    const retryAt = Math.max(now + 1, lease?.expires_at ?? now + PASS_LEASE_TTL_S);
    for (const item of queued) await markIntent(db, item, now, 'deferred', retryAt, 'LEASE_BUSY');
    return { delivered: 0, deferred: queued.length, errors: 0, next_at: await nextDue() };
  }
  try {
    const result = await agentRunPass(db, env, { now, deliverer: opts.deliverer, wake: opts.wake });
    if (result.skipped === 'disabled') throw new Error('DISABLED');
    for (const item of queued) await markIntent(db, item, now, 'delivered', now, 'PASS_APPLIED');
    const next = await nextDue();
    return { delivered: queued.length, deferred: 0, errors: 0,
      next_at: next === null ? null : Math.max(next, now + PASS_LEASE_TTL_S) };
  } catch {
    for (const item of queued) {
      const attempts = item.attempts + 1;
      const dead = attempts >= WAKE_MAX_FAILURES;
      await markIntent(db, item, now, dead ? 'error' : 'deferred',
        dead ? now : now + backoff(attempts), 'PASS_FAILED');
    }
    const next = await nextDue();
    return { delivered: 0, deferred: queued.length, errors: queued.length,
      next_at: next === null ? null : Math.max(next, now + PASS_LEASE_TTL_S) };
  }
}

/** Le Durable Object de service n'est pas un run modèle : uniquement une alarme de livraison. */
export async function armDurableEventWake(namespace: DurableObjectNamespace, atMs: number): Promise<void> {
  const object = namespace.get(namespace.idFromName(EVENT_WAKE_OBJECT_NAME)) as unknown as {
    armEventPass(atMs: number): Promise<void>;
  };
  await object.armEventPass(atMs);
}

/** Hook fail-soft ; le canal répond sans attendre la planification.
 * Il conserve le pipeline de S8a et arme avant le drain une alarme DO indépendante,
 * afin qu'une interruption de waitUntil ne supprime pas une intention D1.
 */
export function eventWake(env: AgentRunObjectEnv, ctx: Pick<ExecutionContext, 'waitUntil'>,
  wake?: WakeFn): (event: WakeEvent) => void {
  if (env.AGENT_RUNS_ENABLED !== 'true' || !env.AGENT_RUN) return () => undefined;
  const db = agentRunDb(env);
  if (!db) return () => undefined;
  const wakeFn = wake ?? wakeViaNamespace(env.AGENT_RUN);
  const supportsAlarm = typeof env.AGENT_RUN.get === 'function' && typeof env.AGENT_RUN.idFromName === 'function';
  return event => {
    if (!wakeWorthy(event.type, event.payload_json)) return;
    try {
      ctx.waitUntil((async () => {
        const now = Math.floor(Date.now() / 1000);
        // Une panne d'armement n'empêche pas le passage direct ; l'intention reste durable.
        if (supportsAlarm) await armDurableEventWake(env.AGENT_RUN!, now * 1000).catch(() => undefined);
        const result = await drainDurableEventWakes(db, env, {
          now, deliverer: 'event-pass:' + crypto.randomUUID(), wake: wakeFn,
        });
        if (supportsAlarm && result.next_at !== null) {
          await armDurableEventWake(env.AGENT_RUN!, result.next_at * 1000).catch(() => undefined);
        }
      })());
    } catch {
      // Impossible de programmer waitUntil : l'outbox CAS conserve le réveil.
    }
  };
}
