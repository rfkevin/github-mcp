import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createReadToolHost } from '../../../src/collab-store/agentrun/read-tools';
import { createRun, runStep, type ModelClient, type ModelOutput } from '../../../src/collab-store/agentrun/engine';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertEventRow, insertPhaseDefinition } from '../a0-helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const NOW = 1_970_000_000;

async function seeded(label: string) {
  await ensureSchema(db);
  const cycle = '0000-s9-answer-' + label + '-' + crypto.randomUUID();
  const key = cycle + ':ask';
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertEventRow(db, {
    cycle, type: 'clarify.ask', participant: 's9-asker', role: '',
    payload: { question: 'Provide a technical answer?', to: 's9-responder' }, key,
  });
  const seq = (await db.prepare('SELECT seq FROM events WHERE idempotency_key=?1')
    .bind(key).first<{ seq: number }>())!.seq;
  const runId = 's9-answer-' + crypto.randomUUID();
  expect((await createRun(db, {
    runId, cycleId: cycle, participantId: 's9-responder', taskId: '',
    taskKind: 'answer', prompt: `Question #${seq} du cycle ${cycle}. Answer accurately.`,
    maxSteps: -1, maxTokens: -1, maxCostCents: 0, deadlineAt: NOW + 86_400, now: NOW,
  })).created).toBe(true);
  return { cycle, runId, seq };
}

function modelFor(outputs: ModelOutput[]) {
  let count = 0;
  const offered: string[][] = [];
  const prompts: string[] = [];
  const model: ModelClient = { async complete(input) {
    offered.push([...input.tools]);
    prompts.push(input.messages.at(-1)?.content ?? '');
    return { output: outputs[count++] ?? { text: 'unexpected call', tool_calls: [] },
      usage: { tokens: 10, cost_cents: 0 } };
  } };
  return { model, offered, prompts, count: () => count };
}
async function answers(cycle: string) {
  return (await db.prepare("SELECT payload_json FROM events WHERE cycle_id=?1 AND type='clarify.answer'")
    .bind(cycle).all<{ payload_json: string }>()).results;
}
const host = () => createReadToolHost({ db, repository: null, github: null, storeWrites: true });

describe('CC8 S9: answer without store_answer may recover exactly once', () => {
  it('a text-only final gets one store_answer-only turn and completes on real D1 proof', async () => {
    const q = await seeded('success');
    const m = modelFor([
      { text: 'plain unposted text', tool_calls: [] },
      { text: '', tool_calls: [{ id: 'a', name: 'store_answer',
        args: { ask_seq: q.seq, answer: 'Grounded answer' } }] },
    ]);
    const deps = { model: m.model, tools: host(), now: () => NOW, workerId: 's9-w1' };
    expect((await runStep(db, q.runId, deps)).outcome).toBe('stepped');
    expect(await answers(q.cycle)).toHaveLength(0);
    expect((await runStep(db, q.runId, deps)).outcome).toBe('completed');
    expect((await runStep(db, q.runId, deps)).outcome).toBe('completed');
    expect(m.count()).toBe(2);
    expect(m.offered[1]).toEqual(['store_answer']);
    expect(m.prompts[1]).toContain('ONLY corrective turn');
    expect((await answers(q.cycle)).map(r => JSON.parse(r.payload_json)))
      .toEqual([{ ask_seq: q.seq, answer: 'Grounded answer' }]);
  });
  it('two text-only finals fail without a third call or fabricated D1 event', async () => {
    const q = await seeded('double-miss');
    const m = modelFor([
      { text: 'first unposted', tool_calls: [] }, { text: 'second unposted', tool_calls: [] },
    ]);
    const deps = { model: m.model, tools: host(), now: () => NOW, workerId: 's9-w2' };
    expect((await runStep(db, q.runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, q.runId, deps)).outcome).toBe('failed');
    expect((await runStep(db, q.runId, deps)).outcome).toBe('failed');
    expect(m.count()).toBe(2);
    expect(await answers(q.cycle)).toHaveLength(0);
    expect(await db.prepare('SELECT status,stop_reason FROM agent_runs WHERE run_id=?1')
      .bind(q.runId).first()).toEqual({
      status: 'failed', stop_reason: 'incomplete_final:answer_not_published_after_recovery',
    });
  });
  it('an invalid ask_seq on the last store_answer turn fails closed', async () => {
    const q = await seeded('wrong-ask');
    const m = modelFor([
      { text: 'unposted', tool_calls: [] },
      { text: '', tool_calls: [{ id: 'wrong', name: 'store_answer',
        args: { ask_seq: q.seq + 99999, answer: 'wrong question' } }] },
    ]);
    const deps = { model: m.model, tools: host(), now: () => NOW, workerId: 's9-w3' };
    expect((await runStep(db, q.runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, q.runId, deps)).outcome).toBe('failed');
    expect(m.count()).toBe(2);
    expect(await answers(q.cycle)).toHaveLength(0);
  });
  it('without store_answer permissions a text-only final cannot gain a recovery turn', async () => {
    const q = await seeded('no-write-right');
    const m = modelFor([{ text: 'unposted', tool_calls: [] }]);
    expect((await runStep(db, q.runId, {
      model: m.model, tools: createReadToolHost({ db, repository: null, github: null, storeWrites: false }),
      now: () => NOW, workerId: 's9-w4',
    })).outcome).toBe('failed');
    expect(m.count()).toBe(1);
    expect(await answers(q.cycle)).toHaveLength(0);
  });
});
