import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, STEP_TIMEOUT_S, type EngineDeps, type ModelClient, type ToolHost } from '../../../src/collab-store/agentrun/engine';
import { EFFECT_LAUNCH_FLOOR_S } from '../../../src/collab-store/agentrun/run-policy';
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

/**
 * Une étape dont l'appel modèle renvoie un effet write_tool, l'horloge avancée à modelEndsAt
 * en fin d'appel (D12 #255). Renvoie l'issue, le nombre d'effets exécutés et le stop_reason :
 * les tests de marges partagent ce socle au lieu de corps dupliqués (gate Sonar).
 */
async function runOneEffect(prefix: string, deadlineAt: number, modelEndsAt: number): Promise<{ outcome: string; executed: number; stopReason: string }> {
  const runId = await freshRun(prefix, deadlineAt);
  const clock = { now: AT + 1 };
  const executed = { count: 0 };
  const model: ModelClient = { complete: async () => {
    clock.now = modelEndsAt;
    return { output: { text: '', tool_calls: [{ id: 'call-1', name: 'write_tool', args: {} }] }, usage: { tokens: 1, cost_cents: 0 } };
  } };
  const deps: EngineDeps = { model, tools: toolHost(executed), now: () => clock.now, workerId: 's1b2-worker' };
  const outcome = (await runStep(db, runId, deps)).outcome;
  const run = await db.prepare('SELECT stop_reason FROM agent_runs WHERE run_id = ?1').bind(runId).first<{ stop_reason: string }>();
  return { outcome, executed: executed.count, stopReason: run?.stop_reason ?? '' };
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
    expect(run?.stop_reason).toContain('temps insuffisant avant l’effet');
    expect(run?.stop_reason).toContain('model_transient');
  });

  it.each([31, 60, 119])('marge %i s avant le plafond d’étape : l’effet n’est JAMAIS lancé (réserve 120 s + 30 s, D12 #255)', async margin => {
    const r = await runOneEffect('s1b2-engm' + margin, AT + 3_600, AT + 1 + STEP_TIMEOUT_S - margin);
    expect(r.outcome).toBe('failed'); // arrêt propre transient, effet jamais lancé
    expect(r.executed).toBe(0);
    expect(r.stopReason).toContain('temps insuffisant avant l’effet');
  });

  it('marge exacte 150 s (120 s d’effet + 30 s de marge) : l’effet est lancé, exécuté une seule fois', async () => {
    const r = await runOneEffect('s1b2-engok', AT + 3_600, AT + 1 + STEP_TIMEOUT_S - EFFECT_LAUNCH_FLOOR_S);
    expect(r.outcome).toBe('stepped');
    expect(r.executed).toBe(1);
  });

  it('deadline du run trop proche alors que le plafond d’étape est large : l’effet n’est JAMAIS lancé (borné par les DEUX)', async () => {
    // Deadline à AT + 141 (140 s restantes < 150 s) ; plafond d'étape large (591 s), 131 s restantes.
    const r = await runOneEffect('s1b2-engd', AT + 141, AT + 10);
    expect(r.outcome).toBe('failed');
    expect(r.executed).toBe(0);
    expect(r.stopReason).toContain('temps insuffisant avant l’effet');
  });
});
