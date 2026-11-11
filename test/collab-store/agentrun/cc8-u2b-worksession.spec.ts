import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { durableWakeWorthy, CollabStore } from '../../../src/collab-store/store/collab-store';
import { answerPromptWithServerPacket, ANSWER_CYCLE_PACKET_MAX_BYTES } from '../../../src/collab-store/agentrun/unified-run-packet';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
async function fixture() {
  await ensureSchema(db);
  const cycle = 'u2b-' + crypto.randomUUID();
  await db.prepare("INSERT INTO cycles (cycle_id, project, phase, revision, status) VALUES (?1, 'rfkevin/github-mcp', 'P6', 1, 'open')")
    .bind(cycle).run();
  for (const task of ['fix-one','fix-two']) {
    await db.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
      "VALUES (?1, ?2, 'u2b-agent', 'u2b-reviewer', 'u2b-tester', 'in_progress', '[]', '', '', 1)",
    ].join(' ')).bind(task, cycle).run();
  }
  const memory = (s: string, scope: string, value: string) => db.prepare([
    'INSERT INTO memory_entries (id,version,scope,kind,text,evidence_refs,confidence,status,',
    'author_pid,reviewer_pid,supersedes,uses,last_used_rev,expires_rev)',
    "VALUES(?1,1,?2,'fact',?3,'["u2b-proof"]','observed','active','u2b-agent','u2b-reviewer',NULL,0,NULL,NULL)",
  ].join(' ')).bind(cycle+s,scope,value).run();
  await memory('-own','participant:u2b-agent','PRIVATE_OWN_U2B');
  await memory('-other','participant:u2b-other','PRIVATE_OTHER_U2B');
  await memory('-common','common','COMMON_U2B');
  await memory('-task','task:fix-one','TASK_ONLY_U2B');
  return cycle;
}
describe('CC8 U2b — server context for taskless answer and durable wake', () => {
  it('never infers a task among two assignments and filters C4 memory', async () => {
    const cycle = await fixture();
    const prompt = await answerPromptWithServerPacket(db, { cycleId: cycle, participantId: 'u2b-agent' }, 'Question 1');
    expect(prompt).toContain('Question 1');
    expect(prompt).toContain('"task":null');
    expect(prompt).toContain('"role_card":null');
    expect(prompt).toContain('PRIVATE_OWN_U2B');
    expect(prompt).toContain('COMMON_U2B');
    expect(prompt).not.toContain('PRIVATE_OTHER_U2B');
    expect(prompt).not.toContain('TASK_ONLY_U2B');
    const start = prompt.indexOf('{"header"');
    expect(start).toBeGreaterThan(0);
    const end = prompt.indexOf('\nFIN DOSSIER CC8',start);
    expect(new TextEncoder().encode(prompt.slice(start,end)).length).toBeLessThanOrEqual(ANSWER_CYCLE_PACKET_MAX_BYTES);
  });
  it('fails closed on unknown cycle', async () => {
    await expect(answerPromptWithServerPacket(db, { cycleId: 'unknown-u2b', participantId: 'u2b-agent' }, 'Q'))
      .rejects.toThrow('Cycle absent ou fermé');
  });
  it('queues valid clarify.answer in the same atomic CAS outbox, without duplicate wake', async () => {
    const cycle = await fixture();
    const store = new CollabStore(db);
    const ask = await store.appendEvent({cycle_id:cycle,participant_id:'u2b-agent',type:'clarify.ask',expected_rev:1,
      payload_json:JSON.stringify({question:'Besoin d’un avis',to:'u2b-reviewer'}),
      op_id:'u2b-agent:'+cycle+':ask:1'});
    expect(ask.status).toBe('applied');
    if (ask.status !== 'applied') return;
    const answerArgs = { cycle_id:cycle, participant_id:'u2b-reviewer',type:'clarify.answer' as const,
      expected_rev:2,payload_json:JSON.stringify({ask_seq:ask.event.seq,answer:'Décision vérifiée'}),
      op_id:'u2b-reviewer:'+cycle+':answer:1' };
    const answer=await store.appendEvent(answerArgs);
    expect(answer.status).toBe('applied');
    const rows=(await db.prepare("SELECT event_type FROM agent_event_wake_intents WHERE cycle_id=?1 ORDER BY event_key")
      .bind(cycle).all<{event_type:string}>()).results;
    expect(rows.filter(x=>x.event_type==='clarify.answer')).toHaveLength(1);
    expect((await store.appendEvent(answerArgs)).status).toBe('duplicate');
    const replay=(await db.prepare("SELECT COUNT(*) AS n FROM agent_event_wake_intents WHERE cycle_id=?1 AND event_type='clarify.answer'")
      .bind(cycle).first<{n:number}>())!;
    expect(replay.n).toBe(1);
  });
  it('rejects invalid wake payloads', () => {
    expect(durableWakeWorthy('clarify.answer','{"ask_seq":3,"answer":"ok"}')).toBe(true);
    expect(durableWakeWorthy('clarify.answer','{"ask_seq":"3"}')).toBe(false);
    expect(durableWakeWorthy('clarify.answer','{"ask_seq":0}')).toBe(false);
    expect(durableWakeWorthy('clarify.answer','invalid')).toBe(false);
  });
});
