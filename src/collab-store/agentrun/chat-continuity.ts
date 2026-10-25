/**
 * CC-5 l7e — continuité chat / API : lister, préempter et relâcher les exécutions
 * du participant serveur uniquement (masquage CR-C). N'utilise que les exports
 * publics du moteur (preemptByChat, releaseChat, runSummary, leaseKeyOf).
 */
import { ensureAgentRunSchema } from './schema';
import { preemptByChat, releaseChat, runSummary, leaseKeyOf } from './engine';

export const CHAT_HOLD_SECONDS_DEFAULT = 900;
export const LIST_RUNS_LIMIT = 40;

export interface AgentRunListItem {
  run_id: string;
  cycle_id: string;
  task_id: string;
  task_kind: string;
  status: string;
  steps_done: number;
  tokens_used: number;
  cost_cents: number;
  stop_reason: string;
  summary: string;
  updated_at: number;
  fence_holder: string | null;
  fence_generation: number | null;
}

/** Liste les exécutions d'UN participant (jamais un autre — CR-C). */
export async function listRunsForParticipant(
  db: D1Database,
  participantId: string,
  options: { cycleId?: string; limit?: number } = {},
): Promise<AgentRunListItem[]> {
  await ensureAgentRunSchema(db);
  const limit = Math.min(LIST_RUNS_LIMIT, Math.max(1, options.limit ?? LIST_RUNS_LIMIT));
  const cycle = options.cycleId?.trim() || null;
  const sql = cycle
    ? [
        'SELECT r.run_id, r.cycle_id, r.task_id, r.task_kind, r.status, r.steps_done, r.tokens_used,',
        '  r.cost_cents, r.stop_reason, r.summary, r.updated_at, f.holder AS fence_holder, f.generation AS fence_generation',
        'FROM agent_runs r LEFT JOIN agent_fences f ON f.lease_key = r.lease_key',
        'WHERE r.participant_id = ?1 AND r.cycle_id = ?2 ORDER BY r.updated_at DESC LIMIT ?3',
      ].join(' ')
    : [
        'SELECT r.run_id, r.cycle_id, r.task_id, r.task_kind, r.status, r.steps_done, r.tokens_used,',
        '  r.cost_cents, r.stop_reason, r.summary, r.updated_at, f.holder AS fence_holder, f.generation AS fence_generation',
        'FROM agent_runs r LEFT JOIN agent_fences f ON f.lease_key = r.lease_key',
        'WHERE r.participant_id = ?1 ORDER BY r.updated_at DESC LIMIT ?2',
      ].join(' ');
  const stmt = cycle
    ? db.prepare(sql).bind(participantId, cycle, limit)
    : db.prepare(sql).bind(participantId, limit);
  const { results } = await stmt.all<AgentRunListItem>();
  return results ?? [];
}

/** Résumé d'une exécution uniquement si elle appartient au participant. */
export async function runSummaryForParticipant(
  db: D1Database,
  participantId: string,
  runId: string,
): Promise<(NonNullable<Awaited<ReturnType<typeof runSummary>>> & { run_id: string; cycle_id: string; task_id: string }) | null> {
  await ensureAgentRunSchema(db);
  const row = await db.prepare(
    'SELECT run_id, cycle_id, task_id FROM agent_runs WHERE run_id = ?1 AND participant_id = ?2',
  ).bind(runId, participantId).first<{ run_id: string; cycle_id: string; task_id: string }>();
  if (!row) return null;
  const summary = await runSummary(db, runId);
  if (!summary) return null;
  return { ...summary, run_id: row.run_id, cycle_id: row.cycle_id, task_id: row.task_id };
}

/**
 * CC-7 L1 — préemption chat par identité (S5).
 * Le bail est dérivé de (cycle, participant, task) via leaseKeyOf : le chat peut
 * prendre la main AVANT toute exécution API. Plus d'exigence de run préalable
 * (sinon le chat ne pouvait pas ouvrir le bail automatiquement).
 * L'identité est celle du jeton serveur ; on ne touche jamais le fence d'autrui.
 */
export async function preemptOwnRun(
  db: D1Database,
  input: { participantId: string; cycleId: string; taskId: string; now: number; holdSeconds?: number },
): Promise<{ ok: true; generation: number } | { ok: false; reason: 'not_owner' }> {
  if (!input.participantId || !input.cycleId) return { ok: false, reason: 'not_owner' };
  await ensureAgentRunSchema(db);
  const generation = await preemptByChat(db, {
    cycleId: input.cycleId,
    participantId: input.participantId,
    taskId: input.taskId || '',
    now: input.now,
    holdSeconds: input.holdSeconds ?? CHAT_HOLD_SECONDS_DEFAULT,
  });
  return { ok: true, generation };
}

/** CC-7 L1 — relâchement chat par identité ; pas d'exigence de run préalable. */
export async function releaseOwnRun(
  db: D1Database,
  input: { participantId: string; cycleId: string; taskId: string; now: number },
): Promise<{ ok: true } | { ok: false; reason: 'not_owner' }> {
  if (!input.participantId || !input.cycleId) return { ok: false, reason: 'not_owner' };
  await ensureAgentRunSchema(db);
  await releaseChat(db, {
    cycleId: input.cycleId,
    participantId: input.participantId,
    taskId: input.taskId || '',
    now: input.now,
  });
  return { ok: true };
}

/** Vue owner lecture seule : dernières exécutions tous participants (pas de masquage CR-C côté owner). */
export async function listRunsForOwner(
  db: D1Database,
  limit = 30,
): Promise<Array<AgentRunListItem & { participant_id: string }>> {
  await ensureAgentRunSchema(db);
  const { results } = await db.prepare([
    'SELECT r.run_id, r.cycle_id, r.participant_id, r.task_id, r.task_kind, r.status, r.steps_done,',
    '  r.tokens_used, r.cost_cents, r.stop_reason, r.summary, r.updated_at,',
    '  f.holder AS fence_holder, f.generation AS fence_generation',
    'FROM agent_runs r LEFT JOIN agent_fences f ON f.lease_key = r.lease_key',
    'ORDER BY r.updated_at DESC LIMIT ?1',
  ].join(' ')).bind(Math.min(50, Math.max(1, limit))).all<AgentRunListItem & { participant_id: string }>();
  return results ?? [];
}

export { leaseKeyOf };
