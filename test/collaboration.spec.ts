import { describe, expect, it, vi } from 'vitest';
import { verificationStatus, type ExpectedCheck } from '../src/mcp/verification';
import { WORKFLOW_INSTRUCTIONS, verificationFollowUp } from '../src/mcp/workflow-guidance';
import { declaredConsensus } from '../src/integration/consensus';
import { IntegrationCoordinator, integrationPolicySchema } from '../src/integration/coordinator';
import { createToolContext, type ToolContext } from '../src/mcp/context';
import type { AppEnv } from '../src/config';
import { GitHubApiError, type GitHubComment, type GitHubReview } from '../src/github/types';
import { GitHubBranches } from '../src/github/branches';
import { GitHubClient } from '../src/github/client';
import { GitHubCommits } from '../src/github/commits';
import type { GitHubServiceContext } from '../src/github/service-context';
import { assertWritablePath } from '../src/security/policy';
import { TOOL_FEEDBACK } from '../src/tool-feedback';

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), MAIN = 'c'.repeat(40), MERGED = 'd'.repeat(40);
const REPO = 'owner/project';
const expected: ExpectedCheck[] = [{ source: 'check', name: 'ci' }, { source: 'check', name: 'build' }];
function review(agent: string, id: number, decision = 'agree', head = HEAD, base = BASE): GitHubComment {
  return { id, html_url: `https://github.com/${REPO}/pull/1#issuecomment-${id}`, created_at: '',
    body: 'MCP-Review: ' + JSON.stringify({ version: 1, agent, actor: '123', head, base, decision }) + '\n\nPreuve et solution.' };
}
const reviewers = ['backend', 'design'];
const policy = { version: 1, branch: 'integration', expectedChecks: expected, reviewers };
const args = { repository: REPO, number: 1, expectedHeadSha: HEAD, expectedBaseSha: BASE,
  expectedLastCommentId: 2, agentLabel: 'backend', discussionSummary: 'Contrat API relu et compatible avec le design, sans objection restante.' };

function fixture() {
  const ctx = {
    actor: '123', github: { repositories: {
      listInstallationRepositories: vi.fn(async () => [REPO]),
      getRepository: vi.fn(async () => ({ full_name: REPO, default_branch: 'master', archived: false, private: true })),
    } },
    reads: {
      branches: { getBranchHead: vi.fn(async (_repo: string, branch: string) => branch === 'integration' ? BASE : MAIN) },
      files: { getTextFile: vi.fn(async (_repo: string, path: string, _ref: string) => ({ path, sha: MAIN, content: JSON.stringify(policy), size: 100 })) },
      commits: { compareRefs: vi.fn(async () => ({ status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, commits: [],
        files: [{ filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 0 }] })) },
    },
    pulls: {
      pullRequests: { getPullRequest: vi.fn(async () => ({ number: 1, title: 'Fix', state: 'open', draft: false,
        html_url: '', head: { ref: 'mcp/456/design', sha: HEAD, repo: { full_name: REPO } }, base: { ref: 'integration' } })),
        listReviews: vi.fn(async (): Promise<GitHubReview[]> => []), listReviewComments: vi.fn(async () => []) },
      issues: { listComments: vi.fn(async () => [review('backend', 1), review('design', 2)]) },
    },
    checks: { listCheckRuns: vi.fn(async () => expected.map((item, id) => ({ id, name: item.name, head_sha: HEAD,
      status: 'completed', conclusion: 'success', html_url: '' }))) },
    statuses: { getCombinedStatus: vi.fn(async () => ({ state: 'pending', total_count: 0, statuses: [] })) },
    workflows: { listWorkflowRuns: vi.fn(async () => []) },
  };
  const merge = vi.fn(async (_repo: string, _head: string, _message: string): Promise<{ sha: string } | undefined> => ({ sha: MERGED }));
  return { ctx, merge, coordinator: new IntegrationCoordinator('123', ctx as unknown as ToolContext, merge) };
}

describe('consignes universelles et fin réelle du travail', () => {
  it('sépare propositions et mémoire, et prévoit la remise manuelle en lecture seule', () => {
    expect(TOOL_FEEDBACK).toMatchObject({ repository: 'rfkevin/github-mcp', memoryPath: 'AGENT_MEMORY.md', improvementsPath: 'TOOL_IMPROVEMENTS.md' });
    for (const text of ['classement personnel', 'Sans accès', 'non-publication', 'pas une preuve', 'pas compter', "Pas de proposition transformée en autorisation"]) {
      expect(WORKFLOW_INSTRUCTIONS).toContain(text);
    }
  });
  it('décrit discussion, arbitrage, pas de fermeture et suivi post-intégration', () => {
    for (const phrase of ['espace de coordination', 'trois échanges', 'sans la fermer', 'SHA résultant', 'ne réveillent pas']) {
      expect(WORKFLOW_INSTRUCTIONS).toContain(phrase);
    }
    expect(verificationFollowUp(REPO, HEAD, 1)).toMatchObject({ taskComplete: false, nextTool: 'github_ci_status', arguments: { ref: HEAD } });
  });
  it('ne confond pas absence de contrôles et réussite', () => {
    expect(verificationStatus([], expected, false).state).toBe('incomplete');
    expect(verificationStatus([], [], false).state).toBe('incomplete');
  });
  it.each(['cancelled', 'skipped', 'neutral', null])('ne valide pas la conclusion %s', conclusion => {
    expect(verificationStatus([{ ...expected[0], status: 'completed', conclusion }], [expected[0]], false).state).toBe('incomplete');
  });
  it('exige toutes les attentes, des sources complètes et distingue succès observé', () => {
    const success = expected.map(item => ({ ...item, status: 'completed', conclusion: 'success' }));
    expect(verificationStatus(success, expected, false).state).toBe('declared_checks_passed');
    expect(verificationStatus(success, [], false).state).toBe('observed_success');
    expect(verificationStatus(success, expected, true).state).toBe('incomplete');
    expect(verificationStatus(success.slice(0, 1), expected, false).state).toBe('incomplete');
    expect(verificationStatus([{ ...success[0], status: 'in_progress', conclusion: null }], expected, false).state).toBe('pending');
    expect(verificationStatus([{ ...success[0], conclusion: 'failure' }], expected, false).state).toBe('failed');
  });
});

describe('accords déclarés, pas identités certifiées', () => {
  it('exige chaque participant au head et à la base courants', () => {
    expect(declaredConsensus([review('backend', 1), review('design', 2)], reviewers, HEAD, BASE).agreed).toBe(true);
    expect(declaredConsensus([review('backend', 1)], reviewers, HEAD, BASE).agreed).toBe(false);
    expect(declaredConsensus([review('backend', 1), review('design', 2, 'agree', MAIN)], reviewers, HEAD, BASE).agreed).toBe(false);
    expect(declaredConsensus([review('backend', 1), review('design', 2, 'agree', HEAD, MAIN)], reviewers, HEAD, BASE).agreed).toBe(false);
  });
  it('un nouvel avis retire un ancien accord et un autre participant peut bloquer', () => {
    const comments = [review('backend', 1), review('design', 2), review('design', 3, 'changes_requested')];
    expect(declaredConsensus(comments, reviewers, HEAD, BASE).agreed).toBe(false);
    expect(declaredConsensus([...comments, review('design', 4)], reviewers, HEAD, BASE).agreed).toBe(true);
    expect(declaredConsensus([...comments.slice(0, 2), review('accessibility', 5, 'changes_requested')], reviewers, HEAD, BASE).agreed).toBe(false);
  });
  it('ignore les marqueurs cités ou invalides, ne signe pas pour autrui', () => {
    const comment = review('design', 1); comment.body = '> ' + comment.body;
    expect(declaredConsensus([comment, { ...comment, id: 2, body: 'MCP-Review: malformed' }], reviewers, HEAD, BASE).agreed).toBe(false);
    expect(() => integrationPolicySchema.parse({ ...policy, reviewers: ['same', 'same'] })).toThrow();
  });
});

describe('intégration opt-in et refus par défaut', () => {
  it('un client GitHub de lecture bloque commentaires et fusion avant tout réseau', async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    const client = new GitHubClient({ appId: '123', installationId: '456', privateKey: 'unused',
      fetcher, policy: { readOnly: true }, allowIntegrationMerge: true });
    await expect(client.commits.createComment(REPO, HEAD, 'Review')).rejects.toThrow();
    await expect(client.branches.mergeIntegration(REPO, HEAD, 'Review')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('les commentaires de commit valident le SHA et ne publient qu’un corps général', async () => {
    const request = vi.fn(async () => []);
    const commits = new GitHubCommits({ request, repoPath: (_repo: string, path: string) => path,
      withQuery: (path: string) => path } as unknown as GitHubServiceContext);
    expect(() => commits.createComment(REPO, 'master', 'Review')).toThrow();
    expect(() => commits.createComment(REPO, HEAD, '')).toThrow();
    expect(request).not.toHaveBeenCalled();
    await commits.createComment(REPO, HEAD, 'Review');
    expect(request).toHaveBeenCalledWith(`/commits/${HEAD}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Review' }) });
  });
  it('ne donne pas la fusion aux anciens consentements', () => {
    const env = { GITHUB_WRITES_ENABLED: 'true' } as AppEnv;
    expect(createToolContext(env, '123', ['mcp:write']).integrationCoordinator).toBeUndefined();
    expect(createToolContext(env, '123', ['mcp:integration']).integrationCoordinator).toBeUndefined();
    expect(createToolContext({} as AppEnv, '123', ['mcp:write', 'mcp:integration']).integrationCoordinator).toBeUndefined();
    expect(createToolContext(env, '123', ['mcp:write', 'mcp:integration']).integrationCoordinator).toBeDefined();
  });
  it('intègre le SHA relu et renvoie un suivi CI, sans annoncer terminé', async () => {
    const { coordinator, ctx, merge } = fixture();
    const result = await coordinator.mergePullRequest(args);
    expect(ctx.reads.files.getTextFile).toHaveBeenCalledWith(REPO, '.mcp/integration.json', MAIN);
    expect(merge).toHaveBeenCalledExactlyOnceWith(REPO, HEAD, expect.stringContaining('MCP-Agent: backend'));
    expect(result).toMatchObject({ branch: 'integration', sha: MERGED, followUp: { taskComplete: false, arguments: { ref: MERGED, expectedChecks: expected } } });
  });
  it.each(['main', 'master', 'develop'])('refuse une PR vers %s sans mutation', async base => {
    const { coordinator, ctx, merge } = fixture();
    const pull = await ctx.pulls.pullRequests.getPullRequest();
    ctx.pulls.pullRequests.getPullRequest.mockResolvedValue({ ...pull, base: { ref: base } });
    await expect(coordinator.mergePullRequest(args)).rejects.toMatchObject({ code: 'INTEGRATION_PR_DENIED' });
    expect(merge).not.toHaveBeenCalled();
  });
  it.each(['fork', 'closed', 'draft', 'head'])('refuse %s', async scenario => {
    const { coordinator, ctx, merge } = fixture();
    const pull = await ctx.pulls.pullRequests.getPullRequest();
    ctx.pulls.pullRequests.getPullRequest.mockResolvedValue({ ...pull, draft: scenario === 'draft',
      state: scenario === 'closed' ? 'closed' : 'open', head: { ...pull.head, sha: scenario === 'head' ? MAIN : HEAD,
        repo: { full_name: scenario === 'fork' ? 'other/repo' : REPO } } });
    await expect(coordinator.mergePullRequest(args)).rejects.toThrow(); expect(merge).not.toHaveBeenCalled();
  });
  it.each(['absent', 'default', 'archived', 'policy'])('refuse dépôt/politique %s', async scenario => {
    const { coordinator, ctx, merge } = fixture();
    if (scenario === 'absent') ctx.github.repositories.listInstallationRepositories.mockResolvedValue([]);
    if (scenario === 'default' || scenario === 'archived') ctx.github.repositories.getRepository.mockResolvedValue({ full_name: REPO,
      default_branch: scenario === 'default' ? 'integration' : 'master', archived: scenario === 'archived', private: true });
    if (scenario === 'policy') ctx.reads.files.getTextFile.mockRejectedValue(new GitHubApiError(404, '', 'missing'));
    await expect(coordinator.mergePullRequest(args)).rejects.toThrow(); expect(merge).not.toHaveBeenCalled();
  });
  it.each(['failed', 'pending', 'missing', 'unavailable'])('refuse la CI %s', async scenario => {
    const { coordinator, ctx, merge } = fixture();
    const checks = await ctx.checks.listCheckRuns();
    if (scenario === 'unavailable') ctx.statuses.getCombinedStatus.mockRejectedValue(new Error('unavailable'));
    else ctx.checks.listCheckRuns.mockResolvedValue(scenario === 'missing' ? [] : checks.map(item => ({ ...item,
      status: scenario === 'pending' ? 'in_progress' : 'completed', conclusion: scenario === 'failed' ? 'failure' : 'success' })));
    await expect(coordinator.mergePullRequest(args)).rejects.toMatchObject({ code: 'CI_NOT_PASSED' }); expect(merge).not.toHaveBeenCalled();
  });
  it.each(['disagree', 'stale', 'new_comment', 'truncated', 'formal_review'])('bloque la discussion %s', async scenario => {
    const { coordinator, ctx, merge } = fixture();
    if (scenario === 'disagree') ctx.pulls.issues.listComments.mockResolvedValue([review('backend', 1), review('design', 2, 'changes_requested')]);
    if (scenario === 'stale') ctx.pulls.issues.listComments.mockResolvedValue([review('backend', 1), review('design', 2, 'agree', MAIN)]);
    if (scenario === 'new_comment') ctx.pulls.issues.listComments.mockResolvedValue([review('backend', 1), review('design', 2), { ...review('design', 3), body: 'Nouveau problème' }]);
    if (scenario === 'truncated') ctx.pulls.issues.listComments.mockResolvedValue(Array.from({ length: 101 }, (_, id) => review('design', id)));
    if (scenario === 'formal_review') ctx.pulls.pullRequests.listReviews.mockResolvedValue([{ id: 1, state: 'CHANGES_REQUESTED', user: { login: 'owner' } }]);
    await expect(coordinator.mergePullRequest(args)).rejects.toThrow(); expect(merge).not.toHaveBeenCalled();
  });
  it.each(['.mcp/integration.json', '.github/workflows/ci.yml', '.env', 'scripts/ci/test.mjs'])('refuse la fusion du fichier protégé %s', async filename => {
    const { coordinator, ctx, merge } = fixture();
    ctx.reads.commits.compareRefs.mockResolvedValue({ ...await ctx.reads.commits.compareRefs(), files: [{ filename, status: 'modified', additions: 1, deletions: 0 }] });
    await expect(coordinator.mergePullRequest(args)).rejects.toThrow(); expect(merge).not.toHaveBeenCalled();
  });
  it('recontrôle head/base/politique après la CI et les avis', async () => {
    const { coordinator, ctx, merge } = fixture();
    let baseReads = 0;
    ctx.reads.branches.getBranchHead.mockImplementation(async (_repo, branch) => branch === 'integration' ? (++baseReads === 1 ? BASE : MERGED) : MAIN);
    await expect(coordinator.mergePullRequest(args)).rejects.toMatchObject({ code: 'BASE_CHANGED' }); expect(merge).not.toHaveBeenCalled();
  });
  it('ne rejoue pas une fusion dont le résultat est incertain', async () => {
    const { coordinator, merge } = fixture(); merge.mockRejectedValue(new GitHubApiError(503, '', 'hidden'));
    await expect(coordinator.mergePullRequest(args)).rejects.toMatchObject({ code: 'WRITE_RESULT_UNKNOWN' }); expect(merge).toHaveBeenCalledOnce();
  });
  it('refuse un nouveau commentaire de code et une politique invalide', async () => {
    const { coordinator, ctx, merge } = fixture();
    ctx.pulls.pullRequests.listReviewComments.mockResolvedValue([{ id: 5, path: 'src/app.ts', body: 'Bug', html_url: '' }] as never);
    await expect(coordinator.mergePullRequest(args)).rejects.toMatchObject({ code: 'DISCUSSION_CHANGED' });
    ctx.reads.files.getTextFile.mockResolvedValue({ path: '.mcp/integration.json', sha: MAIN, size: 2, content: '{}' });
    await expect(coordinator.mergePullRequest(args)).rejects.toMatchObject({ code: 'INTEGRATION_POLICY_INVALID' });
    expect(merge).not.toHaveBeenCalled();
  });
  it.each(['AGENT_MEMORY.md', 'TOOL_IMPROVEMENTS.md'])('préserve les contributions de %s pendant l’intégration', async path => {
    const { coordinator, ctx, merge } = fixture();
    ctx.reads.commits.compareRefs.mockResolvedValue({ ...await ctx.reads.commits.compareRefs(), files: [{ filename: path, status: 'modified', additions: 1, deletions: 0 }] });
    ctx.reads.files.getTextFile.mockImplementation(async (_repo, requested, ref) => ({ path: requested, sha: MAIN, size: 100,
      content: requested === '.mcp/integration.json' ? JSON.stringify(policy) : ref === BASE ? 'Existing contribution\n' : 'Rewritten contribution\n' }));
    await expect(coordinator.mergePullRequest(args)).rejects.toMatchObject({ code: path === 'AGENT_MEMORY.md' ? 'MEMORY_APPEND_ONLY' : 'FEEDBACK_APPEND_ONLY' });
    expect(merge).not.toHaveBeenCalled();
    ctx.reads.files.getTextFile.mockImplementation(async (_repo, requested, ref) => ({ path: requested, sha: MAIN, size: 100,
      content: requested === '.mcp/integration.json' ? JSON.stringify(policy) : 'Existing contribution\n' + (ref === BASE ? '' : 'New note\n') }));
    await expect(coordinator.mergePullRequest(args)).resolves.toMatchObject({ sha: MERGED });
  });
  it.each(['.mcp', '.mcp/integration.json', '.MCP/INTEGRATION.JSON'])('protège %s contre un commit MCP', path => {
    expect(() => assertWritablePath(path)).toThrow();
    expect(() => assertWritablePath('.mcp/checks.json')).not.toThrow();
  });
  it('la méthode HTTP cible littéralement integration, sans pouvoir choisir main', async () => {
    const request = vi.fn(async () => ({ sha: MERGED }));
    const deps = { request, allowIntegrationMerge: true, repoPath: (_repo: string, path: string) => path } as unknown as GitHubServiceContext;
    await new GitHubBranches(deps).mergeIntegration(REPO, HEAD, 'Reviewed');
    expect(request).toHaveBeenCalledWith('/merges', { method: 'POST', body: JSON.stringify({ base: 'integration', head: HEAD, commit_message: 'Reviewed' }) });
    await expect(new GitHubBranches({ ...deps, allowIntegrationMerge: false }).mergeIntegration(REPO, HEAD, 'Reviewed')).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
});
