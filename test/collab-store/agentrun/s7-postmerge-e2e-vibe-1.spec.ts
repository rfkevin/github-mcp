import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, providerMessagesFromHistory, verifiedWorkMilestones, runSummary,
  type CompletedHistoryStep, type EngineDeps } from '../../../src/collab-store/agentrun/engine';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

const BASE = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const BRANCH = 'mcp/105856986/vibe-api-postmerge-e2e';
const INTEGRATION = 'mcp/105856986/cc3-integration';
const TASK = 'S7-postmerge-e2e-vibe-1';

/** Mission implement complète : tours scriptés qui suivent l'ordre D1 exigé par githubCompletionSatisfied. */
function scriptedDeps(script: Array<{ name: string; args: Record<string, unknown>; result: unknown }>,
  cycleId: string): { deps: EngineDeps; calls: () => number } {
  let turn = 0;
  const deps: EngineDeps = {
    model: { complete: async () => {
      const n = turn++;
      const entry = script[n];
      return { output: entry
        ? { text: 'Étape ' + n + ' : ' + entry.name, tool_calls: [{ id: 'call-' + n, name: entry.name, args: entry.args }] }
        : { text: 'Mission terminée.', tool_calls: [] },
        usage: { tokens: 10, cost_cents: 0 } };
    } },
    tools: {
      list: () => script.map(s => s.name),
      spec: (_kind, name) => script.some(s => s.name === name) ? { name, effect: 'write' } : null,
      execute: async call => {
        const entry = script.find(s => s.name === call.name);
        return entry ? entry.result : {};
      },
    },
    now: () => 2_000_000_000,
    workerId: 'vibe-postmerge-e2e',
    githubCompletionGrants: [{ cycle: cycleId, task: TASK, participant: 'vibe', branch: BRANCH }],
  };
  return { deps, calls: () => turn };
}

async function newRun(prefix: string, now: number): Promise<{ runId: string; cycleId: string }> {
  await ensureSchema(db);
  const runId = 'cc8-' + prefix + '-' + crypto.randomUUID();
  const cycleId = 'cc8-' + prefix + '-cycle-' + crypto.randomUUID();
  expect((await createRun(db, {
    runId, cycleId, participantId: 'vibe', taskId: TASK, taskKind: 'implement',
    prompt: 'Compléter la mission GitHub post-merge S7 (test E2E WorkSession).',
    maxSteps: -1, maxTokens: -1, maxCostCents: 0, deadlineAt: now + 1200, now,
  })).created).toBe(true);
  return { runId, cycleId };
}

function missionScript(draft: boolean) {
  return [
    { name: 'github_write_scope', args: { repository: 'rfkevin/github-mcp', branch: BRANCH, base_branch: INTEGRATION },
      result: { branch: BRANCH, base_branch: INTEGRATION, base_sha: BASE, branch_head: BASE } },
    { name: 'github_create_branch', args: { repository: 'rfkevin/github-mcp', branch: BRANCH, sha: BASE },
      result: { branch: BRANCH, sha: BASE } },
    { name: 'github_commit_files', args: { repository: 'rfkevin/github-mcp', branch: BRANCH, files: [{ path: 'test/example.spec.ts' }] },
      result: { branch: BRANCH, commit_sha: COMMIT } },
    { name: 'github_run_checks', args: { repository: 'rfkevin/github-mcp', targetSha: COMMIT },
      result: { targetSha: COMMIT, runId: 4321 } },
    { name: 'github_check_result', args: { repository: 'rfkevin/github-mcp', targetSha: COMMIT, runId: 4321 },
      result: { targetSha: COMMIT, runId: 4321, status: 'completed', verifiedSuccess: true } },
    { name: 'github_open_pr', args: { repository: 'rfkevin/github-mcp', branch: BRANCH, base_branch: INTEGRATION,
        head_sha: COMMIT, title: 'S7 E2E post-merge', draft },
      result: { number: 331, branch: BRANCH, head_sha: COMMIT, draft } },
  ];
}

describe('CC8 S7 post-merge — complétion implement prouvée par les effets D1 réels', () => {
  it('mission complète : une PR non-brouillon prouve la complétion dès github_open_pr, sans 7e appel modèle', async () => {
    const now = 2_000_000_000;
    const { runId, cycleId } = await newRun('postmerge-a', now);
    const script = missionScript(false);
    const { deps, calls } = scriptedDeps(script, cycleId);
    for (let i = 0; i < 5; i++) expect((await runStep(db, runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, runId, deps)).outcome).toBe('completed');
    expect(calls()).toBe(6);
    expect(await db.prepare('SELECT status, stop_reason, steps_done FROM agent_runs WHERE run_id=?1').bind(runId).first())
      .toMatchObject({ status: 'completed', stop_reason: 'final', steps_done: 6 });
    const effects = await db.prepare('SELECT tool, status FROM agent_run_effects WHERE run_id=?1 ORDER BY n, idx')
      .bind(runId).all<{ tool: string; status: string }>();
    expect(effects.results.map(e => e.tool)).toEqual(script.map(s => s.name));
    expect(effects.results.every(e => e.status === 'completed')).toBe(true);
    const summary = await runSummary(db, runId);
    expect(summary).toMatchObject({ status: 'completed', stop_reason: 'final', steps_done: 6 });
    expect(summary?.effects).toHaveLength(6);
    expect((await runStep(db, runId, deps)).outcome).toBe('completed');
    expect(calls()).toBe(6);
    // Continuité #317 : le checkpoint compact reconstruit les jalons depuis le D1 réel, pas depuis le modèle.
    const steps = await db.prepare("SELECT model_output, results FROM agent_run_steps WHERE run_id=?1 AND state='completed' ORDER BY n")
      .bind(runId).all<CompletedHistoryStep>();
    const milestones = verifiedWorkMilestones(steps.results);
    expect(milestones.pr).toMatchObject({ number: 331 });
    expect(milestones.commit).toMatchObject({ commit_sha: COMMIT });
    // Force actual eviction: a short successful mission now remains fully visible.
    const longLastTurn: CompletedHistoryStep = {
      model_output: JSON.stringify({ text: 'recent analysis '.repeat(5_000), tool_calls: [] }), results: '[]',
    };
    const compact = providerMessagesFromHistory('Mission post-merge.', [...steps.results, longLastTurn], true);
    expect(compact[0].content).toContain('Jalons déjà exécutés');
    expect(compact[0].content).toContain(BRANCH);
    expect(compact[0].content).toContain(COMMIT);
    expect(compact[0].content).toContain('"number":331');
  });

  it('final sans preuve GitHub : échec typé incomplete_final:github_evidence_missing', async () => {
    const now = 2_000_000_000;
    const { runId, cycleId } = await newRun('postmerge-b', now);
    const { deps, calls } = scriptedDeps([], cycleId);
    expect((await runStep(db, runId, deps)).outcome).toBe('failed');
    expect(calls()).toBe(1);
    expect(await db.prepare('SELECT status, stop_reason FROM agent_runs WHERE run_id=?1').bind(runId).first())
      .toMatchObject({ status: 'failed', stop_reason: 'incomplete_final:github_evidence_missing' });
  });

  it('une PR brouillon ne prouve pas la complétion : le run continue puis échoue sans preuve', async () => {
    const now = 2_000_000_000;
    const { runId, cycleId } = await newRun('postmerge-c', now);
    const script = missionScript(true);
    const { deps, calls } = scriptedDeps(script, cycleId);
    for (let i = 0; i < 6; i++) expect((await runStep(db, runId, deps)).outcome).toBe('stepped');
    expect(calls()).toBe(6);
    expect(await db.prepare('SELECT status FROM agent_runs WHERE run_id=?1').bind(runId).first())
      .toMatchObject({ status: 'running' });
    expect((await runStep(db, runId, deps)).outcome).toBe('failed');
    expect(calls()).toBe(7);
    expect(await db.prepare('SELECT status, stop_reason FROM agent_runs WHERE run_id=?1').bind(runId).first())
      .toMatchObject({ status: 'failed', stop_reason: 'incomplete_final:github_evidence_missing' });
  });
});
