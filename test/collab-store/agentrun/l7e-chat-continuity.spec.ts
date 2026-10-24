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

  it('préemption chat pendant une étape : écritures API ensuite busy/preempted', async () => {
    const input = await makeRun('grok', 'preempt-task');
    const gen = await preemptOwnRun(db, {
      participantId: 'grok',
      cycleId: input.cycleId,
      taskId: input.taskId,
      now: T0 + 50,
      holdSeconds: 600,
    });
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    expect(gen.generation).toBeGreaterThan(0);
    // L'API ne peut plus avancer sous le bail chat
    const step = await runStep(db, input.runId, {
      model: modelOnce(),
      tools: emptyHost(),
      now: () => T0 + 60,
      workerId: 'api-w',
    });
    expect(['busy', 'preempted', 'unknown_run', 'halted']).toContain(step.outcome);
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
