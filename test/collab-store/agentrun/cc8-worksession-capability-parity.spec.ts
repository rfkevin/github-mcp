import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { createRun, type ToolHost } from '../../../src/collab-store/agentrun/engine';
import {
  createReadToolHost, requiredUnifiedCapability, runVerifiedClaims, READ_TOOLS_BY_KIND,
  READ_TOOL_SCHEMAS, CONTINUITY_TOOL_SCHEMAS, type ReadToolHostOptions, type RunScope,
} from '../../../src/collab-store/agentrun/read-tools';
import { resolveUnifiedCapabilities } from '../../../src/collab-store/agentrun/agent-capabilities';
import { WRITE_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/store-tools';
import { GITHUB_WRITE_TOOL_SCHEMAS, apiBranch, type GitHubWrites } from '../../../src/collab-store/agentrun/github-tools';
import { S7_SCHEMAS } from '../../../src/collab-store/agentrun/github-write/tools';
import { VERDICT_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/verdict-tools';
import { CONTRIBUTION_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/contribution-tools';
import { MODEL_CHOICE_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/model-choice-tools';
import { RESEARCH_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/research';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const NOW = 2_000_000_000;
/** c2c-author/reviewer/tester = titulaires ; c2c-intruder enregistré sans rôle ; c2c-answerer destinataire X13 sans tâche ; c2c-ghost absent de participants. */
const REGISTERED = ['c2c-author', 'c2c-reviewer', 'c2c-tester', 'c2c-intruder', 'c2c-answerer'];

async function seeded(input: { kind: string; participant: string; ownedPaths?: string; taskless?: boolean }): Promise<{ runId: string; scope: RunScope }> {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  for (const id of REGISTERED) {
    await db.prepare("INSERT OR IGNORE INTO participants (participant_id, display_label, status) VALUES (?1, ?1, 'active')").bind(id).run();
  }
  const cycleId = 'cc8-c2c-' + crypto.randomUUID();
  const taskId = 'c2c-task-' + crypto.randomUUID().slice(0, 8);
  await db.prepare("INSERT INTO cycles (cycle_id, project, phase, revision, status) VALUES (?1, 'rfkevin/github-mcp', 'P6', 1, 'open')").bind(cycleId).run();
  await db.prepare([
    'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid,',
    'status, owned_paths, target_ref, next_action, revision)',
    "VALUES (?1, ?2, 'c2c-author', 'c2c-reviewer', 'c2c-tester', 'in_progress', ?3, '', 'read source', 1)",
  ].join(' ')).bind(taskId, cycleId, input.ownedPaths ?? '["src/x.ts"]').run();
  const runId = 'c2c-run-' + crypto.randomUUID();
  const created = await createRun(db, {
    runId, cycleId, participantId: input.participant, taskId: input.taskless ? '' : taskId, taskKind: input.kind,
    prompt: 'Mission C2c.', maxSteps: 4, maxTokens: 5_000, maxCostCents: 0, deadlineAt: NOW + 900, now: NOW,
  });
  expect(created.created).toBe(true);
  return { runId, scope: { cycle_id: cycleId, participant_id: input.participant, task_id: input.taskless ? '' : taskId, task_kind: input.kind } };
}

const github = {
  getTextFile: async () => ({ path: 'src/x.ts', sha: 'b'.repeat(40), content: 'contenu', size: 8 }),
  getPullRequest: async () => ({ number: 1, state: 'open', head: {}, base: {} }),
  listCheckRuns: async () => [],
  compareRefs: async () => ({ status: 'identical', files: [] }),
};

const writes: GitHubWrites = {
  branchHead: async () => null,
  createBranch: async () => ({ sha: 'c'.repeat(40) }),
  commitFiles: async () => ({ commit_sha: 'd'.repeat(40) }),
  recentCommits: async () => [],
  openDraftPullRequest: async () => ({ number: 1, head_sha: 'e'.repeat(40) }),
  openPullRequest: async () => ({ number: 2, head_sha: 'f'.repeat(40) }),
  findPullRequest: async () => null,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('CC8 WorkSession C0 provider API parity', () => {
  it('WorkSession: le même catalogue pour author sur answer ou implement, selon les ressources', async () => {
    const answer = await seeded({ kind: 'answer', participant: 'c2c-author' });
    const implement = await seeded({ kind: 'implement', participant: 'c2c-author' });
    const host = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github,
      unifiedCapabilities: true, storeWrites: true, continuity: true, verdicts: true, contributions: true,
      githubWrites: { writes, baseBranch: 'mcp/105856986/cc3-integration',
        s7: { policy: { writers: 'c2c-author', tasks: '[]' }, reads: github, checks: null } },
    });
    const answerNames = host.list('answer');
    expect(answerNames).toEqual(host.list('implement'));
    for (const name of ['store_context', 'github_diff', 'github_read_file', 'github_write_scope',
      'github_commit_files', 'store_contribute', 'store_verdict', 'store_memory']) {
      expect(answerNames).toContain(name);
    }
    const diff = await host.execute({ id: 'diff', name: 'github_diff',
      args: { head: 'a'.repeat(40), base: 'b'.repeat(40) } }, { run_id: answer.runId });
    expect(diff).toHaveProperty('files');
    // Catalog availability alone never grants write rights without an actual task grant.
    await expect(host.execute({ id: 'write', name: 'github_write_scope', args: {} },
      { run_id: answer.runId, effect_key: 'b'.repeat(64) }))
      .rejects.toThrow(/capability_not_held:github\.write/);
    expect(implement.runId).toBeDefined();
  });

  it('WorkSession: auteur ayant un mandat GitHub valide, même si le run est answer', async () => {
    const answer = await seeded({ kind: 'answer', participant: 'c2c-author' });
    const branch = apiBranch('c2c-author', 'work');
    const grant = JSON.stringify([{ cycle: answer.scope.cycle_id, task: answer.scope.task_id,
      participant: 'c2c-author', branch, paths: ['src/x.ts'] }]);
    const writeHost = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github,
      unifiedCapabilities: true, githubWrites: {
        writes: { ...writes, branchHead: async (_repository: string, branch: string) =>
          branch === 'mcp/105856986/cc3-integration' ? 'a'.repeat(40) : null },
        baseBranch: 'mcp/105856986/cc3-integration',
        s7: { policy: { writers: 'c2c-author', tasks: grant }, reads: github, checks: null },
      },
    });
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, answer.scope, {
      db, repository: 'rfkevin/github-mcp', github, unifiedCapabilities: true,
      githubWrites: { writes, baseBranch: 'mcp/105856986/cc3-integration',
        s7: { policy: { writers: 'c2c-author', tasks: grant }, reads: github, checks: null } },
    }))).toContain('github.write');
    expect(writeHost.list('answer')).toContain('github_write_scope');
    const effect = await writeHost.execute({ id: 'scope', name: 'github_write_scope', args: {} },
      { run_id: answer.runId, effect_key: 'a'.repeat(64) });
    expect(effect).toMatchObject({ branch, base_sha: 'a'.repeat(40) });
  });

  it('WorkSession: reviewer peut demander un verdict D12 depuis un run answer, sans usurpation de rôle', async () => {
    const reviewer = await seeded({ kind: 'answer', participant: 'c2c-reviewer' });
    const author = await seeded({ kind: 'answer', participant: 'c2c-author' });
    const host = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github,
      unifiedCapabilities: true, verdicts: true });
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, reviewer.scope, {
      db, repository: 'rfkevin/github-mcp', github, unifiedCapabilities: true, verdicts: true,
    }))).toContain('review.verdict');
    await expect(host.execute({ id: 'bad', name: 'store_verdict', args: {} },
      { run_id: reviewer.runId, effect_key: 'b'.repeat(64) }))
      .rejects.toThrow(/VERDICT_ARGS_INVALID/);
    await expect(host.execute({ id: 'bad', name: 'store_verdict', args: {} }, { run_id: author.runId }))
      .rejects.toThrow(/capability_not_held:review\.verdict/);
  });

});
