import { ownerAppend } from './decisions';
import { bindingGuard, bindingKey, bindingPayload, bindingStatements, type OwnerRequestBinding } from './binding';
import type { OwnerProof } from './proof';
import { ensureAgentRunSchema } from '../agentrun/schema';

const id = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/;
function identifier(value: unknown): value is string { return typeof value === 'string' && id.test(value); }

export function trialParams(params: Record<string, unknown>) {
  const { cycle_id, trial_id, limit_cents, members } = params;
  if (Object.keys(params).some(k => !['cycle_id','trial_id','limit_cents','members'].includes(k))
    || !identifier(cycle_id) || !identifier(trial_id) || typeof limit_cents !== 'number' || !Number.isSafeInteger(limit_cents)
    || limit_cents < 0 || limit_cents > 1000 || !Array.isArray(members) || !members.length || members.length > 32)
    throw new Error('Budget essai : cycle, montant total (0–1000 cents US) et 1–32 participants/tâches requis.');
  const keys = new Set<string>();
  const scope = members.map(member => {
    if (!member || Object.keys(member).length !== 2 || !identifier(member.task_id) || !identifier(member.participant_id))
      throw new Error('Chaque entrée doit identifier une tâche et un participant.');
    const key = member.task_id + '/' + member.participant_id;
    if (keys.has(key)) throw new Error('Participation en double.');
    keys.add(key);
    return { task_id: String(member.task_id), participant_id: String(member.participant_id) };
  });
  return { cycle_id, trial_id, limit_cents, members: scope };
}

export async function approveTrialBudget(db: D1Database, params: ReturnType<typeof trialParams>,
  proof: OwnerProof, binding: OwnerRequestBinding, now?: () => Date) {
  await ensureAgentRunSchema(db);
  const prefix = 'owner:trial-budget:' + params.cycle_id + '/' + params.trial_id;
  const previous = binding.expected_previous_seq;
  if (previous !== null) {
    const prior = await db.prepare('SELECT participant_id, task_id FROM agent_trial_members WHERE approval_seq=?1')
      .bind(previous).all<{ participant_id: string; task_id: string }>();
    if (prior.results.length !== params.members.length || !params.members.every(m =>
      prior.results.some(p => p.participant_id === m.participant_id && p.task_id === m.task_id)))
      throw new Error('Une révision conserve les participants et les tâches approuvés.');
  }
  return ownerAppend(db, {
    cycleId: params.cycle_id, key: bindingKey(prefix, binding), proof, now,
    payload: { action: 'fund_agent_trial', ...params, ...bindingPayload(binding) },
    extraGuard: bindingGuard(binding, prefix + ':'),
    sideEffects: key => [
      ...bindingStatements(db, binding, proof, key, now),
      ...(previous !== null ? [db.prepare(`UPDATE agent_trial_members SET limit_cents=?1,
        approval_seq=(SELECT seq FROM events WHERE idempotency_key=?2) WHERE approval_seq=?3`)
        .bind(params.limit_cents, key, previous)] : params.members.map(member => db.prepare(`INSERT INTO agent_trial_members
        (cycle_id,task_id,participant_id,approval_seq,limit_cents)
        VALUES (?1,?2,?3,(SELECT seq FROM events WHERE idempotency_key=?4),?5)`)
        .bind(params.cycle_id, member.task_id, member.participant_id, key, params.limit_cents))),
    ],
  });
}
