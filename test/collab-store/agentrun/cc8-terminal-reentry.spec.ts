import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { planAgentRuns, attemptRunId, answerAttemptRunId, terminalRunMayRetry } from '../../../src/collab-store/agentrun/plan';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { PLAN_MODEL } from './plan-model';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 2_000_000_000;
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
let serial = 0;
type Kind = 'answer' | 'review' | 'test' | 'implement';

async function seed(kind: Kind) {
  await ensureSchema(db);
  const id = ++serial;
  const cycle = '0000-s9-terminal-' + id;
  const task = 'retry';
  const coordinator = 'terminal-coord-' + id;
  const author = 'terminal-author-' + id;
  const reviewer = 'terminal-review-' + id;
  const tester = 'terminal-tester-' + id;
  const participant = kind === 'review' ? reviewer : kind === 'test' || kind === 'answer' ? tester : author;
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: task, cycle, owner: author, reviewer, tester });
  await db.prepare("INSERT INTO participants(participant_id,display_label,status) VALUES(?1,?1,'active')")
    .bind(coordinator).run();
  await db.prepare("INSERT INTO coordinators(participant_id,status,event_seq,updated_at) VALUES(?1,'active',NULL,?2)")
    .bind(coordinator,T).run();
  let subject = kind === 'implement' ? 'none' : HEAD + '..' + BASE;
  if (kind === 'review' || kind === 'test') {
    await insertEventRow(db, { cycle, type: 'evidence.add', participant: author, role: 'owner',
      payload: { task, source: 'github', pr: 348, head: HEAD, base: BASE, state: 'SUBMITTED' },
      key: cycle + ':submission' });
  } else if (kind === 'answer') {
    await insertEventRow(db, { cycle, type: 'clarify.ask', participant: author, role: '',
      payload: { question: 'Diagnostic exact ?', to: tester }, key: cycle + ':question' });
    const ask = await db.prepare('SELECT seq FROM events WHERE idempotency_key=?1').bind(cycle+':question')
      .first<{seq:number}>();
    subject = 'ask#' + ask!.seq;
  }
  const config = { ...PLAN_MODEL, AGENT_RUN_PARTICIPANTS: participant, AGENT_RUN_GITHUB_WRITES: 'true' };
  expect((await planAgentRuns(db, config, { now: T })).created).toBe(1);
  const runId = async (attempt: number) => kind === 'answer'
    ? answerAttemptRunId(cycle,participant,Number(subject.slice(4)),'P6',0,attempt)
    : attemptRunId(kind,cycle,participant,task,subject,'P6',0,attempt);
  const first = await runId(1);
  const present = await db.prepare('SELECT run_id FROM agent_runs WHERE run_id=?1').bind(first).first();
  expect(present).not.toBeNull();
  return { kind, cycle, task: kind === 'answer' ? '' : task, participant, coordinator, subject, config, runId, first };
}

type Fixture = Awaited<ReturnType<typeof seed>>;
async function stop(runId:string, status:string, reason:string, now:number) {
  await db.prepare('UPDATE agent_runs SET status=?2,stop_reason=?3,updated_at=?4 WHERE run_id=?1')
    .bind(runId,status,reason,now).run();
}
async function permit(f:Fixture, prior:string, at:number, fields:Record<string,string> = {}, by?:string) {
  const key=f.cycle+':permit:'+crypto.randomUUID();
  await insertEventRow(db,{cycle:f.cycle,type:'checkpoint',participant:by??f.coordinator,role:'coordinator',
    payload:{state:'WORKSESSION_RETRY_AUTHORIZED',task:f.task,participant:f.participant,
      kind:f.kind,subject:f.subject,failed_run_id:prior,...fields},key});
  await db.prepare('UPDATE events SET at=?2 WHERE idempotency_key=?1').bind(key,at).run();
}
const plan=(f:Fixture,now:number)=>planAgentRuns(db,f.config,{now});

describe('CC8 — matrice des sorties et reprise explicite du parcours unique',()=>{
  it.each(['answer','review','test','implement'] as const)
  ('%s : un échec incomplete_final requiert un checkpoint signé et exact, jamais une boucle', async kind=>{
    const f=await seed(kind);
    await stop(f.first,'failed','incomplete_final:store_effect_missing',T+1);
    expect((await plan(f,T+15)).created).toBe(0);
    await permit(f,f.first,T+16,{subject:'wrong-subject'});
    expect((await plan(f,T+17)).created).toBe(0);
    await permit(f,f.first,T+18,{failed_run_id:'wrong-run'});
    expect((await plan(f,T+19)).created).toBe(0);
    await permit(f,f.first,T+20,{},'unapproved-coordinator');
    expect((await plan(f,T+21)).created).toBe(0);
    await permit(f,f.first,T+22);
    expect((await plan(f,T+23)).created).toBe(1);
    expect((await plan(f,T+24)).created).toBe(0);
    const next=await f.runId(2);
    expect(await db.prepare('SELECT run_id FROM agent_runs WHERE run_id=?1').bind(next).first()).not.toBeNull();
    await stop(next,'failed','blocked:no_progress:repeated_denial',T+25);
    expect((await plan(f,T+26)).created).toBe(0); // old checkpoint cannot rearm attempt 3
    await permit(f,next,T+27);
    expect((await plan(f,T+28)).created).toBe(1);
    expect((await plan(f,T+29)).created).toBe(0);
  });

  it.each([
    ['failed','model_permanent: HTTP 403'], ['failed','model_permanent: MODEL_ROUTE_REFUSED'],
    ['halted','individual_stop:operator'], ['halted','halted'],['preempted','preempted'],
    ['needs_reconcile','effect_outcome_unknown'],['cost_limit','cost_limit'],
    ['deadline','deadline'],['step_limit','step_limit'],['token_limit','token_limit'],
    ['completed','final'],
  ])('ne réarme pas %s / %s même avec checkpoint',async (status,reason)=>{
    const f=await seed('review');
    await stop(f.first,status,reason,T+1);
    await permit(f,f.first,T+4);
    expect((await plan(f,T+5)).created).toBe(0);
  });

  it.each([
    ['failed','incomplete_final:store_effect_missing',true],
    ['failed','incomplete_final:github_evidence_missing',true],
    ['failed','blocked:no_progress:repeated_denial',true],
    ['failed','guided_stop:preparation_incomplete',true],
    ['failed','guided_preparation_violation:no_tool_call',true],
    ['failed','guided_handover_violation:tool_not_offered',true],
    ['failed','step_attempts_exhausted',true],
    ['failed','model_permanent: HTTP 401',false],
    ['failed','model_permanent: Budget gratuit du jour insuffisant',false],
    ['failed','untyped_error:abc',false],
    ['halted','incomplete_final:store_effect_missing',false],
    ['needs_reconcile','effect_outcome_unknown',false],
  ])('politique typée %s / %s -> %s',(status,reason,expected)=>{
    expect(terminalRunMayRetry(status,reason)).toBe(expected);
  });
});
