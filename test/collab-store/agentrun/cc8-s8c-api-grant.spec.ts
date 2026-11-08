import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { apiBranch, type GitHubWrites } from '../../../src/collab-store/agentrun/github-tools';
import { authorize, assertPaths, grants, type WriteScope } from '../../../src/collab-store/agentrun/github-write/authorization';
import { createS7Tools } from '../../../src/collab-store/agentrun/github-write/tools';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

// CC8 S8c : vérification du mandat Gemini, sans appel réseau ni modification d'environnement.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const BASE = 'mcp/105856986/cc3-integration';
const BASE_SHA = 'a'.repeat(40);
const BRANCH = 'mcp/105856986/gemini-api-s8c-cron-monitor';
const TASK = 'S8c-cron-monitor';
const PATHS = [
  "src/index.ts",
  "src/collab-store/controller/scheduled.ts",
  "src/collab-store/controller/monitor/",
  "src/collab-store/agentrun/event-monitor.ts",
  "test/collab-store/controller/cc8-monitor/",
  "test/collab-store/agentrun/cc8-cron-monitor.spec.ts",
  "docs/collaboration/cc8/s8c-monitor.md"
] as const;
const ACCEPTANCE = [
  "Le cron */15 reste un moniteur et ne lance aucun run, retry ou appel de modèle.",
  "Les incidents D1 sont typés et dédoublonnés, avec HALT, CAS et droits respectés.",
  "Des tests déterministes prouvent absence d'exécution directe et limites de périmètre."
] as const;
const GRANT = {
  cycle: 'cc8-systeme-unique', task: TASK, participant: 'gemini', branch: BRANCH,
  paths: [...PATHS], mission: 'functional', acceptance: [...ACCEPTANCE],
};
const LEGACY = { cycle: 'cc8-systeme-unique', task: 'S7-live-gemini',
  participant: 'gemini', branch: 'mcp/105856986/gemini-api-s7-live',
  paths: ['test/collab-store/agentrun/s7-live-gemini.spec.ts'] };
const policy = (...items: object[]) => ({ writers: 'gemini,vibe', tasks: JSON.stringify(items) });

describe('CC8 S8c — mandat GitHub du moniteur API', () => {
  it('branche API figée, deux mandats S7 historiques préservés, mission fonctionnelle', () => {
    expect(apiBranch('gemini', 's8c-cron-monitor')).toBe(BRANCH);
    const parsed = grants(policy(LEGACY, GRANT));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(LEGACY);
    expect(parsed[1]).toMatchObject({ cycle: GRANT.cycle, task: TASK,
      participant: 'gemini', branch: BRANCH, mission: 'functional', acceptance: [...ACCEPTANCE] });
    expect(parsed[1].paths).toEqual([...PATHS]);
    expect(() => grants(policy({ ...GRANT, mission: 'functional', acceptance: [] }))).toThrow('api_write_policy_invalid');
  });

  it('intersection stricte : pas de chemins B, A, secrets ni branche élargie', () => {
    const scope: WriteScope = { ...GRANT, run_id: 's8c-test-run', owned_paths: [...PATHS] };
    for (const path of ['src/index.ts', 'src/collab-store/controller/scheduled.ts',
      'src/collab-store/controller/monitor/a.ts', 'test/collab-store/controller/cc8-monitor/one.spec.ts',
      'docs/collaboration/cc8/s8c-monitor.md']) {
      expect(() => assertPaths(scope, [path]), path).not.toThrow();
    }
    for (const path of ['wrangler.jsonc', 'master', 'src/collab-store/agentrun/engine.ts',
      'src/collab-store/agentrun/wake-trigger.ts', 'src/collab-store/agentrun/schema.ts',
      '.github/workflows/deploy.yml', 'src/collab-store/controller/monitoring.ts',
      'src/collab-store/controller/monitor/../secrets.ts', 'test/collab-store/agentrun/cc8-s8c-api-grant.spec.ts']) {
      expect(() => assertPaths(scope, [path]), path).toThrow('api_write_outside_task');
    }
    const narrower: WriteScope = { ...scope, owned_paths: ['docs/collaboration/cc8/s8c-monitor.md'] };
    expect(() => assertPaths(narrower, ['src/index.ts'])).toThrow('api_write_outside_task');
  });

  it('échec certain sans grant, refus du mauvais nom/cycle et aucun effet GitHub', async () => {
    const cycle = 's8c-grant-' + crypto.randomUUID();
    const runId = 's8c-grant-run-' + crypto.randomUUID();
    const now = 1_990_000_000;
    await insertCycleRow(db, cycle, 'P6');
    await db.prepare("INSERT OR IGNORE INTO participants (participant_id, display_label, status) VALUES ('gemini', 'gemini', 'active')").run();
    await insertPhaseDefinition(db, cycle, 'P6', []);
    await insertTaskRow(db, { cycle, taskId: TASK, owner: 'gemini', reviewer: 'vibe', tester: 'grok' });
    await db.prepare("UPDATE tasks SET status='in_progress', owned_paths=?3 WHERE cycle_id=?1 AND task_id=?2")
      .bind(cycle, TASK, JSON.stringify(PATHS)).run();
    expect((await createRun(db, { runId, cycleId: cycle, participantId: 'gemini', taskId: TASK,
      taskKind: 'implement', prompt: 'S8c API grant test', maxSteps: 12, maxTokens: 48000,
      maxCostCents: 0, deadlineAt: now + 2700, now })).created).toBe(true);
    let githubCalls = 0;
    const writes = {
      async branchHead(_repo: string, name: string) { githubCalls++; return name === BASE ? BASE_SHA : null; },
    } as GitHubWrites;
    const options = { db, repository: 'rfkevin/github-mcp', baseBranch: BASE, writes };
    const ctx = { run_id: runId, effect_key: 'e'.repeat(64) };
    const call = { id: 'scope', name: 'github_write_scope', args: {} };
    const without = createS7Tools(options, { policy: policy(LEGACY), reads: null, checks: null });
    await expect(without.execute(call, ctx)).rejects.toThrow('api_task_not_enabled');
    expect(githubCalls).toBe(0);

    const enabled = policy({ ...GRANT, cycle });
    await expect(authorize(db, enabled, runId, BRANCH + '-other')).rejects.toThrow('api_task_not_enabled');
    await expect(authorize(db, enabled, runId, BRANCH)).resolves.toMatchObject({ task: TASK, participant: 'gemini' });
    const tool = createS7Tools(options, { policy: enabled, reads: null, checks: null });
    await expect(tool.execute(call, ctx)).resolves.toMatchObject({
      branch: BRANCH, base_branch: BASE, base_sha: BASE_SHA, granted_paths: [...PATHS],
      task_paths: [...PATHS], corrections_remaining: 3,
    });
    expect(githubCalls).toBe(2); // lecture seule des têtes base et branche, aucun commit.
    await db.prepare("UPDATE tasks SET status='blocked' WHERE cycle_id=?1 AND task_id=?2").bind(cycle, TASK).run();
    await expect(tool.execute(call, ctx)).rejects.toThrow('api_write_task_inactive');
    expect(githubCalls).toBe(2);
  });
});
