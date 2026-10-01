import { GitHubApiError, GitHubConflictError, InputValidationError, type GitHubPullRequest } from './types';
import type { GitHubServiceContext } from './service-context';

export class GitHubBranches {
  constructor(private readonly dependencies: GitHubServiceContext) {}

  /** La cible n'est jamais issue des arguments du modèle ou de la base mutable d'une PR. */
  async mergeIntegration(repository: string, headSha: string, message: string): Promise<{ sha: string } | undefined> {
    const { allowIntegrationMerge, request, repoPath } = this.dependencies;
    if (!allowIntegrationMerge) throw new InputValidationError('Fusion d’intégration désactivée.', 'INTEGRATION_DISABLED');
    if (!/^[a-f0-9]{40}$/i.test(headSha) || !message.trim() || message.length > 1000) {
      throw new InputValidationError('Fusion invalide.');
    }
    return request(repoPath(repository, '/merges'), { method: 'POST',
      body: JSON.stringify({ base: 'integration', head: headSha.toLowerCase(), commit_message: message }) });
  }

  async getBranchHead(repository: string, branch: string): Promise<string> {
    const { assertGitRef, encodeSlashPath, repoPath, request } = this.dependencies;
    assertGitRef(branch);
    const ref = await request<{ object: { sha: string } }>(repoPath(repository, `/git/ref/heads/${encodeSlashPath(branch)}`));
    return ref.object.sha;
  }

  async createWorkingBranch(
    repository: string,
    branch: string,
    baseBranch: string,
    options: { expectedBaseSha?: string } = {},
  ): Promise<{ branch: string; sha: string }> {
    const {
      assertGitRef,
      assertWritableBranchName,
      encodeSlashPath,
      repoPath,
      request,
    } = this.dependencies;
    assertWritableBranchName(branch);
    assertGitRef(baseBranch);
    if (options.expectedBaseSha && !/^[a-f0-9]{40}$/i.test(options.expectedBaseSha)) {
      throw new InputValidationError('SHA de base invalide.');
    }

    const baseRef = await request<{ object: { sha: string } }>(
      repoPath(repository, `/git/ref/heads/${encodeSlashPath(baseBranch)}`),
    );
    if (options.expectedBaseSha && baseRef.object.sha.toLowerCase() !== options.expectedBaseSha.toLowerCase()) {
      throw new InputValidationError('La branche de base a changé depuis sa lecture.', 'BASE_CHANGED');
    }

    try {
      await request(repoPath(repository, '/git/refs'), {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }),
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 422) {
        throw new GitHubConflictError(`La branche ${branch} existe déjà.`);
      }

      throw error;
    }

    return { branch, sha: baseRef.object.sha };
  }

  async deleteBranch(repository: string, branch: string): Promise<void> {
    const { assertWritableBranchName, encodeSlashPath, repoPath, request } = this.dependencies;
    assertWritableBranchName(branch);

    await request(repoPath(repository, `/git/refs/heads/${encodeSlashPath(branch)}`), {
      method: 'DELETE',
    });
  }

  async updatePullRequestBranch(repository: string, pullNumber: number): Promise<void> {
    const { assertPositiveInteger, assertWritableBranchName, repoPath, request } = this.dependencies;
    assertPositiveInteger(pullNumber, 'Numéro de Pull Request');
    const pull = await request<GitHubPullRequest>(repoPath(repository, `/pulls/${pullNumber}`));
    assertWritableBranchName(pull.head.ref);
    if (!pull.head.repo || pull.head.repo.full_name.toLowerCase() !== repository.toLowerCase()) {
      throw new Error('La branche de PR doit appartenir au dépôt autorisé.');
    }

    await request(repoPath(repository, `/pulls/${pullNumber}/update-branch`), {
      method: 'PUT',
      body: JSON.stringify({ expected_head_sha: pull.head.sha }),
    });
  }
}
