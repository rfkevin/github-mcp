import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { planAgentRuns, answerAttemptRunId } from '../../../src/collab-store/agentrun/plan';
import { runStep, ModelCallError, type ToolHost } from '../../../src/collab-store/agentrun/engine';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { PLAN_MODEL } from './plan-model';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 2_000_000_000;
let n = 0;
const tools: ToolHost = {
  list: () => [], spec: () => null,
  execute: async () => { throw new Error('no tools expected'); },
};

async function seed() {
  await ensureSchema(db);
  const cycle = '0000-s1b-retry-' + (++n);
  const participant = 's1b-answer-' + n;
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: 's1b', cycle, owner: 'author', reviewer: participant, tester: 'tester' });
  await insertEventRow(db, { cycle, type: 'clarify.ask', participant: 'author', role: '',
    payload: { question: 'Quel résultat ?', to: participant }, key: cycle + ':ask', expectedRev: 1 });
  const ask = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1')
    .bind(cycle + ':ask').first<{ seq: number }>();
  return { cycle, participant, askSeq: ask!.seq };
}

describe('S1b — une même mission malgré les interruptions du fournisseur', () => {
  it('HTTP 503 : reprise du même run D1, aucune nouvelle tâche après interruption', async () => {
    const q = await seed();
    const config = { ...PLAN_MODEL, AGENT_RUN_PARTICIPANTS: q.participant };
    expect((await planAgentRuns(db, config, { now: T })).created).toBe(1);
    const id = await answerAttemptRunId(q.cycle, q.participant, q.askSeq, 'P6', 0, 1);
    let calls = 0;
    const model = { complete: async () => { calls++; throw new ModelCallError('HTTP 503', { tokens: 7, cost_cents: 0 }); } };
    expect((await runStep(db, id, { model, tools, now: () => T + 1, workerId: 'w' })).outcome).toBe('retry');
    expect((await planAgentRuns(db, config, { now: T + 902 })).created).toBe(0);
    expect((await runStep(db, id, { model, tools, now: () => T + 32, workerId: 'w' })).outcome).toBe('retry');
    const stored = await db.prepare('SELECT status, tokens_used FROM agent_runs WHERE run_id = ?1')
      .bind(id).first<{status:string; tokens_used:number}>();
    expect(stored).toMatchObject({ status: 'running', tokens_used: 14 });
    expect(calls).toBe(2);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE cycle_id = ?1')
      .bind(q.cycle).first<{n:number}>())!.n).toBe(1);
  });

  it('des erreurs transitoires anciennes permettent plus de trois runs, jamais deux au même ID', async () => {
    const q = await seed();
    const config = { ...PLAN_MODEL, AGENT_RUN_PARTICIPANTS: q.participant };
    for (let attempt = 1; attempt <= 5; attempt++) {
      const at = T + (attempt - 1) * 901;
      expect((await planAgentRuns(db, config, { now: at })).created).toBe(1);
      const id = await answerAttemptRunId(q.cycle, q.participant, q.askSeq, 'P6', 0, attempt);
      expect((await planAgentRuns(db, config, { now: at })).created).toBe(0);
      await db.prepare("UPDATE agent_runs SET status='failed', stop_reason='model_transient: legacy', updated_at=?2 WHERE run_id=?1")
        .bind(id, at+1).run();
      expect((await planAgentRuns(db, config, { now: at + 899 })).created).toBe(0);
    }
    expect((await db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE cycle_id=?1')
      .bind(q.cycle).first<{n:number}>())!.n).toBe(5);
    expect((await planAgentRuns(db, config, { now: T + 5 * 901 })).created).toBe(1);
  });

  it('refus permanent : aucune seconde tentative même après 900 s', async () => {
    const q = await seed();
    const config = { ...PLAN_MODEL, AGENT_RUN_PARTICIPANTS: q.participant };
    expect((await planAgentRuns(db, config, { now: T })).created).toBe(1);
    const id = await answerAttemptRunId(q.cycle, q.participant, q.askSeq, 'P6', 0, 1);
    const model = { complete: async () => { throw new ModelCallError('HTTP 403', null); } };
    expect((await runStep(db, id, { model, tools, now: () => T + 1, workerId: 'w' })).outcome).toBe('failed');
    expect((await planAgentRuns(db, config, { now: T + 10_000 })).created).toBe(0);
  });
});
