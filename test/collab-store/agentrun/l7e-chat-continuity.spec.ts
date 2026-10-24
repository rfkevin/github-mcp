import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, type ModelOutput, type ToolHost } from '../../../src/collab-store/agentrun';
import {
  listRunsForParticipant,
  runSummaryForParticipant,
  preemptOwnRun,
  releaseOwnRun,
  listRunsForOwner,
} from '../../../src/collab-store/agentrun/chat-continuity';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-5 l7e — continuité chat : list/preempt/release scoped au participant + fencing.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;
const T0 = 1_900_100_000;

function emptyHost(): ToolHost {
  return {
    spec: () => null,
    list: () => [],
    async execute() { return null; },
  };
}

function modelOnce(text = 'ok'): { complete: () => Promise<{ output: ModelOutput; usage: { tokens: number; cost_cents: number } }> } {
  return {
    async complete() {
      return { output: { text, tool_calls: [] }, usage: { tokens: 10, cost_cents: 0 } };
    },
  };
}

async function makeRun(participantId: string, taskId = 't1') {
  await ensureSchema(db);
  const id = ++n;
  const input = {
    runId: 'l7e-run-' + id,
    cycleId: 'l7e-cycle-' + id,
    participantId,
    taskId,
    taskKind: 'answer',
    prompt: 'réponds',
    maxSteps: 4,
    maxTokens: 10_000,
    maxCostCents: 0,
    deadlineAt: T0 + 3600,
    now: T0 + id,
  };
  const created = await createRun(db, input);
  expect(created.created).toBe(true);
  return input;
}

describe('CC-5 l7e — continuité chat', () => {
  it('liste uniquement les runs du participant (CR-C)', async () => {
    const a = await makeRun('grok');
    await makeRun('vibe');
    const mine = await listRunsForParticipant(db, 'grok');
    expect(mine.some(r => r.run_id === a.runId)).toBe(true);
    expect(mine.every(r => r.run_id.startsWith('l7e-run-'))).toBe(true);
    // aucune fuite vibe dans la liste grok
    const ids = mine.map(r => r.run_id);
    const vibeRuns = await listRunsForParticipant(db, 'vibe');
    for (const v of vibeRuns) expect(ids).not.toContain(v.run_id);
  });

  it('résumé refusé pour un run étranger', async () => {
    const foreign = await makeRun('claude');
    const denied = await runSummaryForParticipant(db, 'grok', foreign.runId);
    expect(denied).toBeNull();
    const ok = await runSummaryForParticipant(db, 'claude', foreign.runId);
    expect(ok?.status).toBeTruthy();
  });

  it('préemption chat PENDANT une étape en vol (A4/A8) : outcome preempted, 0 effet, bail chat, release sans nouvelle génération', async () => {
    const input = await makeRun('grok', 'preempt-task');
    let preemptedGeneration = 0;
    const model = {
      async complete() {
        // Préemption pendant l'appel modèle (étape en vol), pas avant runStep.
        const gen = await preemptOwnRun(db, {
          participantId: 'grok',
          cycleId: input.cycleId,
          taskId: input.taskId,
          now: T0 + 55,
          holdSeconds: 600,
        });
        expect(gen.ok).toBe(true);
        if (gen.ok) preemptedGeneration = gen.generation;
        return {
          output: { text: 'outil', tool_calls: [{ id: 't1', name: 'write_note', args: { text: 'x' } }] },
          usage: { tokens: 10, cost_cents: 0 },
        };
      },
    };
    const host: ToolHost = {
      spec: (_k, name) => (name === 'write_note' ? { name, effect: 'write' } : null),
      list: () => ['write_note'],
      async execute() { return { written: true }; },
    };
    const step = await runStep(db, input.runId, {
      model,
      tools: host,
      now: () => T0 + 60,
      workerId: 'api-w',
    });
    expect(step.outcome).toBe('preempted');
    const row = await db.prepare('SELECT status, steps_done FROM agent_runs WHERE run_id = ?1').bind(input.runId)
      .first<{ status: string; steps_done: number }>();
    expect(row?.status).toBe('preempted');
    expect(row?.steps_done).toBe(0);
    const effects = await db.prepare('SELECT COUNT(*) AS c FROM agent_run_effects WHERE run_id = ?1').bind(input.runId)
      .first<{ c: number }>();
    expect(Number(effects?.c ?? 0)).toBe(0);
    const fence = await db.prepare(
      "SELECT holder, generation FROM agent_fences WHERE lease_key = (SELECT lease_key FROM agent_runs WHERE run_id = ?1)",
    ).bind(input.runId).first<{ holder: string; generation: number }>();
    expect(fence?.holder).toBe('chat');
    expect(fence?.generation).toBe(preemptedGeneration);
    const rel = await releaseOwnRun(db, {
      participantId: 'grok',
      cycleId: input.cycleId,
      taskId: input.taskId,
      now: T0 + 70,
    });
    expect(rel).toEqual({ ok: true });
    const after = await db.prepare(
      "SELECT holder, generation FROM agent_fences WHERE lease_key = (SELECT lease_key FROM agent_runs WHERE run_id = ?1)",
    ).bind(input.runId).first<{ holder: string; generation: number }>();
    expect(after?.holder).toBe('none');
    expect(after?.generation).toBe(preemptedGeneration);
  });

  it('préemption refusée si pas propriétaire', async () => {
    const foreign = await makeRun('vibe', 'other');
    const denied = await preemptOwnRun(db, {
      participantId: 'grok',
      cycleId: foreign.cycleId,
      taskId: foreign.taskId,
      now: T0 + 70,
    });
    expect(denied).toEqual({ ok: false, reason: 'not_owner' });
  });

  it('release chat après préemption', async () => {
    const input = await makeRun('grok', 'release-task');
    await preemptOwnRun(db, {
      participantId: 'grok',
      cycleId: input.cycleId,
      taskId: input.taskId,
      now: T0 + 80,
    });
    const rel = await releaseOwnRun(db, {
      participantId: 'grok',
      cycleId: input.cycleId,
      taskId: input.taskId,
      now: T0 + 90,
    });
    expect(rel).toEqual({ ok: true });
  });

  it('owner voit tous les participants (lecture seule)', async () => {
    await makeRun('grok');
    await makeRun('vibe');
    const all = await listRunsForOwner(db, 50);
    expect(all.length).toBeGreaterThan(0);
    expect(all.some(r => r.participant_id === 'grok' || r.participant_id === 'vibe')).toBe(true);
  });
});
