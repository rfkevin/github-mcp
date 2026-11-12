import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, ModelCallError, STEP_TIMEOUT_S, type EngineDeps } from '../../../src/collab-store/agentrun/engine';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

/** Shared durable-run setup avoids repeating the same D1 fixtures across scenarios. */
async function sessionRun(prefix: string, participantId: string, taskId: string, now: number, prompt: string): Promise<string> {
  await ensureSchema(db);
  const runId = 'cc8-' + prefix + '-' + crypto.randomUUID();
  const created = await createRun(db, {
    runId, cycleId: 'cc8-' + prefix + '-cycle-' + crypto.randomUUID(),
    participantId, taskId, taskKind: 'planning', prompt,
    maxSteps: -1, maxTokens: -1, maxCostCents: 0, deadlineAt: now + 1, now,
  });
  expect(created.created).toBe(true);
  return runId;
}

describe('CC8 WorkSession — reprise autonome après interruption du fournisseur API', () => {
  it('503 puis succès : conserve la même tâche, son run_id et ses étapes, sans plafond de tentatives', async () => {
    const clock = { now: 2_000_000_000 };
    const id = await sessionRun('retry', 'cc8-model-retry', 'session', clock.now, 'Résoudre la tâche, puis terminer.');
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
    const now = 2_000_000_000;
    const id = await sessionRun('long', 'cc8-long-agent', 'long-work', now, 'Mission longue et libre');
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

  it('trois refus déterministes identiques -> blocage documenté, sans effet extérieur ni plafond global', async () => {
    const now = 2_000_000_000;
    const runId = await sessionRun('stuck', 'cc8-stuck-agent', 'same-denied', now,
      'Try without forcing owner actions.');
    let calls = 0;
    let effects = 0;
    const deps: EngineDeps = {
      model: { complete: async () => {
        calls++;
        return { output: { text: 'Repeated request', tool_calls: [
          { id: 'same', name: 'evidence.add', args: { state: 'AGREE', task: 'same-denied' } },
        ] }, usage: { tokens: 100, cost_cents: 0 } };
      } },
      tools: {
        spec: (_kind, name) => ({ name, effect: 'write' }),
        list: () => ['evidence.add'],
        execute: async () => { effects++; return {}; },
      },
      now: () => now, workerId: 'stuck-worker', salonEnabled: true,
    };
    expect((await runStep(db, runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, runId, deps)).outcome).toBe('failed');
    expect(calls).toBe(3);
    expect(effects).toBe(0);
    expect(await db.prepare('SELECT status, stop_reason, steps_done FROM agent_runs WHERE run_id=?1').bind(runId)
      .first()).toMatchObject({ status: 'failed', stop_reason: 'blocked:no_progress:repeated_denial', steps_done: 3 });
    const journal = await db.prepare("SELECT COUNT(*) AS n FROM agent_run_journal WHERE run_id=?1 AND kind='no_progress'").bind(runId)
      .first<{ n: number }>();
    expect(journal?.n).toBe(1);
    // Salon enabled: handoff is durable, independently of the failed model run.
    const messages = await db.prepare("SELECT COUNT(*) AS n FROM salon_messages WHERE task_id='same-denied' AND author_pid='cc8-stuck-agent'")
      .first<{ n: number }>();
    expect(messages?.n).toBe(1);
    expect((await runStep(db, runId, deps)).outcome).toBe('failed');
    expect(calls).toBe(3);
  });

  it('deux refus suivis d’une action différente autorisée ne déclenchent pas le disjoncteur', async () => {
    const now = 2_000_000_000;
    const runId = await sessionRun('recover', 'cc8-recover-agent', 'recovery', now,
      'Recover after a denial.');
    let calls = 0;
    let reads = 0;
    const deps: EngineDeps = {
      model: { complete: async () => {
        calls++;
        return { output: calls <= 2
          ? { text: 'Denied action', tool_calls: [{ id: 'bad', name: 'owner.decision', args: {} }] }
          : calls === 3 ? { text: 'Valid read', tool_calls: [{ id: 'good', name: 'read_progress', args: {} }] }
            : { text: 'Done', tool_calls: [] }, usage: { tokens: 50, cost_cents: 0 } };
      } },
      tools: {
        spec: (_kind, name) => ({ name, effect: 'read' }),
        list: () => ['owner.decision', 'read_progress'],
        execute: async () => { reads++; return { value: 1 }; },
      },
      now: () => now, workerId: 'recover-worker',
    };
    for (let i = 0; i < 3; i++) expect((await runStep(db, runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, runId, deps)).outcome).toBe('completed');
    expect(reads).toBe(1);
    expect(calls).toBe(4);
  });
});


  it('cinq consultations du même mandat après branche créée, sans commit, sont un blocage sémantique', async () => {
    const now = 2_000_000_000;
    await ensureSchema(db);
    const runId = 'cc8-scope-loop-' + crypto.randomUUID();
    expect((await createRun(db, {
      runId, cycleId: 'cc8-scope-' + crypto.randomUUID(), participantId: 'gemini', taskId: 'loop',
      taskKind: 'implement', prompt: 'Commit a functional change', maxSteps: -1,
      maxTokens: -1, maxCostCents: 0, deadlineAt: now + 1200, now,
    })).created).toBe(true);
    const sha = 'a'.repeat(40);
    const branch = 'mcp/105856986/gemini-api-scope-loop';
    let turns = 0;
    const deps: EngineDeps = {
      model: { complete: async () => {
        const n = turns++;
        return { output: { text: 'continuer', tool_calls: [{ id: 'tool-' + n,
          name: n === 1 ? 'github_create_branch' : 'github_write_scope', args: {} }] },
          usage: { tokens: 10, cost_cents: 0 } };
      } },
      tools: {
        list: () => ['github_write_scope', 'github_create_branch'],
        spec: (_kind, name) => ({ name, effect: 'write' }),
        execute: async (call) => call.name === 'github_create_branch'
          ? { branch, sha }
          : { branch, base_sha: sha, branch_head: turns < 2 ? null : sha },
      },
      now: () => now, workerId: 'scope-loop-worker', salonEnabled: true,
    };
    for (let i = 0; i < 6; i++) expect((await runStep(db, runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, runId, deps)).outcome).toBe('failed');
    const stored = await db.prepare('SELECT status,stop_reason,steps_done FROM agent_runs WHERE run_id=?1').bind(runId).first();
    expect(stored).toMatchObject({ status: 'failed',
      stop_reason: 'blocked:no_progress:repeated_scope_without_commit', steps_done: 7 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM agent_run_journal WHERE run_id=?1 AND kind='no_progress'")
      .bind(runId).first<{n:number}>()).toMatchObject({ n: 1 });
  });

  it('un commit intermédiaire remet à zéro la répétition de scope sans stopper le travail', async () => {
    const now = 2_000_000_000;
    await ensureSchema(db);
    const runId = 'cc8-scope-progress-' + crypto.randomUUID();
    expect((await createRun(db, {
      runId, cycleId: 'cc8-scope-progress-' + crypto.randomUUID(), participantId: 'gemini', taskId: 'progress',
      taskKind: 'implement', prompt: 'Long legitimate work', maxSteps: -1,
      maxTokens: -1, maxCostCents: 0, deadlineAt: now + 1200, now,
    })).created).toBe(true);
    const sha = 'a'.repeat(40);
    let turn = 0;
    const deps: EngineDeps = {
      model: { complete: async () => {
        const n = turn++;
        return { output: { text: 'step', tool_calls: [{ id: 't-' + n,
          name: n === 0 ? 'github_create_branch' : n === 4 ? 'github_commit_files' : 'github_write_scope',
          args: { n } }] }, usage: { tokens: 1, cost_cents: 0 } };
      } },
      tools: {
        list: () => ['github_write_scope', 'github_create_branch', 'github_commit_files'],
        spec: (_kind, name) => ({ name, effect: 'write' }),
        execute: async call => call.name === 'github_create_branch' ? { branch: 'test', sha }
          : call.name === 'github_commit_files' ? { commit_sha: 'b'.repeat(40) }
            : { branch: 'test', branch_head: sha, base_sha: sha },
      },
      now: () => now, workerId: 'scope-progress-worker',
    };
    for (let i = 0; i < 9; i++) expect((await runStep(db, runId, deps)).outcome).toBe('stepped');
    expect(await db.prepare('SELECT status FROM agent_runs WHERE run_id=?1').bind(runId).first())
      .toMatchObject({ status: 'running' });
  });
