import { describe, expect, it, vi } from 'vitest';
import { WriteCoordinator } from '../src/writes/coordinator';
import { writesEnabled } from '../src/writes/config';
import { GitHubApiError, GitHubConflictError } from '../src/github/types';
import { GitHubBranches } from '../src/github/branches';
import type { GitHubServiceContext } from '../src/github/service-context';
import { publicFailure } from '../src/mcp/tools/github/result';

const SHA = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const REPO = 'owner/project';
const BRANCH = 'mcp/123/fix';
function fixture() {
  const reads = {
    repositories: {
      listInstallationRepositories: vi.fn(async () => [REPO]),
      getRepository: vi.fn(async () => ({ full_name: REPO, default_branch: 'master', private: true, archived: false })),
    },
    branches: { getBranchHead: vi.fn(async () => SHA) },
    commits: { getCommit: vi.fn(async () => ({ sha: SHA, html_url: '', commit: { message: 'Fix' } })) },
  };
  const writes = {
    branches: { createWorkingBranch: vi.fn(async () => ({ branch: BRANCH, sha: SHA })) },
    changes: { applyChangeSet: vi.fn(async () => ({ branch: BRANCH, commitSha: NEXT,
      changedPaths: ['src/app.ts'], deletedPaths: [] })) },
    pullRequests: { createPullRequest: vi.fn(async () => ({ number: 9, title: 'Fix', state: 'open', draft: true,
      html_url: 'https://github.com/owner/project/pull/9', head: { ref: BRANCH, sha: SHA }, base: { ref: 'master' } })),
      getPullRequest: vi.fn(async () => ({ number: 9, title: 'Fix', state: 'open',
        html_url: 'https://github.com/owner/project/pull/9', head: { ref: BRANCH, sha: SHA, repo: { full_name: REPO } }, base: { ref: 'master' } })) },
    issues: { createComment: vi.fn(async () => ({ id: 1, html_url: 'https://github.com/owner/project/pull/9#issuecomment-1', created_at: '' })) },
    commits: { createComment: vi.fn(async () => ({ id: 2, html_url: 'https://github.com/owner/project/commit/' + SHA + '#commitcomment-2', created_at: '', commit_id: SHA })) },
  };
  return { reads, writes, coordinator: new WriteCoordinator('123', reads, writes) };
}
const commit = { repository: REPO, branch: BRANCH, expectedHeadSha: SHA,
  message: 'Fix', changes: [{ path: 'src/app.ts', content: 'ok', expectedSha: NEXT }] };
const pull = { repository: REPO, branch: BRANCH, expectedHeadSha: SHA, title: 'Fix' };

describe('commentaires sans pouvoir d’approbation', () => {
  const comment = { repository: REPO, number: 9, expectedHeadSha: SHA, body: 'Tests vérifiés.' };
  it('commente une PR ouverte au SHA observé et signe le constat', async () => {
    const { coordinator, writes } = fixture();
    await coordinator.commentPullRequest(comment);
    expect(writes.issues.createComment).toHaveBeenCalledWith(REPO, 9, expect.stringContaining('Tests vérifiés.'));
    expect(writes.issues.createComment).toHaveBeenCalledWith(REPO, 9, expect.stringContaining('compte GitHub 123'));
  });
  it.each(['closed', 'fork', 'changed_head'])('refuse %s avant de publier', async scenario => {
    const { coordinator, writes } = fixture();
    const original = await writes.pullRequests.getPullRequest();
    writes.pullRequests.getPullRequest.mockResolvedValue({ ...original,
      state: scenario === 'closed' ? 'closed' : 'open', head: { ...original.head,
        sha: scenario === 'changed_head' ? NEXT : SHA,
        ref: BRANCH,
        repo: { full_name: scenario === 'fork' ? 'fork/project' : REPO } } });
    await expect(coordinator.commentPullRequest(comment)).rejects.toThrow();
    expect(writes.issues.createComment).not.toHaveBeenCalled();
  });
  it('commente une autre branche sans autoriser sa modification', async () => {
    const { coordinator, writes } = fixture();
    const original = await writes.pullRequests.getPullRequest();
    writes.pullRequests.getPullRequest.mockResolvedValue({ ...original, head: { ...original.head, ref: 'mcp/456/design' } });
    await coordinator.commentPullRequest({ ...comment, agentLabel: 'Claude integration' });
    await expect(coordinator.commitChanges({ ...commit, branch: 'mcp/456/design' })).rejects.toThrow();
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
    expect(writes.issues.createComment).toHaveBeenCalledOnce();
  });
  it('lie un avis déclaré à head/base et refuse un contexte absent ou périmé', async () => {
    const { coordinator, writes, reads } = fixture();
    await expect(coordinator.commentPullRequest({ ...comment, decision: 'agree' })).rejects.toMatchObject({ code: 'REVIEW_CONTEXT_REQUIRED' });
    await coordinator.commentPullRequest({ ...comment, decision: 'agree', agentLabel: 'design', expectedBaseSha: SHA });
    expect(writes.issues.createComment).toHaveBeenCalledWith(REPO, 9, expect.stringContaining('MCP-Review: {"version":1,"agent":"design","actor":"123","head":"' + SHA));
    reads.branches.getBranchHead.mockResolvedValue(NEXT);
    await expect(coordinator.commentPullRequest({ ...comment, decision: 'agree', agentLabel: 'design', expectedBaseSha: SHA }))
      .rejects.toMatchObject({ code: 'BASE_CHANGED' });
    expect(writes.issues.createComment).toHaveBeenCalledOnce();
  });
  it('commente un commit exact sans toucher aux branches', async () => {
    const { coordinator, reads, writes } = fixture();
    await coordinator.commentCommit({ repository: REPO, sha: SHA, body: 'Contrat API incompatible avec le design.', agentLabel: 'Claude design' });
    expect(reads.commits.getCommit).toHaveBeenCalledWith(REPO, SHA);
    expect(writes.commits.createComment).toHaveBeenCalledWith(REPO, SHA, expect.stringContaining('Claude design'));
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
    expect(writes.branches.createWorkingBranch).not.toHaveBeenCalled();
  });
  it('refuse les commentaires hors installation et les SHA non vérifiés', async () => {
    const { coordinator, reads, writes } = fixture();
    reads.repositories.listInstallationRepositories.mockResolvedValue([]);
    await expect(coordinator.commentCommit({ repository: REPO, sha: SHA, body: 'x' })).rejects.toThrow();
    await expect(coordinator.commentPullRequest(comment)).rejects.toThrow();
    reads.repositories.listInstallationRepositories.mockResolvedValue([REPO]);
    reads.commits.getCommit.mockResolvedValue({ sha: NEXT, html_url: '', commit: { message: 'Fix' } });
    await expect(coordinator.commentCommit({ repository: REPO, sha: SHA, body: 'x' })).rejects.toMatchObject({ code: 'COMMIT_MISMATCH' });
    expect(writes.commits.createComment).not.toHaveBeenCalled();
    expect(writes.issues.createComment).not.toHaveBeenCalled();
  });
  it('ne rejoue pas automatiquement un commentaire au résultat incertain', async () => {
    const { coordinator, writes } = fixture();
    writes.commits.createComment.mockRejectedValue(new GitHubApiError(503, '/comments', 'hidden'));
    await expect(coordinator.commentCommit({ repository: REPO, sha: SHA, body: 'x' }))
      .rejects.toMatchObject({ code: 'WRITE_RESULT_UNKNOWN' });
    expect(writes.commits.createComment).toHaveBeenCalledOnce();
  });
});

describe('écritures : activation et périmètre', () => {
  it.each([undefined, '', 'false'])('reste désactivé pour %s', value => expect(writesEnabled(value)).toBe(false));
  it('exige la valeur explicite true', () => {
    expect(writesEnabled('true')).toBe(true);
    expect(() => writesEnabled('yes')).toThrow();
  });
  it('construit la branche avec l’identité authentifiée et un SHA de base attendu', async () => {
    const { coordinator, writes } = fixture();
    await coordinator.createBranch({ repository: REPO, task: 'fix', expectedBaseSha: SHA });
    expect(writes.branches.createWorkingBranch).toHaveBeenCalledWith(REPO, BRANCH, 'master', { expectedBaseSha: SHA });
  });
  it('part de la branche choisie et permet une PR vers cette même branche', async () => {
    const { coordinator, writes } = fixture();
    await coordinator.createBranch({ repository: REPO, task: 'fix', baseBranch: 'develop', expectedBaseSha: SHA });
    expect(writes.branches.createWorkingBranch).toHaveBeenCalledWith(REPO, BRANCH, 'develop', { expectedBaseSha: SHA });
    await coordinator.openPullRequest({ ...pull, baseBranch: 'develop' });
    expect(writes.pullRequests.createPullRequest).toHaveBeenCalledWith(REPO, BRANCH, 'develop', 'Fix', '', { draft: true });
  });
  it('accepte un autre dépôt lorsqu’il est sélectionné dans GitHub, sans liste locale', async () => {
    const { coordinator, reads, writes } = fixture();
    reads.repositories.listInstallationRepositories.mockResolvedValue(['other/repo']);
    await coordinator.createBranch({ repository: 'other/repo', task: 'fix', expectedBaseSha: SHA });
    expect(writes.branches.createWorkingBranch).toHaveBeenCalledWith('other/repo', BRANCH, 'master', { expectedBaseSha: SHA });
  });
  it('refuse un dépôt absent ou retiré de l’installation avant toute écriture', async () => {
    const { coordinator, reads, writes } = fixture();
    reads.repositories.listInstallationRepositories.mockResolvedValue([]);
    await expect(coordinator.commitChanges(commit)).rejects.toMatchObject({ code: 'REPOSITORY_DENIED' });
    await expect(coordinator.openPullRequest(pull)).rejects.toMatchObject({ code: 'REPOSITORY_DENIED' });
    expect(reads.repositories.getRepository).not.toHaveBeenCalled();
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
    expect(writes.pullRequests.createPullRequest).not.toHaveBeenCalled();
  });
  it.each(['master', 'main', 'mcp/456/fix', 'mcp/123/../fix', 'mcp/123/a/b'])
  ('refuse la branche %s avant tout appel réseau', async branch => {
    const { coordinator, reads, writes } = fixture();
    await expect(coordinator.commitChanges({ ...commit, branch })).rejects.toThrow();
    await expect(coordinator.openPullRequest({ ...pull, branch })).rejects.toThrow();
    expect(reads.repositories.listInstallationRepositories).not.toHaveBeenCalled();
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it('protège aussi une branche par défaut portant le préfixe de travail', async () => {
    const { coordinator, reads, writes } = fixture();
    reads.repositories.getRepository.mockResolvedValue({ full_name: REPO, private: true, archived: false, default_branch: BRANCH });
    await expect(coordinator.commitChanges(commit)).rejects.toMatchObject({ code: 'PROTECTED_BRANCH' });
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it('refuse un dépôt archivé', async () => {
    const { coordinator, reads } = fixture();
    reads.repositories.getRepository.mockResolvedValue({ full_name: REPO, private: true, archived: true, default_branch: 'master' });
    await expect(coordinator.createBranch({ repository: REPO, task: 'fix', expectedBaseSha: SHA }))
      .rejects.toMatchObject({ code: 'REPOSITORY_ARCHIVED' });
  });
  it('ne permet pas d’injecter un autre propriétaire de branche dans task', async () => {
    const { coordinator, reads } = fixture();
    await expect(coordinator.createBranch({ repository: REPO, task: '../456/fix', expectedBaseSha: SHA })).rejects.toThrow();
    expect(reads.repositories.listInstallationRepositories).not.toHaveBeenCalled();
  });
});

describe('écritures : fichiers et concurrence', () => {
  it('borne le message avec sa trace et guide le suivi du nouveau SHA', async () => {
    const { coordinator, writes } = fixture();
    await expect(coordinator.commitChanges({ ...commit, message: 'x'.repeat(200), agentLabel: 'design' }))
      .rejects.toMatchObject({ code: 'MESSAGE_TOO_LONG' });
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
    expect(await coordinator.commitChanges({ ...commit, agentLabel: 'design' })).toMatchObject({ followUp: { taskComplete: false, arguments: { ref: NEXT } } });
  });
  it.each(['.env', 'config/private.pem', '.github/workflows/ci.yml', '.github/actions/x/action.yml',
    '.github/CODEOWNERS', 'scripts/ci/run-checks.mjs', '../file', 'file\u0000.txt'])
  ('refuse ajout ou suppression de %s', async path => {
    const { coordinator, reads, writes } = fixture();
    await expect(coordinator.commitChanges({ ...commit, changes: [{ path, content: 'secret' }] })).rejects.toThrow();
    await expect(coordinator.commitChanges({ ...commit, changes: [], deletions: [{ path, expectedSha: SHA }] })).rejects.toThrow();
    expect(reads.repositories.listInstallationRepositories).not.toHaveBeenCalled();
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it('transmet créations, modifications et suppressions dans un seul changement atomique', async () => {
    const { coordinator, writes } = fixture();
    const changes = [...commit.changes, { path: 'new.ts', content: 'new' }];
    const deletions = [{ path: 'old.ts', expectedSha: SHA }];
    await coordinator.commitChanges({ ...commit, changes, deletions });
    expect(writes.changes.applyChangeSet).toHaveBeenCalledExactlyOnceWith(REPO, BRANCH, changes, 'Fix\n\nMCP-Actor: 123\nMCP-Agent: agent non précisé',
      { expectedHeadSha: SHA, deletions });
  });
  it('accepte un commit constitué seulement de suppressions explicites', async () => {
    const { coordinator, writes } = fixture();
    await coordinator.commitChanges({ ...commit, changes: [], deletions: [{ path: 'old.ts', expectedSha: SHA }] });
    expect(writes.changes.applyChangeSet).toHaveBeenCalledOnce();
  });
  it('refuse un commit vide, dupliqué, binaire ou trop volumineux', async () => {
    const { coordinator, writes } = fixture();
    for (const changes of [[], [commit.changes[0], commit.changes[0]], [{ path: 'bin', content: '\u0000' }],
      [{ path: 'a', content: 'é'.repeat(300_000) }, { path: 'b', content: 'é'.repeat(300_000) }],
      Array.from({ length: 51 }, (_, i) => ({ path: `f${i}`, content: '' }))]) {
      await expect(coordinator.commitChanges({ ...commit, changes })).rejects.toThrow();
    }
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it('exige le SHA de branche et le SHA de chaque suppression', async () => {
    const { coordinator, writes } = fixture();
    await expect(coordinator.commitChanges({ ...commit, expectedHeadSha: '' })).rejects.toThrow();
    await expect(coordinator.commitChanges({ ...commit, changes: [], deletions: [{ path: 'old.ts', expectedSha: '' }] })).rejects.toThrow();
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it('renvoie un conflit exploitable sans divulguer le message interne', async () => {
    const { coordinator, writes } = fixture();
    writes.changes.applyChangeSet.mockRejectedValue(new GitHubConflictError('CANARY'));
    await expect(coordinator.commitChanges(commit)).rejects.toMatchObject({ code: 'WRITE_CONFLICT' });
    try { await coordinator.commitChanges(commit); } catch (error) {
      expect(JSON.stringify(publicFailure(error))).not.toContain('CANARY');
    }
  });
  it.each([0, 500, 503])('ne propose pas de rejouer après un résultat incertain %s', async status => {
    const { coordinator, writes } = fixture();
    writes.changes.applyChangeSet.mockRejectedValue(new GitHubApiError(status, '/git/refs', 'CANARY'));
    try { await coordinator.commitChanges(commit); throw new Error('Expected failure'); } catch (error) {
      expect(publicFailure(error)).toMatchObject({ code: 'WRITE_RESULT_UNKNOWN', retryable: false });
      expect(JSON.stringify(publicFailure(error))).not.toContain('CANARY');
    }
    expect(writes.changes.applyChangeSet).toHaveBeenCalledOnce();
  });
  it('ne crée pas la branche si sa base a changé', async () => {
    const request = vi.fn(async () => ({ object: { sha: NEXT } }));
    const branches = new GitHubBranches({ request, assertGitRef: () => {}, assertWritableBranchName: () => {},
      encodeSlashPath: (value: string) => value, repoPath: (_repo: string, path: string) => path,
    } as unknown as GitHubServiceContext);
    await expect(branches.createWorkingBranch(REPO, BRANCH, 'master', { expectedBaseSha: SHA }))
      .rejects.toMatchObject({ code: 'BASE_CHANGED' });
    expect(request).toHaveBeenCalledOnce();
  });
});

describe('écritures : PR de préparation seulement', () => {
  it('crée uniquement un brouillon vers la branche par défaut', async () => {
    const { coordinator, writes } = fixture();
    const result = await coordinator.openPullRequest(pull);
    expect(writes.pullRequests.createPullRequest).toHaveBeenCalledExactlyOnceWith(REPO, BRANCH, 'master', 'Fix', '', { draft: true });
    expect(result).toMatchObject({ number: 9, draft: true, headMatchesExpected: true });
  });
  it('refuse une branche ayant changé avant ouverture', async () => {
    const { coordinator, reads, writes } = fixture();
    reads.branches.getBranchHead.mockResolvedValue(NEXT);
    await expect(coordinator.openPullRequest(pull)).rejects.toMatchObject({ code: 'HEAD_CHANGED' });
    expect(writes.pullRequests.createPullRequest).not.toHaveBeenCalled();
  });
  it('signale si la branche évolue pendant la création de PR', async () => {
    const { coordinator, writes } = fixture();
    writes.pullRequests.createPullRequest.mockResolvedValue({ number: 9, title: 'Fix', state: 'open', draft: true,
      html_url: 'https://github.com/owner/project/pull/9', head: { ref: BRANCH, sha: NEXT }, base: { ref: 'master' } });
    expect(await coordinator.openPullRequest(pull)).toMatchObject({ headMatchesExpected: false, headSha: NEXT });
  });
});
