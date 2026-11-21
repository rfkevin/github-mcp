import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { acquireEventPassLease, drainDurableEventWakes, PASS_LEASE_TTL_S, WAKE_MAX_FAILURES,
  type EventWakeDrain } from '../../../src/collab-store/agentrun/wake-trigger';
import type { AgentRunObjectEnv } from '../../../src/collab-store/agentrun/object';
import type { WakeFn } from '../../../src/collab-store/agentrun/orchestrator';
import { CHAT_ACTIVE_SECONDS } from '../../../src/collab-store/context/active-work';
import { PLAN_MODEL } from './plan-model';
import { insertCycleRow, insertPhaseDefinition } from '../a0-helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 2_020_000_000;
const environment = { AGENT_RUNS_ENABLED: 'true', AGENT_RUN: {} as never, COLLAB_DB: db,
  AGENT_RUN_PARTICIPANTS: '', AGENT_RUN_MODEL: '' } as AgentRunObjectEnv;
let count = 0;
async function fresh() {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  await db.prepare('DELETE FROM agent_run_pass_lease').run();
  await db.prepare("INSERT INTO owner_flags(name,value,updated_at) VALUES('halt','0',?1) ON CONFLICT(name) DO UPDATE SET value='0',updated_at=?1")
    .bind(T).run();
  const event_key = 's8b-drain-' + (++count) + '-' + Date.now().toString(36);
  await db.prepare([
    'INSERT INTO agent_event_wake_intents(event_key,cycle_id,event_type,status,attempts,next_at,created_at,updated_at)',
    "VALUES(?1,'s8b-test','evidence.add','queued',0,?2,?2,?2)",
  ].join(' ')).bind(event_key, T).run();
  return event_key;
}
async function stateOf(key: string) {
  return db.prepare('SELECT status,attempts,next_at,last_error FROM agent_event_wake_intents WHERE event_key=?1')
    .bind(key).first<{ status: string; attempts: number; next_at: number; last_error: string }>();
}
const wake: WakeFn = async () => ({ accepted: false, reason: 'not_a_real_run' });
const drain = (now: number): Promise<EventWakeDrain> =>
  drainDurableEventWakes(db, environment, { now, deliverer: 'event-pass:test-' + count, wake });

describe('CC8 S8 B — outbox D1 / lease / HALT / reprise', () => {
  it('bail 60 s occupé : événement déféré en D1, livré à expiration une fois, pas de rejeu', async () => {
    const key = await fresh();
    expect(await acquireEventPassLease(db, T, 'other')).toBe(true);
    const pending = await drain(T + 1);
    expect(pending.delivered).toBe(0);
    expect(pending.deferred).toBeGreaterThanOrEqual(1);
    expect((await stateOf(key))?.status).toBe('deferred');
    expect((await stateOf(key))?.next_at).toBe(T + PASS_LEASE_TTL_S);
    const sent = await drain(T + PASS_LEASE_TTL_S);
    expect(sent.delivered).toBeGreaterThanOrEqual(1);
    expect((await stateOf(key))?.status).toBe('delivered');
    await drain(T + PASS_LEASE_TTL_S + 1);
    const audit = (await db.prepare('SELECT kind FROM agent_event_wake_audit WHERE event_key=?1 ORDER BY id')
      .bind(key).all<{kind:string}>()).results.map(x => x.kind);
    expect(audit).toEqual(['wake_deferred', 'wake_delivered']);
  });

  it('HALT : aucune planification, reprise sans perte après levée', async () => {
    const key = await fresh();
    await db.prepare("UPDATE owner_flags SET value='1' WHERE name='halt'").run();
    const stopped = await drain(T);
    expect(stopped.delivered).toBe(0);
    expect((await stateOf(key))?.last_error).toBe('HALT');
    await db.prepare("UPDATE owner_flags SET value='0' WHERE name='halt'").run();
    const resumed = await drain(T + PASS_LEASE_TTL_S);
    expect(resumed.delivered).toBeGreaterThanOrEqual(1);
    expect((await stateOf(key))?.status).toBe('delivered');
  });

  it('intention livrée ne redevient jamais queued et journal borné', async () => {
    const key = await fresh();
    await drain(T);
    expect((await stateOf(key))?.status).toBe('delivered');
    for (let i = 1; i <= WAKE_MAX_FAILURES + 2; i++) await drain(T + PASS_LEASE_TTL_S * i);
    const { results } = await db.prepare('SELECT kind FROM agent_event_wake_audit WHERE event_key=?1').bind(key)
      .all<{kind:string}>();
    expect(results.map(x => x.kind)).toEqual(['wake_delivered']);
  });
  it('does not consume an event wake while Chat activity defers the API answer', async () => {
    await ensureSchema(db);
    await ensureAgentRunSchema(db);
    await db.prepare('DELETE FROM agent_run_pass_lease').run();
    await db.prepare("INSERT INTO owner_flags(name,value,updated_at) VALUES('halt','0',?1) ON CONFLICT(name) DO UPDATE SET value='0',updated_at=?1")
      .bind(T).run();
    const cycle = '0000-s8b-deferred-wake-' + (++count) + '-' + Date.now().toString(36);
    const participant = 's8b-answer-' + count;
    await insertCycleRow(db, cycle, 'P6');
    await insertPhaseDefinition(db, cycle, 'P6', []);
    await db.prepare([
      'INSERT INTO events (cycle_id,at,type,participant_id,session_id,role,payload_json,expected_rev,idempotency_key,evidence_ref)',
      "VALUES(?1,?2,?3,?4,'',?5,?6,0,?7,'')",
    ].join(' ')).bind(cycle, T - 100, 'clarify.ask', 'questioner', '',
      JSON.stringify({ question: 'Judge A/B?', to: participant }), 'op:questioner:' + cycle + ':ask:1').run();
    await db.prepare([
      'INSERT INTO events (cycle_id,at,type,participant_id,session_id,role,payload_json,expected_rev,idempotency_key,evidence_ref)',
      "VALUES(?1,?2,?3,?4,'',?5,?6,0,?7,'')",
    ].join(' ')).bind(cycle, T - 30, 'checkpoint', participant, 'reviewer',
      JSON.stringify({ task: 'other-task', state: 'Chat is reviewing' }),
      'op:' + participant + ':' + cycle + ':chat:1').run();
    const key = cycle + ':outbox';
    await db.prepare([
      'INSERT INTO agent_event_wake_intents(event_key,cycle_id,event_type,status,attempts,next_at,created_at,updated_at)',
      "VALUES(?1,?2,'clarify.ask','queued',0,?3,?3,?3)",
    ].join(' ')).bind(key, cycle, T).run();
    const enabled = { ...environment, ...PLAN_MODEL, AGENT_RUN_PARTICIPANTS: participant } as AgentRunObjectEnv;
    const pass = (now: number) => drainDurableEventWakes(db, enabled, {
      now, deliverer: 'event-pass:deferred-' + count, wake,
    });

    const initially = await pass(T);
    expect(initially.delivered).toBe(0);
    expect(initially.deferred).toBeGreaterThanOrEqual(1);
    expect((await stateOf(key))?.status).toBe('deferred');
    expect((await stateOf(key))?.last_error).toBe('PLANNER_DEFERRED');
    expect((await stateOf(key))?.next_at).toBe(T + PASS_LEASE_TTL_S);

    const stillBusy = await pass(T + PASS_LEASE_TTL_S);
    expect(stillBusy.delivered).toBe(0);
    expect((await stateOf(key))?.status).toBe('deferred');

    const afterChat = await pass(T + CHAT_ACTIVE_SECONDS + 2);
    expect(afterChat.delivered).toBeGreaterThanOrEqual(1);
    expect((await stateOf(key))?.status).toBe('delivered');
    const { results } = await db.prepare(
      "SELECT task_kind FROM agent_runs WHERE cycle_id=?1 AND participant_id=?2",
    ).bind(cycle, participant).all<{ task_kind: string }>();
    expect(results.map(run => run.task_kind)).toContain('answer');
  });

});
