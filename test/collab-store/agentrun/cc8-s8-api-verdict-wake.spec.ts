import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PLAN_MODEL } from './plan-model';
import { answerAttemptRunId, planAgentRuns } from '../../../src/collab-store/agentrun/plan';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { chatActiveWithin } from '../../../src/collab-store/context/active-work';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition } from '../a0-helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 2_090_000_000;
let serial = 0;

async function fixture(label: string) {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  const n = ++serial;
  const cycle = ('0000-cc8-verdict-wake-' + label + '-' + n + '-' + Date.now().toString(36)).slice(0, 63);
  const participant = 'cc8-verdict-wake-' + n;
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await append(cycle, 'clarify.ask', 'questioner', '', 'op:questioner:' + cycle + ':ask:1',
    { question: 'Évalue la paire figée ?', to: participant }, T - 3);
  const ask = await db.prepare('SELECT MAX(seq) AS s FROM events WHERE cycle_id=?1')
    .bind(cycle).first<{ s: number }>();
  return { cycle, participant, askSeq: ask!.s };
}

async function append(cycle: string, type: string, participant: string, role: string,
  key: string, payload: unknown, at: number) {
  await db.prepare([
    'INSERT INTO events (cycle_id,at,type,participant_id,session_id,role,payload_json,expected_rev,idempotency_key,evidence_ref)',
    "VALUES (?1,?2,?3,?4,'',?5,?6,0,?7,'')",
  ].join(' ')).bind(cycle, at, type, participant, role, JSON.stringify(payload), key).run();
}

describe('CC8 S8 — immediate API answer wake after native D12 verdict', () => {
  it('does not misclassify a server-issued API store_verdict with role tester as active Chat', async () => {
    const q = await fixture('api');
    await append(q.cycle, 'evidence.add', q.participant, 'tester',
      'op:' + q.participant + ':' + q.cycle + ':api-verdict-' + 'a'.repeat(32) + ':1',
      { task: 'some-test', state: 'PASS', source: 'github' }, T - 2);

    expect(await chatActiveWithin(db, q.cycle, [q.participant], T)).toBe(false);
    const plan = await planAgentRuns(db, { ...PLAN_MODEL, AGENT_RUN_PARTICIPANTS: q.participant }, { now: T });
    expect(plan.created).toBe(1);
    expect(plan.deferred).toBeUndefined();
    const id = await answerAttemptRunId(q.cycle, q.participant, q.askSeq, 'P6', 0, 1);
    const run = await db.prepare('SELECT task_kind FROM agent_runs WHERE run_id=?1')
      .bind(id).first<{task_kind:string}>();
    expect(run?.task_kind).toBe('answer');
  });

  it('still defers an API run when a real Chat wrote reviewer/tester evidence recently', async () => {
    const q = await fixture('chat');
    await append(q.cycle, 'evidence.add', q.participant, 'reviewer',
      'op:' + q.participant + ':' + q.cycle + ':chat-evidence:1',
      { task: 'some-review', state: 'AGREE', source: 'github' }, T - 2);

    expect(await chatActiveWithin(db, q.cycle, [q.participant], T)).toBe(true);
    const plan = await planAgentRuns(db, { ...PLAN_MODEL, AGENT_RUN_PARTICIPANTS: q.participant }, { now: T });
    expect(plan).toMatchObject({ created: 0, deferred: 1 });
    const later = await planAgentRuns(db, { ...PLAN_MODEL, AGENT_RUN_PARTICIPANTS: q.participant }, { now: T + 902 });
    expect(later.created).toBe(1);
  });
});
