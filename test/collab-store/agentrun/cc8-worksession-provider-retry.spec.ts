import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, ModelCallError, STEP_TIMEOUT_S, type EngineDeps } from '../../../src/collab-store/agentrun/engine';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

describe('CC8 WorkSession — reprise autonome après interruption du fournisseur API', () => {
  it('503 puis succès : conserve la même tâche, son run_id et ses étapes, sans plafond de tentatives', async () => {
    await ensureSchema(db);
    const id = 'cc8-retry-' + crypto.randomUUID();
    const clock = { now: 2_000_000_000 };
    const created = await createRun(db, {
      runId: id, cycleId: 'cc8-retry-' + crypto.randomUUID(), participantId: 'cc8-model-retry',
      taskId: 'session', taskKind: 'planning', prompt: 'Résoudre la tâche, puis terminer.',
      maxSteps: -1, maxTokens: -1, maxCostCents: 0,
      deadlineAt: clock.now + 1, now: clock.now,
    });
    expect(created.created).toBe(true);
    let calls = 0;
    const deps: EngineDeps = {
      model: { complete: async () => {
        calls++;
        if (calls === 1) throw new ModelCallError('HTTP 503 Service Unavailable');
        return { output: { text: 'Mission accomplie.', tool_calls: [] }, usage: { tokens: 6, cost_cents: 0 } };
      } },
      tools: { spec: () => null, list: () => [], execute: async () => null },
      now: () => clock.now,
      workerId: 'retry-agent',
    };
    expect((await runStep(db, id, deps)).outcome).toBe('retry');
    const interrupted = await db.prepare('SELECT status, steps_done FROM agent_runs WHERE run_id=?1').bind(id)
      .first<{ status: string; steps_done: number }>();
    expect(interrupted).toMatchObject({ status: 'running', steps_done: 0 });

    clock.now += 29;
    expect((await runStep(db, id, deps)).outcome).toBe('busy');
    expect(calls).toBe(1);

    clock.now += 2;
    const resumed = await runStep(db, id, deps);
    expect(resumed.outcome).toBe('completed');
    expect(calls).toBe(2);
    const stored = await db.prepare('SELECT status, steps_done FROM agent_runs WHERE run_id=?1').bind(id)
      .first<{ status: string; steps_done: number }>();
    expect(stored).toMatchObject({ status: 'completed', steps_done: 1 });
    const step = await db.prepare('SELECT attempts, state FROM agent_run_steps WHERE run_id=?1 AND n=0').bind(id)
      .first<{ attempts: number; state: string }>();
    expect(step).toMatchObject({ attempts: 2, state: 'completed' });
    expect(STEP_TIMEOUT_S).toBeGreaterThan(30);
  });
  it('100 étapes et 100 000 jetons cumulés ne terminent pas la mission', async () => {
    await ensureSchema(db);
    const id = 'cc8-long-session-' + crypto.randomUUID();
    const now = 2_000_000_000;
    expect((await createRun(db, {
      runId: id, cycleId: 'cc8-long-' + crypto.randomUUID(), participantId: 'cc8-long-agent',
      taskId: 'long-work', taskKind: 'planning', prompt: 'Mission longue et libre',
      maxSteps: -1, maxTokens: -1, maxCostCents: 0, deadlineAt: now + 1, now,
    })).created).toBe(true);
    let turns = 0;
    let reads = 0;
    const deps: EngineDeps = {
      model: { complete: async () => {
        turns++;
        return turns <= 100
          ? { output: { text: 'Étape de recherche ' + turns,
              tool_calls: [{ id: 'read-' + turns, name: 'read_progress', args: { step: turns } }] },
              usage: { tokens: 1_000, cost_cents: 0 } }
          : { output: { text: 'Mission achevée', tool_calls: [] }, usage: { tokens: 1_000, cost_cents: 0 } };
      } },
      tools: {
        spec: (_kind, tool) => tool === 'read_progress' ? { name: tool, effect: 'read' } : null,
        list: () => ['read_progress'],
        execute: async () => { reads++; return { progress: reads }; },
      },
      workerId: 'cc8-long-model',
      now: () => now,
      compactHistory: true,
    };
    for (let i = 0; i < 100; i++) {
      expect((await runStep(db, id, deps)).outcome).toBe('stepped');
    }
    expect((await runStep(db, id, deps)).outcome).toBe('completed');
    const state = await db.prepare('SELECT status, steps_done, tokens_used FROM agent_runs WHERE run_id=?1')
      .bind(id).first<{ status: string; steps_done: number; tokens_used: number }>();
    expect(state).toMatchObject({ status: 'completed', steps_done: 101, tokens_used: 101_000 });
    const counted = await db.prepare('SELECT COUNT(*) AS steps FROM agent_run_steps WHERE run_id=?1')
      .bind(id).first<{steps:number}>();
    expect(counted?.steps).toBe(101);
    expect(reads).toBe(100);
    expect(turns).toBe(101);
  });

});
