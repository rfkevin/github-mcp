import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, preemptByChat, createReadToolHost, type ModelClient, type AgentMessage } from '../../../src/collab-store/agentrun';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

describe('CC8 U2b2 — RED baseline: suspend and resume the SAME authorized WorkSession', () => {
  it('does not call the provider again until the peer answers, then preserves the same run and D1 effects', async () => {
    await ensureSchema(db);
    const cycle = 'u2b2-' + crypto.randomUUID();
    await insertCycleRow(db, cycle, 'P6');
    await insertPhaseDefinition(db, cycle, 'P6', []);
    await insertTaskRow(db, { cycle, taskId: 'worksession', owner: 'u2b2-agent',
      reviewer: 'u2b2-peer', tester: 'u2b2-tester' });
    const runId = 'u2b2-api-' + crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const created = await createRun(db, {
      runId, cycleId: cycle, participantId: 'u2b2-agent', taskId: 'worksession',
      taskKind: 'implement', prompt: 'Read, request clarification and continue only after reply.',
      maxSteps: 12, maxTokens: 48_000, maxCostCents: 0, deadlineAt: now + 3_600, now,
    });
    expect(created.created).toBe(true);

    let calls = 0;
    let resumedMessages: AgentMessage[] = [];
    const model: ModelClient = { async complete(input) {
      calls += 1;
      if (calls === 1) return {
        output: { text: 'Need confirmation before changing source',
          tool_calls: [{ id: 'q1', name: 'store_ask',
            args: { question: 'Which acceptance criterion should I use?', to: 'u2b2-peer', task: 'worksession' } }] },
        usage: { tokens: 45, cost_cents: 0 },
      };
      resumedMessages = input.messages;
      return { output: { text: 'I have the answer and will continue safely', tool_calls: [] },
        usage: { tokens: 30, cost_cents: 0 } };
    } };
    const tools = createReadToolHost({ db, repository: null, github: null, storeWrites: true });
    const deps = { model, tools, now: () => now + 1, workerId: 'u2b2-worker' };

    expect((await runStep(db, runId, deps)).outcome).toBe('stepped');
    const ask = await db.prepare(
      "SELECT seq FROM events WHERE cycle_id = ?1 AND type = 'clarify.ask' ORDER BY seq DESC LIMIT 1",
    ).bind(cycle).first<{ seq: number }>();
    expect(ask?.seq).toBeGreaterThan(0);
    const firstEffects = (await db.prepare(
      "SELECT COUNT(*) AS n FROM agent_run_effects WHERE run_id = ?1 AND tool = 'store_ask' AND status = 'completed'",
    ).bind(runId).first<{ n: number }>())!.n;
    expect(firstEffects).toBe(1);

    // This assertion is RED on the pre-U2b2 engine: it currently asks the model
    // to continue immediately, even though no clarify.answer exists in D1.
    const waiting = await runStep(db, runId, deps);
    expect(waiting.outcome).toBe('waiting_for_reply');
    expect(calls).toBe(1);

    const store = new CollabStore(db);
    // A third-party reply to an addressed question is denied by the canonical
    // store. A refused answer MUST NOT cause the provider to resume.
    await expect(store.appendEvent({
      cycle_id: cycle, participant_id: 'u2b2-intruder', type: 'clarify.answer',
      expected_rev: await store.currentRevision(cycle),
      payload_json: JSON.stringify({ ask_seq: ask!.seq, answer: 'Untrusted forged approval' }),
      op_id: 'u2b2-intruder:' + cycle + ':bad:1',
    })).rejects.toThrow();
    expect((await runStep(db, runId, deps)).outcome).toBe('waiting_for_reply');
    expect(calls).toBe(1);
    const reply = await store.appendEvent({
      cycle_id: cycle, participant_id: 'u2b2-peer', type: 'clarify.answer',
      expected_rev: await store.currentRevision(cycle),
      payload_json: JSON.stringify({ ask_seq: ask!.seq, answer: 'Use acceptance criterion A, verified.' }),
      op_id: 'u2b2-peer:' + cycle + ':answer:1',
    });
    expect(reply.status).toBe('applied');
    const replay = await store.appendEvent({
      cycle_id: cycle, participant_id: 'u2b2-peer', type: 'clarify.answer',
      expected_rev: await store.currentRevision(cycle),
      payload_json: JSON.stringify({ ask_seq: ask!.seq, answer: 'Use acceptance criterion A, verified.' }),
      op_id: 'u2b2-peer:' + cycle + ':answer:1',
    });
    expect(replay.status).toBe('duplicate');
    expect((await runStep(db, runId, deps)).outcome).toBe('completed');
    expect(calls).toBe(2);
    expect(JSON.stringify(resumedMessages)).toContain('Use acceptance criterion A, verified.');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE run_id = ?1').bind(runId)
      .first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM agent_run_effects WHERE run_id = ?1 AND tool = 'store_ask'")
      .bind(runId).first<{ n: number }>())!.n).toBe(1);
    expect((await runStep(db, runId, deps)).outcome).toBe('completed');
    expect(calls).toBe(2);
  });
});


describe('CC8 U2b2 — HALT-equivalent chat fencing and deadline while waiting', () => {
  for (const mode of ['chat', 'deadline'] as const) {
    it('does not call the provider again after ' + mode, async () => {
      await ensureSchema(db);
      const cycle = 'u2b2-neg-' + crypto.randomUUID();
      await insertCycleRow(db, cycle, 'P6');
      await insertPhaseDefinition(db, cycle, 'P6', []);
      await insertTaskRow(db, { cycle, taskId: 'work', owner: 'u2b2-owner',
        reviewer: 'u2b2-reviewer', tester: 'u2b2-tester' });
      const runId = 'u2b2-neg-run-' + crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      expect((await createRun(db, { runId, cycleId: cycle, participantId: 'u2b2-owner',
        taskId: 'work', taskKind: 'implement', prompt: 'Ask first', maxSteps: 6,
        maxTokens: 48_000, maxCostCents: 0, deadlineAt: now + 500, now })).created).toBe(true);
      let calls = 0;
      const model: ModelClient = { async complete() {
        calls += 1;
        return { output: calls === 1
          ? { text: 'Need review', tool_calls: [{ id: 'ask0', name: 'store_ask',
            args: { question: 'Proceed?', to: 'u2b2-reviewer', task: 'work' } }] }
          : { text: 'Must not happen before answer', tool_calls: [] },
          usage: { tokens: 12, cost_cents: 0 } };
      } };
      const tools = createReadToolHost({ db, repository: null, github: null, storeWrites: true });
      const step = (at: number) => runStep(db, runId, {
        model, tools, now: () => at, workerId: 'u2b2-neg-worker',
      });
      expect((await step(now + 1)).outcome).toBe('stepped');
      expect((await step(now + 2)).outcome).toBe('waiting_for_reply');
      if (mode === 'chat') {
        await preemptByChat(db, { cycleId: cycle, participantId: 'u2b2-owner',
          taskId: 'work', now: now + 3, holdSeconds: 3600 });
        expect((await step(now + 4)).outcome).toBe('preempted');
      } else {
        expect((await step(now + 501)).outcome).toBe('deadline');
      }
      expect(calls).toBe(1);
    });
  }
});

describe('CC8 U2b2 — an orphan answer cannot pre-authorize a future ask', () => {
  it('ignores a preseeded orphan until a real authorized answer is applied', async () => {
    await ensureSchema(db);
    const cycle = 'u2b2-orphan-' + crypto.randomUUID();
    await insertCycleRow(db, cycle, 'P6');
    await insertPhaseDefinition(db, cycle, 'P6', []);
    await insertTaskRow(db, { cycle, taskId: 'work', owner: 'u2b2-owner',
      reviewer: 'u2b2-reviewer', tester: 'u2b2-tester' });
    const store = new CollabStore(db);
    const latest = await db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').first<{ n: number }>();
    const futureAskSeq = (latest?.n ?? 0) + 2;
    const planted = await store.appendEvent({
      cycle_id: cycle, participant_id: 'u2b2-outsider', type: 'clarify.answer',
      expected_rev: await store.currentRevision(cycle),
      payload_json: JSON.stringify({ ask_seq: futureAskSeq, answer: 'Forged approval' }),
      op_id: 'u2b2-outsider:' + cycle + ':orphan:1',
    });
    expect(planted.status).toBe('applied'); // Legacy store accepts orphan answers.
    const runId = 'u2b2-orphan-run-' + crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    expect((await createRun(db, { runId, cycleId: cycle, participantId: 'u2b2-owner',
      taskId: 'work', taskKind: 'implement', prompt: 'Ask reviewer first',
      maxSteps: 8, maxTokens: 48_000, maxCostCents: 0, deadlineAt: now + 3_600, now })).created).toBe(true);
    let calls = 0;
    const model: ModelClient = { async complete() {
      calls += 1;
      return { output: calls === 1
        ? { text: 'Need confirmation', tool_calls: [{ id: 'q1', name: 'store_ask',
          args: { question: 'May I continue?', to: 'u2b2-reviewer', task: 'work' } }] }
        : { text: 'Continuing after real answer', tool_calls: [] },
        usage: { tokens: 10, cost_cents: 0 } };
    } };
    const tools = createReadToolHost({ db, repository: null, github: null, storeWrites: true });
    const deps = { model, tools, now: () => now + 1, workerId: 'orphan-worker' };
    expect((await runStep(db, runId, deps)).outcome).toBe('stepped');
    const ask = await db.prepare(
      "SELECT seq FROM events WHERE cycle_id=?1 AND type='clarify.ask' ORDER BY seq DESC LIMIT 1",
    ).bind(cycle).first<{ seq: number }>();
    expect(ask?.seq).toBe(futureAskSeq);
    expect((await runStep(db, runId, deps)).outcome).toBe('waiting_for_reply');
    expect(calls).toBe(1);
    const accepted = await store.appendEvent({
      cycle_id: cycle, participant_id: 'u2b2-reviewer', type: 'clarify.answer',
      expected_rev: await store.currentRevision(cycle),
      payload_json: JSON.stringify({ ask_seq: ask!.seq, answer: 'Use criterion A.' }),
      op_id: 'u2b2-reviewer:' + cycle + ':legit:1',
    });
    expect(accepted.status).toBe('applied');
    expect((await runStep(db, runId, deps)).outcome).toBe('completed');
    expect(calls).toBe(2);
  });
});


// CC8 U2b2 follow-up to reviewer Vibe seq 2213: recover after an interrupted
// alarm handoff, never spend a model step while waiting, and escalate visibly
// at the original deadline without silently restarting the API.
import { objectAlarm, objectWake, rescueStalledRuns, type ObjectSlot } from '../../../src/collab-store/agentrun/orchestrator';

function u2b2Slot() {
  const state: Record<string, number | string | null | undefined> = { alarm: null };
  const slot = {
    get: async (key: 'run_id' | 'busy') => state[key],
    put: async (key: 'run_id' | 'busy', value: number | string) => { state[key] = value; },
    delete: async (key: 'run_id' | 'busy') => { const present = state[key] !== undefined; delete state[key]; return present; },
    getAlarm: async () => state.alarm as number | null,
    setAlarm: async (at: number) => { state.alarm = at; },
    deleteAlarm: async () => { state.alarm = null; },
  } as unknown as ObjectSlot;
  return { slot, state };
}

describe('CC8 U2b2 — crash before wake, recovery and step budget', () => {
  it('rescues the original D1 run after losing the alarm and does not spend model steps while waiting', async () => {
    await ensureSchema(db);
    const cycle = 'u2b2-crash-' + crypto.randomUUID();
    await insertCycleRow(db, cycle, 'P6');
    await insertPhaseDefinition(db, cycle, 'P6', []);
    await insertTaskRow(db, { cycle, taskId: 'resume', owner: 'u2b2-crash-owner',
      reviewer: 'u2b2-crash-reviewer', tester: 'u2b2-crash-tester' });
    const runId = 'u2b2-crash-run-' + crypto.randomUUID(), now = Math.floor(Date.now()/1000);
    expect((await createRun(db, { runId, cycleId: cycle, participantId: 'u2b2-crash-owner',
      taskId: 'resume', taskKind: 'implement', prompt: 'Ask, wait, resume',
      maxSteps: 8, maxTokens: 48_000, maxCostCents: 0, deadlineAt: now + 1800, now })).created).toBe(true);
    let calls = 0;
    const model: ModelClient = { async complete() {
      calls++;
      return { output: calls === 1
        ? { text: 'Asking reviewer', tool_calls: [{ id: 'ask', name: 'store_ask',
          args: { question: 'Which criterion?', to: 'u2b2-crash-reviewer', task: 'resume' } }] }
        : { text: 'Completed after actual reply', tool_calls: [] },
        usage: { tokens: 20, cost_cents: 0 } };
    } };
    const tools = createReadToolHost({ db, repository: null, github: null, storeWrites: true });
    let clock = now + 1;
    const doState = u2b2Slot();
    const deps = { db, env: { AGENT_RUNS_ENABLED: 'true' }, slot: doState.slot,
      ownsLease: (_: string) => true, nowMs: () => clock*1000,
      engine: () => ({ model, tools, now: () => clock }),
      workerId: () => 'u2b2-restarted-object' };
    const readSteps = async () => (await db.prepare('SELECT steps_done FROM agent_runs WHERE run_id=?1')
      .bind(runId).first<{ steps_done: number }>())!.steps_done;

    expect((await runStep(db, runId, {model,tools,now:()=>clock,workerId:'initial-worker'})).outcome).toBe('stepped');
    expect(await readSteps()).toBe(1);
    // Mimic a crash after store_ask completed but BEFORE the alarm was armed.
    await db.prepare("UPDATE agent_run_wakeups SET status='delivered' WHERE run_id=?1").bind(runId).run();
    expect((await db.prepare('SELECT next_alarm_at FROM agent_run_alarms WHERE run_id=?1')
      .bind(runId).first<{ next_alarm_at: number|null }>())?.next_alarm_at ?? null).toBeNull();
    clock = now + 50;
    const wake = (leaseKey: string, id: string) => objectWake(deps, id, leaseKey);
    expect(await rescueStalledRuns(db, { now:clock, wake })).toBe(1);
    expect(doState.state.run_id).toBe(runId);
    expect(typeof doState.state.alarm).toBe('number');
    // A real DO consumes the alarm before invoking the handler.
    await doState.slot.deleteAlarm();
    expect((await objectAlarm(deps)).outcome).toBe('waiting_for_reply');
    expect(calls).toBe(1);
    expect(await readSteps()).toBe(1);
    const alarm = doState.state.alarm as number;
    expect(alarm).toBeGreaterThan(clock*1000);

    // A second process eviction after the wait was scheduled: D1 alarm remains
    // the source of truth. Recover only after its grace window, not prematurely.
    delete doState.state.run_id;
    doState.state.alarm = null;
    clock = Math.ceil(alarm/1000) + 121;
    expect(await rescueStalledRuns(db, { now:clock, wake })).toBe(1);
    await doState.slot.deleteAlarm();
    expect((await objectAlarm(deps)).outcome).toBe('waiting_for_reply');
    expect(calls).toBe(1);
    expect(await readSteps()).toBe(1);
    const store = new CollabStore(db);
    const ask = await db.prepare("SELECT seq FROM events WHERE cycle_id=?1 AND type='clarify.ask' ORDER BY seq DESC LIMIT 1")
      .bind(cycle).first<{ seq:number }>();
    expect((await store.appendEvent({ cycle_id:cycle, participant_id:'u2b2-crash-reviewer',
      type:'clarify.answer', expected_rev:await store.currentRevision(cycle),
      payload_json:JSON.stringify({ask_seq:ask!.seq,answer:'Use acceptance A'}),
      op_id:'u2b2-crash-reviewer:'+cycle+':reply:1' })).status).toBe('applied');
    clock += 121; // Existing D1 alarm, no separate model or fresh run.
    await doState.slot.deleteAlarm();
    expect((await objectAlarm(deps)).outcome).toBe('completed');
    expect(calls).toBe(2);
    expect(await readSteps()).toBe(2);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE run_id=?1').bind(runId)
      .first<{n:number}>())!.n).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM agent_run_effects WHERE run_id=?1 AND tool='store_ask'")
      .bind(runId).first<{n:number}>())!.n).toBe(1);
  });
});

describe('CC8 U2b2 — bounded long wait escalation and lease slot release', () => {
  it('preserves steps, emits a typed owner diagnostic at deadline and frees the DO slot', async () => {
    await ensureSchema(db);
    const cycle = 'u2b2-long-' + crypto.randomUUID();
    await insertCycleRow(db,cycle,'P6');
    await insertPhaseDefinition(db,cycle,'P6',[]);
    await insertTaskRow(db,{cycle,taskId:'longwait',owner:'u2b2-long-owner',
      reviewer:'u2b2-long-reviewer',tester:'u2b2-long-tester'});
    const runId='u2b2-long-run-'+crypto.randomUUID(), now=Math.floor(Date.now()/1000);
    expect((await createRun(db,{runId,cycleId:cycle,participantId:'u2b2-long-owner',
      taskId:'longwait',taskKind:'implement',prompt:'Request human review',
      maxSteps:8,maxTokens:48000,maxCostCents:0,deadlineAt:now+400,now})).created).toBe(true);
    let calls=0;
    const model:ModelClient={async complete(){
      calls++;
      return {output:{text:'Ask for review',tool_calls:[{id:'ask',name:'store_ask',
        args:{question:'Please review',to:'u2b2-long-reviewer',task:'longwait'}}]},
        usage:{tokens:10,cost_cents:0}};
    }};
    const tools=createReadToolHost({db,repository:null,github:null,storeWrites:true});
    let clock=now+1;
    const {slot,state}=u2b2Slot();
    const deps={db,env:{AGENT_RUNS_ENABLED:'true'},slot,ownsLease:(_:string)=>true,
      nowMs:()=>clock*1000,engine:()=>({model,tools,now:()=>clock}),
      workerId:()=> 'u2b2-long-worker'};
    expect((await runStep(db,runId,{model,tools,now:()=>clock,workerId:'first'})).outcome).toBe('stepped');
    const original=(await db.prepare('SELECT steps_done,tokens_used FROM agent_runs WHERE run_id=?1')
      .bind(runId).first<{steps_done:number;tokens_used:number}>())!;
    expect(original.steps_done).toBe(1);
    for (const delta of [2,121,241,360]) {
      clock=now+delta;
      expect((await runStep(db,runId,{model,tools,now:()=>clock,workerId:'retry'})).outcome)
        .toBe('waiting_for_reply');
      expect((await db.prepare('SELECT steps_done,tokens_used FROM agent_runs WHERE run_id=?1')
        .bind(runId).first<{steps_done:number;tokens_used:number}>())).toEqual(original);
    }
    // Keep the original active work slot so objectAlarm can release it after
    // deadline. No reply is provided; no model call can proceed.
    clock=now+390;
    const lease=(await db.prepare('SELECT lease_key FROM agent_runs WHERE run_id=?1')
      .bind(runId).first<{lease_key:string}>())!.lease_key;
    expect((await objectWake(deps,runId,lease)).accepted).toBe(true);
    clock=now+401;
    await slot.deleteAlarm();
    expect((await objectAlarm(deps)).outcome).toBe('deadline');
    expect(calls).toBe(1);
    const stopped=(await db.prepare('SELECT status,stop_reason,steps_done,tokens_used FROM agent_runs WHERE run_id=?1')
      .bind(runId).first<{status:string;stop_reason:string;steps_done:number;tokens_used:number}>())!;
    expect(stopped).toMatchObject({...original,status:'deadline',stop_reason:'clarification_wait_expired'});
    const escalations=(await db.prepare("SELECT COUNT(*) AS n FROM agent_run_journal WHERE run_id=?1 AND kind='clarification_escalation'")
      .bind(runId).first<{n:number}>())!;
    expect(escalations.n).toBe(1);
    expect(state.run_id).toBeUndefined(); // finish/forget releases the DO slot
    expect((await db.prepare('SELECT next_alarm_at FROM agent_run_alarms WHERE run_id=?1')
      .bind(runId).first<{next_alarm_at:number|null}>())?.next_alarm_at).toBeNull();
    expect((await runStep(db,runId,{model,tools,now:()=>now+500,workerId:'late'})).outcome).toBe('deadline');
    expect(calls).toBe(1);
    // Original terminal run no longer blocks a separately authorized handover.
    expect((await createRun(db,{runId:runId+'-new',cycleId:cycle,participantId:'u2b2-long-owner',
      taskId:'longwait',taskKind:'implement',prompt:'New explicit authorized continuation',
      maxSteps:2,maxTokens:100,maxCostCents:0,deadlineAt:now+900,now:now+500})).created).toBe(true);
  });
});
