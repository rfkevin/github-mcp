import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, createReadToolHost, type ModelClient, type AgentMessage } from '../../../src/collab-store/agentrun';
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
