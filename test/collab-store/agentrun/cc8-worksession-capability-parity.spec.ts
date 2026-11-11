import { describe, expect, it } from 'vitest';
import {
  createReadToolHost, requiredUnifiedCapability, runVerifiedClaims, READ_TOOLS_BY_KIND,
  READ_TOOL_SCHEMAS, CONTINUITY_TOOL_SCHEMAS, 
} from '../../../src/collab-store/agentrun/read-tools';
import { resolveUnifiedCapabilities } from '../../../src/collab-store/agentrun/agent-capabilities';
import { WRITE_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/store-tools';
import { GITHUB_WRITE_TOOL_SCHEMAS, apiBranch, type GitHubWrites } from '../../../src/collab-store/agentrun/github-tools';
import { S7_SCHEMAS } from '../../../src/collab-store/agentrun/github-write/tools';
import { VERDICT_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/verdict-tools';
import { CONTRIBUTION_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/contribution-tools';
import { MODEL_CHOICE_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/model-choice-tools';
import { RESEARCH_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/research';
import { db, seeded, github, writes } from './cc8-capability-fixture';

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

  it('WorkSession: un agent auteur API peut créer une branche puis committer depuis answer', async () => {
    const answer = await seeded({ kind: 'answer', participant: 'c2c-author' });
    const branchName = 'work';
    const branch = apiBranch('c2c-author', branchName);
    const base = 'mcp/105856986/cc3-integration';
    const baseSha = 'a'.repeat(40);
    const commitSha = 'c'.repeat(40);
    let head: string | null = null;
    let commits = 0;
    const authorWrites: GitHubWrites = {
      ...writes,
      branchHead: async (_repository, requested) => requested === base ? baseSha : requested === branch ? head : null,
      createBranch: async (_repository, requested, from, expectedBase) => {
        expect(requested).toBe(branch);
        expect(from).toBe(base);
        expect(expectedBase).toBe(baseSha);
        head = baseSha;
        return { sha: baseSha };
      },
      commitFiles: async (_repository, requested, expected, message, files) => {
        expect(requested).toBe(branch);
        expect(expected).toBe(baseSha);
        expect(message).toContain('Agent-Effect:');
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('src/x.ts');
        commits++;
        head = commitSha;
        return { commit_sha: commitSha };
      },
    };
    const grant = JSON.stringify([{
      cycle: answer.scope.cycle_id, task: answer.scope.task_id, participant: 'c2c-author',
      branch, paths: ['src/x.ts'],
    }]);
    const host = createReadToolHost({
      db, repository: 'rfkevin/github-mcp', github, storeWrites: true,
      continuity: true, unifiedCapabilities: true,
      githubWrites: { writes: authorWrites, baseBranch: base,
        s7: { policy: { writers: 'c2c-author', tasks: grant }, reads: github, checks: null } },
    });
    const effect = (name: string, args: Record<string, unknown>, n: number) =>
      host.execute({ id: 'effect-' + n, name, args }, { run_id: answer.runId, effect_key: n.toString(16).repeat(64) });

    expect(await effect('github_write_scope', {}, 1)).toMatchObject({ branch, base_sha: baseSha });
    expect(await effect('github_create_branch', { name: branchName, base_sha: baseSha }, 2))
      .toMatchObject({ branch, sha: baseSha });
    const committed = await effect('github_commit_files', {
      name: branchName, expected_head_sha: baseSha, message: 'WorkSession parity test',
      files: [{ path: 'src/x.ts', content: 'actual change', expected_sha: 'b'.repeat(40) }],
    }, 3);
    expect(committed).toMatchObject({ branch, commit_sha: commitSha, next_action: 'github_run_checks' });
    expect(commits).toBe(1);
    const receipt = await db.prepare('SELECT before_sha, after_sha FROM api_write_commits WHERE cycle=?1 AND task=?2 AND branch=?3')
      .bind(answer.scope.cycle_id, answer.scope.task_id, branch)
      .first<{ before_sha: string; after_sha: string | null }>();
    expect(receipt).toEqual({ before_sha: baseSha, after_sha: commitSha });
  });

  it('WorkSession: contexte API et chat partagent active_work et un registre paginé', async () => {
    const run = await seeded({ kind: 'implement', participant: 'c2c-author' });
    // Historical cutoff was 60 tasks; none may disappear after the first page.
    const queries = Array.from({ length: 65 }, (_, i) => db.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid,',
      "status, owned_paths, target_ref, next_action, revision) VALUES (?1, ?2, 'c2c-intruder',",
      "'c2c-reviewer', 'c2c-tester', 'in_progress', '[]', '', '', 1)",
    ].join(' ')).bind('additional-' + i, run.scope.cycle_id));
    await db.batch(queries);
    const host = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github,
      unifiedCapabilities: true, continuity: true, contextCompaction: true });
    const pages: Array<{ registry: Array<{task_id: string}>; registry_next_page: number | null;
      active_work: { open_api_runs: Array<{run_id: string}> }; registry_total: number }> = [];
    for (let page = 0; page < 3; page++) {
      const result = await host.execute({ id: 'context-' + page, name: 'store_context',
        args: { full: true, registry_page: page, registry_limit: 30 } }, { run_id: run.runId });
      pages.push(result as typeof pages[number]);
    }
    expect(pages[0].registry_total).toBe(66);
    expect(pages[0].registry_next_page).toBe(1);
    expect(pages[1].registry_next_page).toBe(2);
    expect(pages[2].registry_next_page).toBeNull();
    expect(new Set(pages.flatMap(page => page.registry.map(row => row.task_id))).size).toBe(66);
    expect(pages[0].active_work.open_api_runs.some(row => row.run_id === run.runId)).toBe(true);
  });

});
