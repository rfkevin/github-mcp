import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  runStep, createRun, createReadToolHost, createGitHubWriteTools, apiBranch, effectTrailer, GitHubWriteRefused, ToolRefused,
  GITHUB_WRITE_TOOLS_BY_KIND, READ_TOOLS_BY_KIND, WRITE_TOOLS_BY_KIND, DEFAULT_API_BASE_BRANCH,
  type GitHubWrites, type ModelClient, type ModelOutput,
} from '../../../src/collab-store/agentrun';
import { engineFor, apiBaseBranch, AGENT_RUN_SYSTEM } from '../../../src/collab-store/agentrun/object';
import { githubWritesFrom } from '../../../src/agent-run-object';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-5 l7 incrément 7c-3 — écritures GitHub des exécutions API : branche de l'agent seulement,
// expectedHeadSha obligatoire, PR brouillon seulement, aucune fusion ni résolution de conflit,
// effets idempotents (nom de branche, trailer de commit, tête de PR) et lookup avant réessai.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_980_000_000;
const REPO = 'rfkevin/github-mcp';
const BASE = DEFAULT_API_BASE_BRANCH;
const BASE_SHA = 'b'.repeat(40);
const KEY = (c: string) => c.repeat(64);
let n = 0;

interface FakeCommit { sha: string; message: string; parent: string | null }

/** Faux GitHub en mémoire : refs, commits chaînés, PR ; mêmes refus certains que l'adaptateur de la racine. */
function fakeGitHub() {
  const commits = new Map<string, FakeCommit>();
  const refs = new Map<string, string>();
  const prs: Array<{ number: number; branch: string; base: string; title: string; body: string; draft: boolean }> = [];
  const calls: string[] = [];
  let counter = 0;
  const hex = () => (++counter).toString(16).padStart(40, 'c');
  let parent: string | null = null;
  for (const message of ['racine', 'histoire', 'base']) {
    const sha = message === 'base' ? BASE_SHA : hex();
    commits.set(sha, { sha, message, parent });
    parent = sha;
  }
  refs.set(BASE, BASE_SHA);
  const writes: GitHubWrites & { failNext?: Error } = {
    async branchHead(_repo, branch) { calls.push('head:' + branch); return refs.get(branch) ?? null; },
    async createBranch(_repo, branch, base, expectedBaseSha) {
      calls.push('create:' + branch + '<-' + base);
      if (refs.has(branch)) throw new GitHubWriteRefused('CONFLICT');
      if (refs.get(base) !== expectedBaseSha) throw new GitHubWriteRefused('BASE_CHANGED');
      refs.set(branch, expectedBaseSha);
      return { sha: expectedBaseSha };
    },
    async commitFiles(_repo, branch, expectedHeadSha, message, files) {
      calls.push('commit:' + branch + ':' + files.map(f => f.path).join(','));
      const head = refs.get(branch);
      if (!head || head !== expectedHeadSha) throw new GitHubWriteRefused('CONFLICT');
      const sha = hex();
      commits.set(sha, { sha, message, parent: head });
      refs.set(branch, sha);
      if (writes.failNext) { const error = writes.failNext; writes.failNext = undefined; throw error; }
      return { commit_sha: sha };
    },
    async recentCommits(_repo, branch, limit) {
      const out: Array<{ sha: string; message: string }> = [];
      let cursor = refs.get(branch) ?? null;
      while (cursor && out.length < limit) {
        const commit = commits.get(cursor)!;
        out.push({ sha: commit.sha, message: commit.message });
        cursor = commit.parent;
      }
      return out;
    },
    async openDraftPullRequest(_repo, branch, base, title, body) {
      calls.push('pr:' + branch + '->' + base);
      if (prs.some(pr => pr.branch === branch)) throw new GitHubWriteRefused('CONFLICT');
      const pr = { number: 300 + prs.length, branch, base, title, body, draft: true };
      prs.push(pr);
      return { number: pr.number, head_sha: refs.get(branch)! };
    },
    async findPullRequest(_repo, branch) {
      const pr = prs.find(item => item.branch === branch);
      return pr ? { number: pr.number, head_sha: refs.get(branch)! } : null;
    },
  };
  return { writes, refs, commits, prs, calls };
}

async function newRun(participant: string, kind = 'implement') {
  await ensureSchema(db);
  const runId = 'l7c3-run-' + (++n) + '-' + Date.now().toString(36);
  const created = await createRun(db, { runId, cycleId: 'l7c3-cycle-' + n, participantId: participant, taskId: 'l7', taskKind: kind,
    prompt: 'p', maxSteps: 10, maxTokens: 1_000_000, maxCostCents: 0, deadlineAt: T + 86_400, now: T });
  expect(created.created).toBe(true);
  return runId;
}

function scripted(outputs: ModelOutput[]): ModelClient {
  let i = 0;
  return { async complete() { return { output: outputs[i++] ?? { text: 'fin', tool_calls: [] }, usage: { tokens: 10, cost_cents: 0 } }; } };
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

describe('CC-5 l7c-3 — allowlist et branche de l’agent', () => {
  it('écritures GitHub seulement pour implement, avec un dépôt et l’adaptateur ; aucun outil de fusion, approbation ou résolution', () => {
    const { writes } = fakeGitHub();
    const host = createReadToolHost({ db, repository: REPO, github: null, storeWrites: true, githubWrites: { writes, baseBranch: BASE } });
    expect(host.list('implement')).toEqual(['store_context', 'store_delta', 'store_task_status', 'github_create_branch', 'github_commit_files', 'github_open_draft_pr']);
    for (const name of ['github_create_branch', 'github_commit_files', 'github_open_draft_pr']) {
      expect(host.spec('implement', name)).toEqual({ name, effect: 'write' });
      for (const kind of ['answer', 'planning', 'status', 'research']) expect(host.spec(kind, name)).toBeNull();
    }
    expect(createReadToolHost({ db, repository: null, github: null, storeWrites: true, githubWrites: { writes, baseBranch: BASE } }).list('implement'))
      .toEqual(['store_context', 'store_delta', 'store_task_status']);
    expect(createReadToolHost({ db, repository: REPO, github: null, storeWrites: true }).list('implement'))
      .toEqual(['store_context', 'store_delta', 'store_task_status']);
    const every = [...Object.values(GITHUB_WRITE_TOOLS_BY_KIND), ...Object.values(WRITE_TOOLS_BY_KIND), ...Object.values(READ_TOOLS_BY_KIND)].flat();
    expect(every.some(name => /merge|resolve|approve|conflict|delete|force/i.test(name))).toBe(false);
    expect(() => createGitHubWriteTools({ db, repository: REPO, writes, baseBranch: 'main' })).toThrow();
    expect(() => createGitHubWriteTools({ db, repository: REPO, writes, baseBranch: 'Master' })).toThrow();
  });

  it('branche construite depuis le participant : préfixe figé, nom borné, participant non conforme refusé', () => {
    expect(apiBranch('vibe', 'fix-quota')).toBe('mcp/105856986/vibe-api-fix-quota');
    expect(() => apiBranch('agent:x', 'a')).toThrow(ToolRefused);
    expect(() => apiBranch('Vibe', 'a')).toThrow(ToolRefused);
    expect(() => apiBranch('vibe', '../main')).toThrow(ToolRefused);
    expect(() => apiBranch('vibe', 'a/b')).toThrow(ToolRefused);
    expect(() => apiBranch('vibe', 'x'.repeat(33))).toThrow(ToolRefused);
    expect(() => apiBranch('a'.repeat(24), 'x'.repeat(30))).toThrow(ToolRefused);
    expect(effectTrailer(KEY('d'))).toBe('Agent-Effect: ' + 'd'.repeat(32));
  });
});

describe('CC-5 l7c-3 — parcours et refus', () => {
  it('parcours moteur réel : branche, commit tracé, PR brouillon vers la base de l’hôte ; arguments étrangers ignorés', async () => {
    const gh = fakeGitHub();
    const runId = await newRun('grok');
    const host = createReadToolHost({ db, repository: REPO, github: null, storeWrites: true, githubWrites: { writes: gh.writes, baseBranch: BASE } });
    const branch = 'mcp/105856986/grok-api-l7e';
    const model = scripted([
      { text: '', tool_calls: [{ id: 'b', name: 'github_create_branch', args: { name: 'l7e', base_sha: BASE_SHA } }] },
      { text: '', tool_calls: [{ id: 'c', name: 'github_commit_files', args: { name: 'l7e', expected_head_sha: BASE_SHA, message: 'l7e : vue des exécutions',
        files: [{ path: 'src/collab-store/owner/runs.ts', content: 'export {};\n' }] } }] },
      { text: '', tool_calls: [{ id: 'p', name: 'github_open_draft_pr', args: { name: 'l7e', title: 'l7e brouillon', body: 'Résumé.' } }] },
      { text: 'PR brouillon ouverte.', tool_calls: [] },
    ]);
    const deps = { model, tools: host, now: () => T, workerId: 'w1' };
    for (let i = 0; i < 3; i += 1) expect((await runStep(db, runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, runId, deps)).outcome).toBe('completed');
    const head = gh.refs.get(branch)!;
    expect(head).not.toBe(BASE_SHA);
    const commit = gh.commits.get(head)!;
    expect(commit.parent).toBe(BASE_SHA);
    expect(commit.message.startsWith('l7e : vue des exécutions\n\nAgent-Effect: ')).toBe(true);
    expect(gh.prs).toEqual([expect.objectContaining({ branch, base: BASE, draft: true, title: 'l7e brouillon' })]);
    expect(gh.prs[0].body).toContain('Aucune fusion par le canal API');
    const effects = (await db.prepare('SELECT tool, status FROM agent_run_effects WHERE run_id = ?1 ORDER BY n').bind(runId).all<{ tool: string; status: string }>()).results;
    expect(effects).toEqual([
      { tool: 'github_create_branch', status: 'completed' }, { tool: 'github_commit_files', status: 'completed' }, { tool: 'github_open_draft_pr', status: 'completed' },
    ]);
    // Le modèle ne choisit ni le dépôt, ni la branche complète, ni la base : un argument en trop est refusé par le schéma
    // côté fournisseur et, en code, la branche ne vient que du participant et du nom.
    expect(gh.calls.every(call => !call.includes('main'))).toBe(true);
  });

  it('expectedHeadSha obligatoire ; tête avancée = conflit certain (ToolRefused), aucun commit, jamais de résolution', async () => {
    const gh = fakeGitHub();
    const runId = await newRun('vibe');
    const tools = createGitHubWriteTools({ db, repository: REPO, writes: gh.writes, baseBranch: BASE });
    await tools.execute({ id: 'b', name: 'github_create_branch', args: { name: 'x', base_sha: BASE_SHA } }, { run_id: runId, effect_key: KEY('1') });
    const commit = (args: Record<string, unknown>, key: string) => tools.execute({ id: 'c', name: 'github_commit_files',
      args: { name: 'x', message: 'm', files: [{ path: 'a.txt', content: 'a' }], ...args } }, { run_id: runId, effect_key: KEY(key) });
    expect(await refusal(commit({}, '2'))).toContain('expected_head_sha');
    expect(await refusal(commit({ expected_head_sha: 'e'.repeat(40) }, '3'))).toBe('CONFLICT');
    expect(gh.refs.get('mcp/105856986/vibe-api-x')).toBe(BASE_SHA);
    expect(await refusal(tools.execute({ id: 'b', name: 'github_create_branch', args: { name: 'y', base_sha: 'e'.repeat(40) } },
      { run_id: runId, effect_key: KEY('4') }))).toBe('BASE_CHANGED');
    expect(gh.refs.has('mcp/105856986/vibe-api-y')).toBe(false);
  });

  it('chemins interdits au canal API refusés avant tout appel : journaux, workflows, scripts, wrangler, migrations', async () => {
    const gh = fakeGitHub();
    const runId = await newRun('vibe');
    const tools = createGitHubWriteTools({ db, repository: REPO, writes: gh.writes, baseBranch: BASE });
    for (const [path, key] of [['AGENT_MEMORY.md', '5'], ['.github/workflows/ci.yml', '6'], ['scripts/ci/run-checks.mjs', '7'],
      ['wrangler.jsonc', '8'], ['migrations/0001.sql', '9'], ['../etc/passwd', 'a'], ['TOOL_IMPROVEMENTS.md', 'b']] as const) {
      expect(await refusal(tools.execute({ id: 'c', name: 'github_commit_files', args: { name: 'x', expected_head_sha: BASE_SHA, message: 'm',
        files: [{ path, content: 'x' }] } }, { run_id: runId, effect_key: KEY(key) }))).toMatch(/path/);
    }
    expect(gh.calls).toEqual([]);
  });

  it('PR toujours brouillon, une seule par branche (seconde = conflit certain)', async () => {
    const gh = fakeGitHub();
    const runId = await newRun('vibe');
    const tools = createGitHubWriteTools({ db, repository: REPO, writes: gh.writes, baseBranch: BASE });
    await tools.execute({ id: 'b', name: 'github_create_branch', args: { name: 'pr', base_sha: BASE_SHA } }, { run_id: runId, effect_key: KEY('1') });
    const pr = await tools.execute({ id: 'p', name: 'github_open_draft_pr', args: { name: 'pr', title: 't', draft: false } }, { run_id: runId, effect_key: KEY('2') });
    expect(pr).toMatchObject({ draft: true, base: BASE });
    expect(gh.prs[0].draft).toBe(true);
    expect(await refusal(tools.execute({ id: 'p', name: 'github_open_draft_pr', args: { name: 'pr', title: 't2' } }, { run_id: runId, effect_key: KEY('3') }))).toBe('CONFLICT');
  });
});

describe('CC-5 l7c-3 — idempotence et lookup', () => {
  it('lookup de chaque effet : absent avant, trouvé après, par la même empreinte', async () => {
    const gh = fakeGitHub();
    const runId = await newRun('vibe');
    const tools = createGitHubWriteTools({ db, repository: REPO, writes: gh.writes, baseBranch: BASE });
    const create = { id: 'b', name: 'github_create_branch', args: { name: 'lk', base_sha: BASE_SHA } };
    const commit = { id: 'c', name: 'github_commit_files', args: { name: 'lk', expected_head_sha: BASE_SHA, message: 'm', files: [{ path: 'a.txt', content: 'a' }] } };
    const pr = { id: 'p', name: 'github_open_draft_pr', args: { name: 'lk', title: 't' } };
    expect(await tools.lookup(create, { run_id: runId, effect_key: KEY('1') })).toEqual({ found: false });
    expect(await tools.lookup(commit, { run_id: runId, effect_key: KEY('2') })).toEqual({ found: false });
    await tools.execute(create, { run_id: runId, effect_key: KEY('1') });
    expect(await tools.lookup(create, { run_id: runId, effect_key: KEY('1') })).toMatchObject({ found: true, result: { sha: BASE_SHA } });
    // Branche présente, tête = expected_head_sha : le commit n'a certainement pas eu lieu.
    expect(await tools.lookup(commit, { run_id: runId, effect_key: KEY('2') })).toEqual({ found: false });
    const done = await tools.execute(commit, { run_id: runId, effect_key: KEY('2') }) as { commit_sha: string };
    expect(await tools.lookup(commit, { run_id: runId, effect_key: KEY('2') })).toEqual({ found: true, result: expect.objectContaining({ commit_sha: done.commit_sha }) });
    // Autre clé d'effet : son trailer n'existe pas et la remontée atteint expected_head_sha.
    expect(await tools.lookup(commit, { run_id: runId, effect_key: KEY('9') })).toEqual({ found: false });
    expect(await tools.lookup(pr, { run_id: runId, effect_key: KEY('3') })).toEqual({ found: false });
    await tools.execute(pr, { run_id: runId, effect_key: KEY('3') });
    expect(await tools.lookup(pr, { run_id: runId, effect_key: KEY('3') })).toMatchObject({ found: true, result: { draft: true } });
  });

  it('commit écrit mais réponse perdue : effet ambigu, puis lookup le retrouve sans second commit', async () => {
    const gh = fakeGitHub();
    const runId = await newRun('vibe');
    const tools = createGitHubWriteTools({ db, repository: REPO, writes: gh.writes, baseBranch: BASE });
    await tools.execute({ id: 'b', name: 'github_create_branch', args: { name: 'lost', base_sha: BASE_SHA } }, { run_id: runId, effect_key: KEY('1') });
    const commit = { id: 'c', name: 'github_commit_files', args: { name: 'lost', expected_head_sha: BASE_SHA, message: 'm', files: [{ path: 'a.txt', content: 'a' }] } };
    gh.writes.failNext = new Error('network_reset');
    await expect(tools.execute(commit, { run_id: runId, effect_key: KEY('2') })).rejects.toThrow('network_reset');
    const found = await tools.lookup(commit, { run_id: runId, effect_key: KEY('2') });
    expect(found).toMatchObject({ found: true, result: { commit_sha: gh.refs.get('mcp/105856986/vibe-api-lost') } });
    // Un réessai aveugle serait refusé (tête avancée) : le moteur ne réessaie qu'après lookup négatif.
    expect(await refusal(tools.execute(commit, { run_id: runId, effect_key: KEY('2') }))).toBe('CONFLICT');
    expect([...gh.commits.values()].filter(c => c.message.includes(effectTrailer(KEY('2'))))).toHaveLength(1);
  });

  it('expected_head_sha hors de la fenêtre lue : lookup incertain (null), jamais un faux négatif', async () => {
    const gh = fakeGitHub();
    const runId = await newRun('vibe');
    const tools = createGitHubWriteTools({ db, repository: REPO, writes: gh.writes, baseBranch: BASE });
    await tools.execute({ id: 'b', name: 'github_create_branch', args: { name: 'far', base_sha: BASE_SHA } }, { run_id: runId, effect_key: KEY('1') });
    const lookup = await tools.lookup({ id: 'c', name: 'github_commit_files', args: { name: 'far', expected_head_sha: 'f'.repeat(40), message: 'm',
      files: [{ path: 'a.txt', content: 'a' }] } }, { run_id: runId, effect_key: KEY('2') });
    expect(lookup).toBeNull();
  });
});

describe('CC-5 l7c-3 — câblage', () => {
  it('écritures GitHub seulement avec AGENT_RUN_GITHUB_WRITES="true", un dépôt valide et l’adaptateur', () => {
    const { writes } = fakeGitHub();
    const ai = { async run() { return {}; } };
    const model = 'workers-ai:@cf/zai-org/glm-4.7-flash';
    const on = engineFor({ AGENT_RUN_MODEL: model, AI: ai, AGENT_RUN_REPOSITORY: REPO, AGENT_RUN_GITHUB_WRITES: 'true' }, db, null, writes)('r');
    expect(on.tools.list('implement')).toContain('github_commit_files');
    const off = engineFor({ AGENT_RUN_MODEL: model, AI: ai, AGENT_RUN_REPOSITORY: REPO }, db, null, writes)('r');
    expect(off.tools.list('implement').some(name => name.startsWith('github_') && name !== 'github_read_file')).toBe(false);
    const noRepo = engineFor({ AGENT_RUN_MODEL: model, AI: ai, AGENT_RUN_GITHUB_WRITES: 'true' }, db, null, writes)('r');
    expect(noRepo.tools.list('implement')).toEqual(['store_context', 'store_delta', 'store_task_status']);
    expect(AGENT_RUN_SYSTEM).toContain('jamais de fusion');
  });

  it('branche de base : défaut figé, jamais main ni master ; adaptateur racine absent sans identifiants', () => {
    expect(apiBaseBranch(undefined)).toBe(DEFAULT_API_BASE_BRANCH);
    expect(apiBaseBranch('main')).toBe(DEFAULT_API_BASE_BRANCH);
    expect(apiBaseBranch('MASTER')).toBe(DEFAULT_API_BASE_BRANCH);
    expect(apiBaseBranch('a..b')).toBe(DEFAULT_API_BASE_BRANCH);
    expect(apiBaseBranch('mcp/105856986/cc3-integration')).toBe('mcp/105856986/cc3-integration');
    expect(githubWritesFrom({}, REPO)).toBeNull();
    const writes = githubWritesFrom({ GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2', GITHUB_PRIVATE_KEY: 'test-only-not-a-key' }, REPO);
    expect(Object.keys(writes ?? {}).sort()).toEqual(['branchHead', 'commitFiles', 'createBranch', 'findPullRequest', 'openDraftPullRequest', 'recentCommits']);
  });
});
