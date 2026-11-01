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

describe('S1b — moteur et planificateur : relances bornées', () => {
  it('503 : trois tentatives, intervalle de 900 s, aucun doublon ni quatrième run', async () => {
    const q = await seed();
    const config = { ...PLAN_MODEL, AGENT_RUN_PARTICIPANTS: q.participant };
    let calls = 0;
    const model = { complete: async () => { calls++; throw new ModelCallError('HTTP 503', { tokens: 7, cost_cents: 0 }); } };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const at = T + (attempt - 1) * 901;
      expect((await planAgentRuns(db, config, { now: at })).created).toBe(1);
      const id = await answerAttemptRunId(q.cycle, q.participant, q.askSeq, 'P6', 0, attempt);
      expect((await planAgentRuns(db, config, { now: at })).created).toBe(0);
      expect((await runStep(db, id, { model, tools, now: () => at + 1, workerId: 'w' })).outcome).toBe('failed');
      const row = await db.prepare('SELECT stop_reason, tokens_used FROM agent_runs WHERE run_id = ?1')
        .bind(id).first<{ stop_reason: string; tokens_used: number }>();
      expect(row).toMatchObject({ stop_reason: 'model_transient: HTTP 503', tokens_used: 7 });
      expect((await planAgentRuns(db, config, { now: at + 900 })).created).toBe(0);
    }
    expect((await planAgentRuns(db, config, { now: T + 10_000 })).created).toBe(0);
    expect(calls).toBe(3);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE cycle_id = ?1')
      .bind(q.cycle).first<{ n: number }>())!.n).toBe(3);
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
