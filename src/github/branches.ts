import { GitHubApiError, GitHubConflictError, type GitHubPullRequest } from './types';
import type { GitHubServiceContext } from './service-context';

export class GitHubBranches {
  constructor(private readonly dependencies: GitHubServiceContext) {}

  async createWorkingBranch(
    repository: string,
    branch: string,
    baseBranch: string,
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

    const baseRef = await request<{ object: { sha: string } }>(
      repoPath(repository, `/git/ref/heads/${encodeSlashPath(baseBranch)}`),
    );

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
