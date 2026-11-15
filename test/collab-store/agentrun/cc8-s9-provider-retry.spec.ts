import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { planAgentRuns } from '../../../src/collab-store/agentrun/plan';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { PLAN_MODEL } from './plan-model';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 2_000_000_000;
let seq = 0;

describe('CC8 S9 — reprise terminale uniquement sur nouvelle attribution explicite', () => {
  it('ne réessaie pas model_permanent sans nouvelle décision autorisée; une attribution relance une seule fois', async () => {
    await ensureSchema(db);
    const suffix = ++seq;
    const cycle = '0000-0000-s9-retry-' + suffix;
    const task = 'retry-author';
    const author = 's9-retry-author-' + suffix;
    const coordinator = 's9-retry-coordinator-' + suffix;
    await insertCycleRow(db, cycle, 'P6');
    await insertPhaseDefinition(db, cycle, 'P6', []);
    await insertTaskRow(db, { taskId: task, cycle, owner: author, reviewer: 'vibe', tester: 'grok' });
    await db.prepare("INSERT INTO participants(participant_id,display_label,status) VALUES(?1,?1,'active')")
      .bind(coordinator).run();
    await db.prepare("INSERT INTO coordinators(participant_id,status,event_seq,updated_at) VALUES(?1,'active',NULL,?2)")
      .bind(coordinator,T).run();
    const config = { ...PLAN_MODEL, AGENT_RUN_PARTICIPANTS: author, AGENT_RUN_GITHUB_WRITES: 'true' };
    const created = await planAgentRuns(db, config, { now:T });
    expect(created.created).toBe(1);
    const first = await db.prepare("SELECT run_id FROM agent_runs WHERE cycle_id=?1 AND task_id=?2")
      .bind(cycle,task).first<{run_id:string}>();
    expect(first?.run_id).toBeTruthy();
    await db.prepare("UPDATE agent_runs SET status='failed',stop_reason='model_permanent: provider chain exhausted',updated_at=?2 WHERE run_id=?1")
      .bind(first!.run_id,T+1).run();

    // The older wake alone, even after an arbitrary delay, cannot retry.
    expect((await planAgentRuns(db,config,{now:T+1000})).created).toBe(0);

    const wake = async (key:string, at:number, issuer=coordinator, participant=author) => {
      await insertEventRow(db,{cycle,type:'checkpoint',participant:issuer,role:'coordinator',
        payload:{state:'WORKSESSION_ASSIGNED',task,participant},key:cycle+':'+key});
      await db.prepare('UPDATE events SET at=?2 WHERE idempotency_key=?1').bind(cycle+':'+key,at).run();
    };
    await wake('wrong-agent',T+1001,coordinator,'other');
    await wake('not-coordinator',T+1002,'unapproved',author);
    expect((await planAgentRuns(db,config,{now:T+1003})).created).toBe(0);

    // A new assignment from an active coordinator, after the failed run, is
    // sufficient to retry once without creating another task or branch.
    await wake('legitimate',T+1004);
    expect((await planAgentRuns(db,config,{now:T+1005})).created).toBe(1);
    expect((await planAgentRuns(db,config,{now:T+1005})).created).toBe(0);
    const runs = (await db.prepare("SELECT run_id,status FROM agent_runs WHERE cycle_id=?1 AND task_id=?2 ORDER BY created_at")
      .bind(cycle,task).all<{run_id:string;status:string}>()).results;
    expect(runs).toHaveLength(2);
    expect(runs[1].run_id).not.toBe(first!.run_id);
    await db.prepare("UPDATE agent_runs SET status='failed',stop_reason='model_permanent: provider unavailable',updated_at=?2 WHERE run_id=?1")
      .bind(runs[1].run_id,T+1006).run();
    expect((await planAgentRuns(db,config,{now:T+2000})).created).toBe(0);
  });});
