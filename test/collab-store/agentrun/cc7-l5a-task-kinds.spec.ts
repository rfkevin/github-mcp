import { PLAN_MODEL } from './plan-model';
import { attemptRunId, answerAttemptRunId } from '../../../src/collab-store/agentrun/plan';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  planAgentRuns, taskRunId, taskPrompt, createRun, createReadToolHost, createGitHubWriteTools, GitHubWriteRefused,
  READ_TOOLS_BY_KIND, WRITE_TOOL_SCHEMAS, DIFF_MAX_FILES, DIFF_PATCH_CHARS, DEFAULT_API_BASE_BRANCH,
  ToolRefused, type GitHubReads, type GitHubWrites,
} from '../../../src/collab-store/agentrun';
import { insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

// CC-7 L5a (S9) — réveils de tâche du contrôleur vers le canal API : types review / test /
// implement au run_id déterministe, github_diff borné pour le couple head/base exact,
// github_open_pr (PR prête, jamais de fusion). Aucun verdict D12 n'est émis par ce canal.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_990_000_000;
const REPO = 'rfkevin/github-mcp';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const KEY = (c: string) => c.repeat(64);
let n = 0;
const uniq = (label: string) => '0000-l5a-' + label + '-' + (++n) + '-' + Date.now().toString(36);

/** Soumission d'un auteur : PR + couple head/base exacts (controller/facts.ts → Submission). */
const submission = { task: 'l5', pr: 300, state: 'SUBMITTED', source: 'github', head: HEAD, base: BASE };

interface SeededEvent { type: string; participant: string; role: string; payload: unknown }

/** Cycle ouvert en P6 avec la tâche l5 (owner/reviewer/tester) et les événements donnés, en ordre de seq croissant. */
async function seedTask(label: string, events: (pids: { owner: string; reviewer: string; tester: string }) => SeededEvent[]) {
  const cycle = uniq(label);
  const pids = { owner: 'l5a-own-' + n, reviewer: 'l5a-rev-' + n, tester: 'l5a-tst-' + n };
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: 'l5', cycle, ...pids });
  for (const [index, event] of events(pids).entries()) {
    await insertEventRow(db, { cycle, type: event.type, participant: event.participant, role: event.role,
      payload: event.payload, key: cycle + ':e' + index, expectedRev: 1 });
  }
  return { cycle, ...pids };
}

async function newRun(cycle: string, participant: string, kind: string, at = T) {
  const runId = 'l5a-run-' + (++n) + '-' + Date.now().toString(36);
  const created = await createRun(db, { runId, cycleId: cycle, participantId: participant, taskId: 'l5', taskKind: kind,
    prompt: 'p', maxSteps: 10, maxTokens: 1_000_000, maxCostCents: 0, deadlineAt: at + 86_400, now: at });
  expect(created.created).toBe(true);
  return runId;
}

/** Lectures GitHub minimales : compareRefs rend 51 fichiers, le premier à patch long. */
function fakeReads() {
  const calls: string[] = [];
  const github: GitHubReads & { calls: string[] } = {
    calls,
    async getTextFile(repository, path) { return { path, sha: 'e'.repeat(40), size: 1, content: 'x' }; },
    async getPullRequest(repository, number) { return { number }; },
    async listCheckRuns() { return []; },
    async compareRefs(repository, base, head) {
      calls.push('diff:' + repository + ':' + base + '..' + head);
      return { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, commits: [],
        files: Array.from({ length: DIFF_MAX_FILES + 1 }, (_unused, index) => ({
          filename: 'f' + index + '.txt', status: 'modified', additions: 1, deletions: 0,
          patch: index === 0 ? 'p'.repeat(DIFF_PATCH_CHARS + 1000) : '@@ -1 +1 @@',
        })) };
    },
  };
  return github;
}

/** Écritures GitHub minimales : seules la branche et la PR prête font quelque chose. */
function fakeWrites() {
  const prs: Array<{ number: number; branch: string; draft: boolean; body: string }> = [];
  const refs = new Map<string, string>();
  const unused = () => { throw new GitHubWriteRefused('UNREACHABLE'); };
  const writes: GitHubWrites = {
    branchHead: async (_repo, branch) => refs.get(branch) ?? null,
    createBranch: async (_repo, branch, _base, sha) => { refs.set(branch, sha); return { sha }; },
    commitFiles: unused, recentCommits: async () => [], openDraftPullRequest: unused,
    openPullRequest: async (_repo, branch, _base, _title, body) => {
      if (prs.some(pr => pr.branch === branch)) throw new GitHubWriteRefused('CONFLICT');
      const pr = { number: 300 + prs.length, branch, draft: false, body };
      prs.push(pr);
      return { number: pr.number, head_sha: refs.get(branch)! };
    },
    findPullRequest: async (_repo, branch) => {
      const pr = prs.find(item => item.branch === branch);
      return pr ? { number: pr.number, head_sha: refs.get(branch)!, draft: pr.draft } : null;
    },
  };
  return { writes, prs };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolRefused);
    return (error as Error).message;
  }
  throw new Error('refus attendu');
}

describe('CC-7 L5a — planification des réveils de tâche', () => {
  it('review et test : exécutions typées au run_id déterministe, prompt au couple exact ; rejeu = aucune seconde', async () => {
    const q = await seedTask('review-test', pids => [
      { type: 'evidence.add', participant: pids.owner, role: 'owner', payload: submission },
    ]);
    const out = await planAgentRuns(db, { ...PLAN_MODEL, AGENT_RUN_PARTICIPANTS: q.reviewer + ',' + q.tester }, { now: T });
    expect(out.created).toBe(2);
    const rows = (await db.prepare('SELECT run_id, task_id, task_kind, status, prompt, max_cost_cents FROM agent_runs WHERE cycle_id = ?1')
      .bind(q.cycle).all<{ run_id: string; task_id: string; task_kind: string; status: string; prompt: string; max_cost_cents: number }>()).results;
    expect(rows.map(row => row.run_id).sort()).toEqual([
      await attemptRunId('review', q.cycle, q.reviewer, 'l5', HEAD + '..' + BASE, 'P6', 0, 1),
      await attemptRunId('test', q.cycle, q.tester, 'l5', HEAD + '..' + BASE, 'P6', 0, 1),
    ].sort());
    for (const kind of ['review', 'test'] as const) {
      const run = rows.find(row => row.task_kind === kind)!;
      expect(run).toMatchObject({ task_id: 'l5', status: 'running', max_cost_cents: 0 });
      expect(run.prompt).toContain('head ' + HEAD);
      expect(run.prompt).toContain('base ' + BASE);
      expect(run.prompt).toContain('github_diff');
    }
    const again = await planAgentRuns(db, { ...PLAN_MODEL, AGENT_RUN_PARTICIPANTS: q.reviewer + ',' + q.tester }, { now: T + 10 });
    expect(again.created).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM agent_runs WHERE cycle_id = ?1').bind(q.cycle).first<{ c: number }>())!.c).toBe(2);
  });

  it('implement sans soumission : une exécution pour l’auteur, rien pour le relecteur sans décision', async () => {
    const q = await seedTask('implement', () => []);
    const out = await planAgentRuns(db, { ...PLAN_MODEL, AGENT_RUN_GITHUB_WRITES: 'true', AGENT_RUN_PARTICIPANTS: q.owner + ',' + q.reviewer }, { now: T });
    expect(out.created).toBe(1);
    const runId = await attemptRunId('implement', q.cycle, q.owner, 'l5', 'none', 'P6', 0, 1);
    const run = (await db.prepare('SELECT task_kind, prompt FROM agent_runs WHERE run_id = ?1').bind(runId)
      .first<{ task_kind: string; prompt: string }>())!;
    expect(run.task_kind).toBe('implement');
    expect(run.prompt).toContain('github_open_pr');
    expect(run.prompt).toContain('Fait / Reste / Appris');
    expect((await db.prepare('SELECT COUNT(*) AS c FROM agent_runs WHERE cycle_id = ?1 AND participant_id = ?2')
      .bind(q.cycle, q.reviewer).first<{ c: number }>())!.c).toBe(0);
  });

  it('renew_verdict : verdict antérieur à la soumission → le relecteur reprend en type review', async () => {
    const q = await seedTask('renew', pids => [
      { type: 'evidence.add', participant: pids.reviewer, role: 'reviewer',
        payload: { task: 'l5', pr: 299, state: 'AGREE', head: 'c'.repeat(40), base: 'd'.repeat(40) } },
      { type: 'evidence.add', participant: pids.owner, role: 'owner', payload: submission },
    ]);
    const out = await planAgentRuns(db, { ...PLAN_MODEL, AGENT_RUN_PARTICIPANTS: q.reviewer }, { now: T });
    expect(out.created).toBe(1);
    const runId = await attemptRunId('review', q.cycle, q.reviewer, 'l5', HEAD + '..' + BASE, 'P6', 0, 1);
    expect((await db.prepare('SELECT task_kind FROM agent_runs WHERE run_id = ?1').bind(runId)
      .first<{ task_kind: string }>())!.task_kind).toBe('review');
  });

  it('taskPrompt : le couple exact figure en clair pour le relecteur ; aucun verdict ni réponse demandés', () => {
    const prompt = taskPrompt('review', 'cc7-api-auto', 'l5', HEAD + '..' + BASE);
    expect(prompt).toContain(HEAD);
    expect(prompt).toContain(BASE);
    expect(prompt).not.toContain('store_answer');
    expect(taskPrompt('implement', 'cc7-api-auto', 'l5', 'none')).toContain('github_commit_files');
    expect(taskPrompt('test', 'cc7-api-auto', 'l5', HEAD + '..' + BASE)).toContain('github_check_runs');
  });
});

describe('CC-7 L5a — outils review, github_diff et github_open_pr', () => {
  it('allowlist review/test : lectures GitHub, clarifications store uniquement, pas de verdict générique', () => {
    const host = createReadToolHost({ db, repository: REPO, github: fakeReads(), storeWrites: true });
    for (const kind of ['review', 'test'] as const) {
      expect(host.list(kind)).toEqual([...READ_TOOLS_BY_KIND[kind], 'store_ask', 'store_answer']);
      for (const name of READ_TOOLS_BY_KIND[kind]) expect(host.spec(kind, name)).toEqual({ name, effect: 'read' });
      for (const name of ['store_ask', 'store_answer']) {
        expect(host.spec(kind, name)).toEqual({ name, effect: 'write' });
      }
      for (const write of ['store_task_status', 'github_commit_files', 'github_open_pr', 'evidence.add']) {
        expect(host.spec(kind, write)).toBeNull();
      }
    }
    // Sans dépôt ni client GitHub, aucun outil GitHub n'est proposé (deny-by-default).
    expect(createReadToolHost({ db, repository: null, github: null, storeWrites: true }).list('review'))
      .toEqual(['store_context', 'store_delta', 'store_ask', 'store_answer']);
    // L5b décidera des verdicts serveur : aucun store_verdict ni store_submit n’existe encore.
    expect(WRITE_TOOL_SCHEMAS.some(schema => /verdict|submit/.test(schema.name))).toBe(false);
  });

  it('github_diff : head doit être un SHA de 40 caractères ; bornage des fichiers et des patchs', async () => {
    const q = await seedTask('diff', () => []);
    const runId = await newRun(q.cycle, q.reviewer, 'review');
    const github = fakeReads();
    const host = createReadToolHost({ db, repository: REPO, github });
    const call = (args: Record<string, unknown>) => host.execute({ id: 'd', name: 'github_diff', args }, { run_id: runId });
    expect(await refusal(call({ base: BASE, head: 'main' }))).toContain('head');
    // API : 3 fichiers par défaut ; accéder ensuite à toute la liste et au patch entier.
    const diff = await call({ base: BASE, head: HEAD }) as {
      files: Array<{ patch: string; patch_truncated: boolean; patch_next_offset: number | null }>;
      files_truncated: boolean; next_file_offset: number | null; files_available: number;
      total_commits: number;
    };
    expect(diff.files).toHaveLength(3);
    expect(diff.files_available).toBe(DIFF_MAX_FILES + 1);
    expect(diff.next_file_offset).toBe(3);
    expect(diff.files_truncated).toBe(true);
    expect(diff.files[0].patch.length).toBe(DIFF_PATCH_CHARS);
    expect(diff.files[0].patch_truncated).toBe(true);
    expect(diff.files[0].patch_next_offset).toBe(DIFF_PATCH_CHARS);
    const patchTail = await call({ base: BASE, head: HEAD, file_offset: 0, file_limit: 1,
      patch_offset: DIFF_PATCH_CHARS }) as {
        files: Array<{ patch: string; patch_next_offset: number | null }>;
      };
    expect(patchTail.files[0].patch).toBe('p'.repeat(1000));
    expect(patchTail.files[0].patch_next_offset).toBeNull();
    const last = await call({ base: BASE, head: HEAD, file_offset: DIFF_MAX_FILES, file_limit: 1 }) as {
      files: Array<{ filename: string }>; files_truncated: boolean; next_file_offset: number | null;
    };
    expect(last.files.map(f => f.filename)).toEqual(['f50.txt']);
    expect(last.files_truncated).toBe(false);
    expect(last.next_file_offset).toBeNull();
    expect(diff.total_commits).toBe(1);
    // Prelecture du contrôleur S7 : contrat historique conservé, toujours avec indicateurs de coupe.
    const internal = await host.execute({ id: 'pre', name: 'github_diff', args: { base: BASE, head: HEAD } },
      { run_id: runId, prefetch: true }) as {
        files: Array<{ patch: string; patch_truncated: boolean }>; files_truncated: boolean;
      };
    expect(internal.files).toHaveLength(DIFF_MAX_FILES);
    expect(internal.files[0].patch.length).toBe(DIFF_PATCH_CHARS);
    expect(internal.files[0].patch_truncated).toBe(true);
    expect(internal.files[DIFF_MAX_FILES - 1].patch_truncated).toBe(false);
    expect(internal.files_truncated).toBe(true);
    expect(github.calls).toHaveLength(4);
  });

  it('github_open_pr : PR prête avec pied de page D12, lookup au draft false, seconde ouverture = conflit certain', async () => {
    const q = await seedTask('open-pr', () => []);
    // S7 : ce scénario historique doit posséder un mandat serveur valide.
    await db.prepare("UPDATE tasks SET status = 'in_progress', owned_paths = ?1 WHERE cycle_id = ?2 AND task_id = 'l5'")
      .bind(JSON.stringify(['src/collab-store/agentrun/']), q.cycle).run();
    const runId = await newRun(q.cycle, q.owner, 'implement');
    const gh = fakeWrites();
    const tools = createGitHubWriteTools({ db, repository: REPO, writes: gh.writes, baseBranch: DEFAULT_API_BASE_BRANCH });
    await tools.execute({ id: 'b', name: 'github_create_branch', args: { name: 'l5a', base_sha: BASE } }, { run_id: runId, effect_key: KEY('1') });
    const ready = { id: 'p', name: 'github_open_pr', args: { name: 'l5a', title: 'L5a : task kinds' } };
    expect(await tools.lookup(ready, { run_id: runId, effect_key: KEY('2') })).toEqual({ found: false });
    const pr = await tools.execute(ready, { run_id: runId, effect_key: KEY('2') }) as { draft: boolean; base: string };
    expect(pr).toMatchObject({ draft: false, base: DEFAULT_API_BASE_BRANCH });
    expect(gh.prs[0].draft).toBe(false);
    expect(gh.prs[0].body).toContain('PR prête ouverte par une exécution API');
    expect(gh.prs[0].body).toContain('fusion par le propriétaire uniquement');
    expect(gh.prs[0].body).toContain('Agent-Effect: ' + '2'.repeat(32));
    expect(await tools.lookup(ready, { run_id: runId, effect_key: KEY('2') })).toMatchObject({ found: true, result: { draft: false } });
    // Une seconde PR sur la même branche est refusée avant l'appel : conflit certain, jamais de résolution.
    expect(await refusal(tools.execute({ id: 'p2', name: 'github_open_pr', args: { name: 'l5a', title: 'bis' } }, { run_id: runId, effect_key: KEY('3') }))).toBe('CONFLICT');
    expect(gh.prs).toHaveLength(1);
  });
});
