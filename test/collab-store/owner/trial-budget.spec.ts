import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { runCapacity } from '../../../src/collab-store/agentrun/capacity';
import { createRoutedModel } from '../../../src/collab-store/agentrun/provider-models';
import { fetchStub } from '../agentrun/cc7-l2-paid-harness';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { trialBudget } from '../../../src/collab-store/agentrun/trial-budget';
import { reserveParticipantStep, settleParticipantStep } from '../../../src/collab-store/agentrun/paid-model';
import { decideOwnerRequest, executablePayloadSha256 } from '../../../src/collab-store/owner/executable';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { OWNER_PROOF } from '../coordinator-helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const cycle = 'owner-trial-budget-test';
const members = ['claude','vibe','gemini'].map(participant_id => ({ participant_id, task_id: 'review-' + participant_id }));

async function request(amount: number, previous: number | null) {
  const action = 'fund_agent_trial';
  const params = { cycle_id: cycle, trial_id: 'comparison', members, limit_cents: amount };
  const request_id = 'trial-' + amount;
  const payload_sha256 = await executablePayloadSha256(action, params);
  const payload = { request_id, action, params, payload_sha256, max_cost_cents: amount,
    preconditions: { previous_seq: previous }, reason: 'compare', risk: 'paid calls', rollback: 'set zero' };
  const row = await db.prepare("INSERT INTO events (cycle_id,at,type,participant_id,payload_json,idempotency_key) VALUES (?1,1,'owner.request','gpt6',?2,?3) RETURNING seq")
    .bind(cycle, JSON.stringify(payload), request_id).first<{ seq: number }>();
  return { request_id, request_seq: row!.seq, payload_sha256, proof: OWNER_PROOF, decision: 'approve' as const };
}

it('approves once, shares pending and settled charges, and changes the limit without refilling', async () => {
  await ensureSchema(db);
  await db.prepare('INSERT INTO cycles (cycle_id) VALUES (?1)').bind(cycle).run();
  const attempts = members.map(({ participant_id, task_id }) => ({
    runId: 'trial-' + participant_id, participantId: participant_id, taskId: task_id, cycleId: cycle,
    now: 1, deadlineAt: 100, taskKind: 'review', prompt: 'review', maxSteps: 8, maxTokens: 10000, maxCostCents: 20,
  }));
  for (const run of attempts) await createRun(db, run);
  const req = await request(20, null);
  expect(await trialBudget(db, cycle, members[0].task_id, 'claude')).toBeNull();
  const routes = { LLM_KEY_ANTHROPIC: 'test-only', AGENT_RUN_MODEL_CLAUDE: 'anthropic:claude-haiku-5-5' };
  const available = () => runCapacity(db, routes, 'claude', cycle, 'review', new Date(), members[0].task_id);
  expect((await available()).capable).toBe(false);
  const decision = await decideOwnerRequest(db, req);
  expect((await available()).capable).toBe(true);
  expect((await decideOwnerRequest(db, req)).status).toBe('duplicate');
  expect(await trialBudget(db, cycle, members[0].task_id, 'gemini')).toBeNull();
  const reserve = (i: number, n: number, cents: number) => reserveParticipantStep(db, {
    ...attempts[i], n, cents, tokens: 10, nowSec: 2, day: '2030-01-01',
    envelope: { dayCents: 0, cycleCents: 0, dayTokens: 0, dayRequests: 0 },
  });
  const results = await Promise.allSettled(attempts.map((_, i) => reserve(i, 0, 11)));
  const winner = results.findIndex(r => r.status === 'fulfilled');
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(await trialBudget(db, cycle, members[1].task_id, 'vibe')).toMatchObject({ limit_cents: 20, used_cents: 11 });
  await settleParticipantStep(db, { ...attempts[winner], n: 0, day: '2030-01-01', reservedCents: 11,
    actualCents: 3, reservedTokens: 10, actualTokens: 6, nowSec: 3 });
  await reserve((winner + 1) % 3, 1, 17);
  await expect(reserve(winner, 2, 1)).rejects.toThrow();
  const increase = await decideOwnerRequest(db, await request(22, decision.event.seq));
  const stub = fetchStub([{ content: [{ type: 'text', text: 'review' }], usage: { input_tokens: 11, output_tokens: 2 } }]);
  await db.prepare('UPDATE agent_runs SET steps_done=3 WHERE run_id=?1').bind(attempts[0].runId).run();
  const model = createRoutedModel(routes, { env: routes, db, runId: attempts[0].runId,
    envelope: { dayCents: 0, cycleCents: 0, dayTokens: 0, dayRequests: 0 }, schemas: () => [],
    system: 'S', maxOutputTokens: 64, fetchImpl: stub.fetchImpl });
  expect((await model.complete({ messages: [{ role: 'user', content: 'test' }], task_kind: 'review', tools: [] })).output.text).toBe('review');
  expect(stub.seen).toHaveLength(1);
  await decideOwnerRequest(db, await request(0, increase.event.seq));
  expect((await available()).capable).toBe(false);
  expect(await trialBudget(db, cycle, members[0].task_id, 'claude')).toMatchObject({ limit_cents: 0, used_cents: 21 });
});
