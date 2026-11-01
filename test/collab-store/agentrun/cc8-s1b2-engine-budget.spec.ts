import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, type EngineDeps, type ModelClient, type ToolHost } from '../../../src/collab-store/agentrun/engine';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const AT = 2_000_000_000;

/** Exécution fraîche à deadline réglable (les guards S1b-2 dépendent de deadline_at). */
async function freshRun(prefix: string, deadlineAt: number) {
  await ensureSchema(db);
  const runId = prefix + '-run-' + AT;
  const input = { runId, cycleId: prefix + '-cycle', participantId: 's1b2eng', taskId: prefix, taskKind: 'answer',
    prompt: 'Réponds.', maxSteps: 4, maxTokens: 100_000, maxCostCents: 1_000, deadlineAt, now: AT };
  expect((await createRun(db, input)).created).toBe(true);
  return runId;
}

function toolHost(executed: { count: number }): ToolHost {
  return {
    spec: (_taskKind: string, name: string) => (name === 'write_tool' ? { name, effect: 'write' as const } : null),
    list: () => ['write_tool'],
    execute: async () => { executed.count++; return { done: true }; },
  };
}

describe('CC8 S1b-2 — budget d’appels et garde avant effets (engine, plan seq 1376 point 4)', () => {
  it('deadline trop proche : garde budget — arrêt propre model_transient, AUCUN appel modèle', async () => {
    const runId = await freshRun('s1b2-enga', AT + 20); // 20 s < plancher 30 s
    const clock = { now: AT + 1 };
    let called = 0;
    const model: ModelClient = { complete: async () => {
      called++;
      return { output: { text: 'x', tool_calls: [] }, usage: { tokens: 1, cost_cents: 0 } };
    } };
    const deps: EngineDeps = { model, tools: toolHost({ count: 0 }), now: () => clock.now, workerId: 's1b2-worker' };
    const result = await runStep(db, runId, deps);
    expect(result.outcome).toBe('failed');
    expect(called).toBe(0);
    const run = await db.prepare('SELECT stop_reason FROM agent_runs WHERE run_id = ?1').bind(runId).first<{ stop_reason: string }>();
    expect(run?.stop_reason).toContain('model_transient');
    expect(run?.stop_reason).toContain('budget d’appels modèle de l’étape épuisé');
  });

  it('marge insuffisante avant un effet : l’effet n’est JAMAIS lancé, arrêt propre transient', async () => {
    const runId = await freshRun('s1b2-engb', AT + 3_600);
    const clock = { now: AT + 1 };
    const executed = { count: 0 };
    let seenBudgetLeft = 0;
    const model: ModelClient = { complete: async input => {
      seenBudgetLeft = input.budget_left_ms ?? 0;
      clock.now += 590; // appel long simulé : il ne reste que 10 s avant le plafond d’étape
      return { output: { text: '', tool_calls: [{ id: 'call-1', name: 'write_tool', args: {} }] }, usage: { tokens: 1, cost_cents: 0 } };
    } };
    const deps: EngineDeps = { model, tools: toolHost(executed), now: () => clock.now, workerId: 's1b2-worker' };
    const result = await runStep(db, runId, deps);
    expect(result.outcome).toBe('failed');
    expect(seenBudgetLeft).toBe(480_000); // le budget d’étape complet est bien transmis à l’appel
    expect(executed.count).toBe(0); // AUCUN effet lancé : pas d’effet ambiguous, pas de double effet
    const run = await db.prepare('SELECT stop_reason FROM agent_runs WHERE run_id = ?1').bind(runId).first<{ stop_reason: string }>();
    expect(run?.stop_reason).toContain('temps d’étape insuffisant');
    expect(run?.stop_reason).toContain('model_transient');
  });
});
