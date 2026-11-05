import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, runSummary, ToolRefused, STEP_TIMEOUT_S, type ModelOutput, type ToolHost, type ToolCall, type EngineDeps } from '../../../src/collab-store/agentrun/engine';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const NOW = 1_990_000_000;
const BRANCH = 'mcp/105856986/vibe-api-s7-live';
const BASE_SHA = 'a'.repeat(40), COMMIT_SHA = 'b'.repeat(40);
let counter = 0;
const call = (name: string, id: string): ModelOutput => ({ text: name, tool_calls: [{ id, name, args: {} }] });
const final = (text = 'Mission terminée') : ModelOutput => ({ text, tool_calls: [] });

async function fixture(kind: string = 'implement') {
  await ensureSchema(db); // createRun consulte owner_flags, créé par le schéma du store.
  const id = ++counter, cycle = 's7-guard-test-' + id + '-' + Date.now(), task = 'S7-live-vibe';
  const participant = 'vibe', runId = 's7-guard-' + id + '-' + Date.now();
  expect((await createRun(db, { runId, cycleId: cycle, participantId: participant, taskId: task,
    taskKind: kind, prompt: 'Créer la branche, commit, CI puis PR.', maxSteps: 10, maxTokens: 100000,
    maxCostCents: 0, deadlineAt: NOW + 2000, now: NOW })).created).toBe(true);
  return { runId, completion: [{ cycle, task, participant, branch: BRANCH }] };
}

function scripted(outputs: ModelOutput[]) {
  let count = 0;
  return { async complete() {
    const output = outputs[count++] ?? final();
    return { output, usage: { tokens: 20, cost_cents: 0 } };
  }, calls: () => count };
}

function githubHost(options: { refuseBranch?: boolean; verified?: boolean; wrongPrHead?: boolean } = {}) {
  const log: string[] = [];
  const names = new Set(['github_write_scope','github_create_branch','github_commit_files',
    'github_run_checks','github_check_result','github_open_pr','github_read_file']);
  const tools: ToolHost = {
    spec: (_kind, name) => names.has(name)
      ? { name, effect: name === 'github_read_file' ? 'read' : 'write' } : null,
    list: () => [...names],
    async execute(c: ToolCall) {
      log.push(c.name);
      if (c.name === 'github_write_scope') return { branch: BRANCH, base_sha: BASE_SHA };
      if (c.name === 'github_create_branch') {
        if (options.refuseBranch) throw new ToolRefused('api_base_head_changed');
        return { branch: BRANCH, sha: BASE_SHA };
      }
      if (c.name === 'github_commit_files') return { branch: BRANCH, commit_sha: COMMIT_SHA };
      if (c.name === 'github_run_checks') return { runId: 42, targetSha: COMMIT_SHA };
      if (c.name === 'github_check_result') return {
        targetSha: COMMIT_SHA, status: 'completed', verifiedSuccess: options.verified !== false,
      };
      if (c.name === 'github_open_pr') return {
        branch: BRANCH, head_sha: options.wrongPrHead ? BASE_SHA : COMMIT_SHA, number: 31, draft: false,
      };
      return { file: 'data' };
    },
  };
  return { tools, log };
}

function deps(outputs: ModelOutput[], host: ToolHost, grants: EngineDeps['githubCompletionGrants']): EngineDeps {
  return { model: scripted(outputs), tools: host, githubCompletionGrants: grants, now: () => NOW + 1, workerId: 'worker-guard' };
}

async function drain(runId: string, d: EngineDeps, steps: number) {
  let outcome = '';
  for (let i = 0; i < steps; i++) {
    outcome = (await runStep(db, runId, d)).outcome;
    if (outcome !== 'stepped') break;
  }
  return outcome;
}

describe('CC8 S7 — garde serveur contre le faux final implement', () => {
  it('T1: final textuel prématuré sans écriture => failed typé, pas completed ni relance', async () => {
    const f = await fixture(); const h = githubHost();
    const d = deps([final('Je créerai la branche plus tard.')], h.tools, f.completion);
    expect(await drain(f.runId, d, 3)).toBe('failed');
    expect(await runSummary(db, f.runId)).toMatchObject({
      status: 'failed', stop_reason: 'incomplete_final:github_evidence_missing', steps_done: 1, cost_cents: 0,
      effects: [],
    });
    expect((await runStep(db, f.runId, d)).outcome).toBe('failed');
  });

  it('T2: mandat lu sans write GitHub => final incomplet', async () => {
    const f = await fixture(); const h = githubHost();
    const d = deps([call('github_write_scope','scope'), final('Je vais lire le fichier ensuite')], h.tools, f.completion);
    expect(await drain(f.runId, d, 4)).toBe('failed');
    expect(h.log).toEqual(['github_write_scope']);
    expect((await runSummary(db, f.runId))?.effects).toEqual([{ tool: 'github_write_scope', status: 'completed' }]);
  });

  it('T3: refus de création de branche => jamais completed', async () => {
    const f = await fixture(); const h = githubHost({ refuseBranch: true });
    const d = deps([call('github_write_scope','s'), call('github_create_branch','b'), final()], h.tools, f.completion);
    expect(await drain(f.runId, d, 5)).toBe('failed');
    expect((await runSummary(db, f.runId))?.effects).toEqual([
      { tool: 'github_write_scope', status: 'completed' }, { tool: 'github_create_branch', status: 'failed' },
    ]);
  });

  const pipeline = [call('github_write_scope','s'),call('github_create_branch','b'),
    call('github_commit_files','c'),call('github_run_checks','r'),
    call('github_check_result','v'),call('github_open_pr','p'),final()];

  it('T4: branche + commit + CI vérifiée + PR au même SHA => completed', async () => {
    const f = await fixture(); const h = githubHost();
    expect(await drain(f.runId, deps(pipeline, h.tools, f.completion), 9)).toBe('completed');
    expect((await runSummary(db, f.runId))?.stop_reason).toBe('final');
    expect(h.log).toEqual(['github_write_scope','github_create_branch','github_commit_files',
      'github_run_checks','github_check_result','github_open_pr']);
  });

  it('T4b: CI non vérifiée ou PR au mauvais head => incomplete_final', async () => {
    for (const variant of [{ verified: false }, { wrongPrHead: true }]) {
      const f = await fixture(); const h = githubHost(variant);
      expect(await drain(f.runId, deps(pipeline, h.tools, f.completion), 9)).toBe('failed');
      expect((await runSummary(db, f.runId))?.stop_reason).toBe('incomplete_final:github_evidence_missing');
    }
  });

  it('T5: reprise après crash au milieu du commit : aucun commit dupliqué, preuves intactes', async () => {
    const f = await fixture(); const h = githubHost();
    let writes = 0; let lastTool = '';
    const execute = h.tools.execute;
    h.tools.execute = async (c, ctx) => {
      lastTool = c.name;
      if (c.name === 'github_commit_files') writes++;
      return execute(c, ctx);
    };
    h.tools.lookup = async c => c.name === 'github_commit_files'
      ? { found: true, result: { branch: BRANCH, commit_sha: COMMIT_SHA } } : { found: false };
    const model = scripted(pipeline);
    let crash = true;
    const original: EngineDeps = { model, tools: h.tools, githubCompletionGrants: f.completion,
      now: () => NOW + 1, workerId: 'worker-crash',
      probe: point => {
        if (point === 'after_effect' && lastTool === 'github_commit_files' && crash) {
          crash = false; throw Error('simulated_worker_crash');
        }
      },
    };
    expect((await runStep(db, f.runId, original)).outcome).toBe('stepped');
    expect((await runStep(db, f.runId, original)).outcome).toBe('stepped');
    await expect(runStep(db, f.runId, original)).rejects.toThrow('simulated_worker_crash');
    const resumed: EngineDeps = { ...original, now: () => NOW + STEP_TIMEOUT_S + 5,
      workerId: 'worker-recovery', probe: undefined };
    expect((await runStep(db, f.runId, resumed)).outcome).toBe('stepped');
    expect(await drain(f.runId, resumed, 8)).toBe('completed');
    expect(writes).toBe(1);
    expect(model.calls()).toBe(pipeline.length);
  });

  it('T6/T7: review et implement sans mandat continuent à utiliser la fin historique', async () => {
    for (const kind of ['review','test','answer','implement']) {
      const f = await fixture(kind); const h = githubHost();
      const grants = kind === 'implement' ? [] : f.completion;
      expect(await drain(f.runId, deps([final('Fini')], h.tools, grants), 2)).toBe('completed');
    }
  });
});
