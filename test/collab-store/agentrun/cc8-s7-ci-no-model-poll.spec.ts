import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, leaseKeyOf, runStep, ToolRefused, type AgentMessage, type ModelOutput, type ToolCall, type ToolHost }
  from '../../../src/collab-store/agentrun';
import { objectAlarm, objectWake, type ObjectSlot, type OrchestratorDeps } from '../../../src/collab-store/agentrun/orchestrator';
import { CI_POLL_MAX } from '../../../src/collab-store/agentrun/ci-poll';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC8 S7 — relevés de CI faits par le serveur, sans appel modèle ni étape (vote seq 1657, option seq 1665).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_960_000_000;
const SHA = 'c'.repeat(40);
const BRANCH = 'mcp/105856986/vibe-api-pilot';
const WAIT = { targetSha: SHA, status: 'in_progress', conclusion: null, verifiedSuccess: false, next_action: 'wait', next_poll_seconds: 15 };
const PASSED = { targetSha: SHA, status: 'completed', conclusion: 'success', verifiedSuccess: true, next_action: 'request_D12', next_poll_seconds: null };

async function newRun(label: string, overrides: { deadline?: number } = {}) {
  await ensureSchema(db);
  const runId = 'cc8-poll-' + label + '-' + crypto.randomUUID();
  const cycleId = 'cc8-poll-' + crypto.randomUUID();
  const created = await createRun(db, { runId, cycleId, participantId: 'vibe', taskId: 'pilot', taskKind: 'implement',
    prompt: 'Mission S7.', maxSteps: 12, maxTokens: 48_000, maxCostCents: 0, deadlineAt: overrides.deadline ?? T + 2_700, now: T });
  expect(created.created).toBe(true);
  return { runId, cycleId, leaseKey: leaseKeyOf(cycleId, 'vibe', 'pilot') };
}

/** Modèle scripté : enregistre les messages reçus à chaque appel. */
function scripted(outputs: ModelOutput[]) {
  const seen: AgentMessage[][] = [];
  return {
    seen,
    client: { async complete(input: { messages: AgentMessage[] }) {
      seen.push(input.messages);
      return { output: outputs[seen.length - 1] ?? { text: 'fin', tool_calls: [] }, usage: { tokens: 1_000, cost_cents: 0 } };
    } },
  };
}

/** Hôte d'outils : chaque outil d'écriture rend la valeur suivante de sa file (ou lève). */
function host(queues: Record<string, Array<unknown | (() => never)>>) {
  const calls: Array<{ name: string; key?: string }> = [];
  const tools: ToolHost = {
    list: () => Object.keys(queues),
    spec: (_kind, name) => name in queues ? { name, effect: 'write' } : null,
    async execute(call: ToolCall, ctx) {
      calls.push({ name: call.name, key: ctx.effect_key });
      const next = queues[call.name].shift();
      if (typeof next === 'function') return (next as () => never)();
      return next;
    },
  };
  return { tools, calls };
}

const check = (id = 'ci-1'): ModelOutput => ({ text: 'CI ?', tool_calls: [{ id, name: 'github_check_result', args: { name: 'pilot', sha: SHA, run_id: 7 } }] });

async function runRow(runId: string) {
  return (await db.prepare('SELECT status, steps_done, tokens_used FROM agent_runs WHERE run_id = ?1').bind(runId)
    .first<{ status: string; steps_done: number; tokens_used: number }>())!;
}
async function pollCount(runId: string) {
  return (await db.prepare('SELECT COUNT(*) AS c FROM agent_run_ci_polls WHERE run_id = ?1').bind(runId).first<{ c: number }>())!.c;
}

describe('CC8 S7 — relevés de CI sans modèle', () => {
  it('CI pending : relevés serveur sans appel modèle, ni étape, ni jeton ; le modèle voit le résultat final', async () => {
    const { runId } = await newRun('happy');
    const model = scripted([check(), { text: 'CI verte, je demande la revue.', tool_calls: [] }]);
    const { tools, calls } = host({ github_check_result: [WAIT, WAIT, WAIT, PASSED] });
    const deps = { model: model.client, tools, now: () => T + 100, workerId: 'w1' };
    expect(await runStep(db, runId, deps)).toEqual({ outcome: 'stepped' });
    const afterModel = await runRow(runId);
    expect(afterModel).toMatchObject({ steps_done: 1, tokens_used: 1_000 });
    // Trois relevés serveur : wait, wait, success.
    for (let i = 0; i < 3; i++) expect(await runStep(db, runId, deps)).toEqual({ outcome: 'stepped' });
    expect(model.seen).toHaveLength(1);
    expect(await runRow(runId)).toMatchObject({ steps_done: 1, tokens_used: 1_000, status: 'running' });
    expect(await pollCount(runId)).toBe(3);
    // Chaque relevé a sa propre clé d'effet, distincte de celle de l'appel d'origine.
    expect(new Set(calls.map(c => c.key)).size).toBe(4);
    // CI terminée : le modèle est rappelé une seule fois et voit le résultat final sur l'appel d'origine.
    expect(await runStep(db, runId, deps)).toEqual({ outcome: 'completed' });
    expect(model.seen).toHaveLength(2);
    const tool = model.seen[1].find(m => m.role === 'tool' && m.tool_call_id === 'ci-1');
    expect(JSON.parse(String(tool?.content))).toMatchObject({ verifiedSuccess: true, server_ci_polls: 3 });
    // Le journal d'effets d'origine n'est pas réécrit (toujours « wait »).
    const original = await db.prepare("SELECT result FROM agent_run_effects WHERE run_id = ?1 AND tool = 'github_check_result'")
      .bind(runId).first<{ result: string }>();
    expect(JSON.parse(original!.result).next_action).toBe('wait');
    expect(await runRow(runId)).toMatchObject({ steps_done: 2, tokens_used: 2_000 });
  });

  it('au plus CI_POLL_MAX relevés, puis le modèle reprend la main', async () => {
    const { runId } = await newRun('cap');
    const model = scripted([check()]);
    const { tools } = host({ github_check_result: Array.from({ length: CI_POLL_MAX + 5 }, () => WAIT) });
    const deps = { model: model.client, tools, now: () => T + 100, workerId: 'w1' };
    await runStep(db, runId, deps);
    for (let i = 0; i < CI_POLL_MAX; i++) await runStep(db, runId, deps);
    expect(await pollCount(runId)).toBe(CI_POLL_MAX);
    expect(model.seen).toHaveLength(1);
    await runStep(db, runId, deps);
    expect(model.seen).toHaveLength(2);
    expect(await pollCount(runId)).toBe(CI_POLL_MAX);
  });

  it('refus certain pendant un relevé (head changé, tâche inactive...) : le modèle reprend la main', async () => {
    const { runId } = await newRun('refused');
    const model = scripted([check()]);
    const { tools } = host({ github_check_result: [WAIT, () => { throw new ToolRefused('api_write_head_changed'); }] });
    const deps = { model: model.client, tools, now: () => T + 100, workerId: 'w1' };
    await runStep(db, runId, deps);
    await runStep(db, runId, deps);
    expect(await pollCount(runId)).toBe(1);
    await runStep(db, runId, deps);
    expect(model.seen).toHaveLength(2);
    const tool = model.seen[1].find(m => m.role === 'tool');
    expect(String(tool?.content)).toContain('api_write_head_changed');
  });

  it('panne de lecture transitoire : relevé noté, on continue d’attendre', async () => {
    const { runId } = await newRun('transient');
    const model = scripted([check()]);
    const { tools } = host({ github_check_result: [WAIT, () => { throw new Error('GitHub 502'); }, PASSED] });
    const deps = { model: model.client, tools, now: () => T + 100, workerId: 'w1' };
    await runStep(db, runId, deps);
    await runStep(db, runId, deps);
    await runStep(db, runId, deps);
    expect(await pollCount(runId)).toBe(2);
    expect(model.seen).toHaveLength(1);
  });

  it('HALT ou deadline proche : aucun relevé, le flux normal arrête le run', async () => {
    const halted = await newRun('halt');
    const model = scripted([check()]);
    const { tools, calls } = host({ github_check_result: [WAIT, WAIT] });
    const deps = { model: model.client, tools, now: () => T + 100, workerId: 'w1' };
    await runStep(db, halted.runId, deps);
    await db.prepare("INSERT INTO owner_flags (name, value, event_seq, updated_at) VALUES ('halt', '1', NULL, ?1) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
      .bind(T + 1).run();
    try {
      expect(await runStep(db, halted.runId, deps)).toEqual({ outcome: 'halted' });
      expect(calls).toHaveLength(1);
      expect(await pollCount(halted.runId)).toBe(0);
    } finally {
      await db.prepare("UPDATE owner_flags SET value = '0' WHERE name = 'halt'").run();
    }
    const late = await newRun('deadline', { deadline: T + 200 });
    const lateModel = scripted([check()]);
    const lateHost = host({ github_check_result: [WAIT, WAIT] });
    await runStep(db, late.runId, { model: lateModel.client, tools: lateHost.tools, now: () => T + 10, workerId: 'w1' });
    // À 25 s de la deadline : pas de relevé (plancher 30 s).
    await runStep(db, late.runId, { model: lateModel.client, tools: lateHost.tools, now: () => T + 175, workerId: 'w1' });
    expect(await pollCount(late.runId)).toBe(0);
    expect(lateHost.calls).toHaveLength(1);
  });

  it('garde de complétude S7 : un succès CI constaté par relevé serveur compte comme preuve', async () => {
    const { runId, cycleId } = await newRun('completion');
    const outputs: ModelOutput[] = [
      { text: '', tool_calls: [{ id: 's', name: 'github_write_scope', args: {} }] },
      { text: '', tool_calls: [{ id: 'b', name: 'github_create_branch', args: { name: 'pilot', base_sha: 'b'.repeat(40) } }] },
      { text: '', tool_calls: [{ id: 'c', name: 'github_commit_files', args: { name: 'pilot' } }] },
      { text: '', tool_calls: [{ id: 'r', name: 'github_run_checks', args: { name: 'pilot', sha: SHA } }] },
      check(),
      { text: 'PR ouverte.', tool_calls: [{ id: 'p', name: 'github_open_pr', args: { name: 'pilot', title: 't' } }] },
    ];
    const model = scripted(outputs);
    const { tools } = host({
      github_write_scope: [{ branch: BRANCH }],
      github_create_branch: [{ branch: BRANCH, sha: 'b'.repeat(40) }],
      github_commit_files: [{ branch: BRANCH, commit_sha: SHA }],
      github_run_checks: [{ targetSha: SHA, runId: 7 }],
      github_check_result: [WAIT, PASSED],
      github_open_pr: [{ branch: BRANCH, number: 300, head_sha: SHA, draft: false }],
    });
    const deps = { model: model.client, tools, now: () => T + 100, workerId: 'w1',
      githubCompletionGrants: [{ cycle: cycleId, participant: 'vibe', task: 'pilot', branch: BRANCH }] };
    for (let i = 0; i < 5; i++) expect(await runStep(db, runId, deps)).toEqual({ outcome: 'stepped' });
    expect(await runStep(db, runId, deps)).toEqual({ outcome: 'stepped' }); // relevé serveur : succès
    expect(await runStep(db, runId, deps)).toEqual({ outcome: 'completed' });
    expect(model.seen).toHaveLength(6);
    expect(await db.prepare('SELECT stop_reason FROM agent_runs WHERE run_id = ?1').bind(runId).first()).toEqual({ stop_reason: 'final' });
  });

  it('orchestrateur : après un relevé « wait », le réveil suivant reste à 60-120 s, sans modèle', async () => {
    const { runId, leaseKey } = await newRun('alarm');
    const values = new Map<string, string | number>();
    const state = { alarm: null as number | null };
    const slot: ObjectSlot = {
      get: async key => values.get(key) as never, put: async (key, value) => { values.set(key, value); },
      delete: async key => values.delete(key), getAlarm: async () => state.alarm,
      setAlarm: async at => { state.alarm = at; }, deleteAlarm: async () => { state.alarm = null; },
    };
    const clock = { ms: T * 1000 };
    const model = scripted([check()]);
    const { tools } = host({ github_check_result: [WAIT, WAIT] });
    const d: OrchestratorDeps = {
      db, env: { AGENT_RUNS_ENABLED: 'true' }, slot, ownsLease: () => true, nowMs: () => clock.ms,
      engine: () => ({ model: model.client, tools, now: () => Math.floor(clock.ms / 1000) }),
      workerId: () => 'w-alarm',
    };
    expect(await objectWake(d, runId, leaseKey)).toEqual({ accepted: true });
    state.alarm = null;
    expect(await objectAlarm(d)).toMatchObject({ action: 'stepped', next_at: T * 1000 + 60_000 });
    clock.ms = T * 1000 + 60_000;
    state.alarm = null;
    expect(await objectAlarm(d)).toMatchObject({ action: 'stepped', next_at: T * 1000 + 120_000 });
    expect(model.seen).toHaveLength(1);
    expect(await pollCount(runId)).toBe(1);
  });
});
