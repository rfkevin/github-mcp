import { GitHubApiError, GitHubConflictError } from './types';
import type {
  GitHubCommit,
  GitHubPullRequest,
  GitHubReview,
  GitHubReviewComment,
  MergeMethod,
  ReviewEvent,
  ReviewLineComment,
} from './types';
import type { GitHubServiceContext } from './service-context';

export class GitHubPullRequests {
  constructor(private readonly dependencies: GitHubServiceContext) {}

  async createPullRequest(
    repository: string,
    headBranch: string,
    baseBranch: string,
    title: string,
    body: string,
    options: { draft?: boolean } = {},
  ): Promise<GitHubPullRequest> {
    const { assertGitRef, assertWritableBranchName, repoPath, request } = this.dependencies;
    assertWritableBranchName(headBranch);
    assertGitRef(baseBranch);

    if (headBranch === baseBranch) {
      throw new Error('La branche source et la branche cible doivent être différentes.');
    }

    if (!title.trim() || title.length > 256) {
      throw new Error('Le titre de la Pull Request est invalide.');
    }

    if (body.length > 65_536) {
      throw new Error('Le contenu de la Pull Request est trop volumineux.');
    }

    try {
      return await request<GitHubPullRequest>(repoPath(repository, '/pulls'), {
        method: 'POST',
        body: JSON.stringify({
          title,
          body,
          head: headBranch,
          base: baseBranch,
          draft: options.draft ?? false,
        }),
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 422 && /already exists/i.test(error.message)) {
        throw new GitHubConflictError('Une Pull Request existe déjà pour ces branches.');
      }

      throw error;
    }
  }

  getPullRequest(repository: string, pullNumber: number): Promise<GitHubPullRequest> {
    const { assertPositiveInteger, repoPath, request } = this.dependencies;
    assertPositiveInteger(pullNumber, 'Numéro de Pull Request');
    return request<GitHubPullRequest>(repoPath(repository, `/pulls/${pullNumber}`));
  }

  listPullRequests(
    repository: string,
    options: { state?: 'open' | 'closed' | 'all'; head?: string; base?: string; limit?: number } = {},
  ): Promise<GitHubPullRequest[]> {
    const { assertGitRef, paginateArray, repoPath, withQuery } = this.dependencies;
    if (options.base) assertGitRef(options.base);

    return paginateArray<GitHubPullRequest>(
      withQuery(repoPath(repository, '/pulls'), {
        state: options.state ?? 'open',
        head: options.head,
        base: options.base,
      }),
      options.limit ?? 100,
    );
  }

  updatePullRequest(
    repository: string,
    pullNumber: number,
    changes: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string },
  ): Promise<GitHubPullRequest> {
    const { assertGitRef, assertPositiveInteger, repoPath, request } = this.dependencies;
    assertPositiveInteger(pullNumber, 'Numéro de Pull Request');

    if (changes.title !== undefined && (!changes.title.trim() || changes.title.length > 256)) {
      throw new Error('Le titre de la Pull Request est invalide.');
    }

    if (changes.body !== undefined && changes.body.length > 65_536) {
      throw new Error('Le contenu de la Pull Request est trop volumineux.');
    }

    if (changes.base) assertGitRef(changes.base);

    return request<GitHubPullRequest>(repoPath(repository, `/pulls/${pullNumber}`), {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
  }

  listPullRequestFiles(
    repository: string,
    pullNumber: number,
    limit = 300,
  ): Promise<NonNullable<GitHubCommit['files']>> {
    const { assertPositiveInteger, paginateArray, repoPath } = this.dependencies;
    assertPositiveInteger(pullNumber, 'Numéro de Pull Request');
    return paginateArray(repoPath(repository, `/pulls/${pullNumber}/files`), limit);
  }

  async mergePullRequest(
    repository: string,
    pullNumber: number,
    options: {
      method?: MergeMethod;
      commitTitle?: string;
      commitMessage?: string;
      expectedHeadSha?: string;
    } = {},
  ): Promise<{ merged: boolean; sha: string; message: string }> {
    const { allowMerge, assertPositiveInteger, assertWritableBranchName, repoPath, request } = this.dependencies;
    if (!allowMerge) {
      throw new Error('La fusion de Pull Requests est désactivée (allowMerge).');
    }

    assertPositiveInteger(pullNumber, 'Numéro de Pull Request');

    const pull = await this.getPullRequest(repository, pullNumber);
    assertWritableBranchName(pull.base.ref);
    if (!options.expectedHeadSha || options.expectedHeadSha !== pull.head.sha) {
      throw new GitHubConflictError('Le SHA attendu de la PR est requis et doit correspondre à sa version actuelle.');
    }

    try {
      return await request(repoPath(repository, `/pulls/${pullNumber}/merge`), {
        method: 'PUT',
        body: JSON.stringify({
          merge_method: options.method ?? 'squash',
          commit_title: options.commitTitle,
          commit_message: options.commitMessage,
          sha: options.expectedHeadSha,
        }),
      });
    } catch (error) {
      if (error instanceof GitHubApiError && (error.status === 405 || error.status === 409)) {
        throw new GitHubConflictError(`Fusion impossible : ${error.message}`);
      }

      throw error;
    }
  }

  requestReviewers(
    repository: string,
    pullNumber: number,
    reviewers: readonly string[],
    teamReviewers: readonly string[] = [],
  ): Promise<GitHubPullRequest> {
    const { assertPositiveInteger, repoPath, request } = this.dependencies;
    assertPositiveInteger(pullNumber, 'Numéro de Pull Request');

    return request<GitHubPullRequest>(
      repoPath(repository, `/pulls/${pullNumber}/requested_reviewers`),
      { method: 'POST', body: JSON.stringify({ reviewers, team_reviewers: teamReviewers }) },
    );
  }

  listReviews(repository: string, pullNumber: number, limit = 100): Promise<GitHubReview[]> {
    const { assertPositiveInteger, paginateArray, repoPath } = this.dependencies;
    assertPositiveInteger(pullNumber, 'Numéro de Pull Request');
    return paginateArray(repoPath(repository, `/pulls/${pullNumber}/reviews`), limit);
  }

  listReviewComments(
    repository: string,
    pullNumber: number,
    limit = 200,
  ): Promise<GitHubReviewComment[]> {
    const { assertPositiveInteger, paginateArray, repoPath } = this.dependencies;
    assertPositiveInteger(pullNumber, 'Numéro de Pull Request');
    return paginateArray(repoPath(repository, `/pulls/${pullNumber}/comments`), limit);
  }

  createReview(
    repository: string,
    pullNumber: number,
    event: ReviewEvent,
    body: string,
    comments: readonly ReviewLineComment[] = [],
  ): Promise<GitHubReview> {
    const { allowApproval, assertPositiveInteger, assertReadablePath, repoPath, request } =
      this.dependencies;
    assertPositiveInteger(pullNumber, 'Numéro de Pull Request');

    if (event === 'APPROVE' && !allowApproval) {
      throw new Error('L’approbation de Pull Requests est désactivée (allowApproval).');
    }

    if (event !== 'APPROVE' && !body.trim() && comments.length === 0) {
      throw new Error('Une revue sans approbation nécessite un message ou des commentaires.');
    }

    if (body.length > 65_536) {
      throw new Error('Le contenu de la revue est trop volumineux.');
    }

    for (const comment of comments) {
      assertReadablePath(comment.path);
      assertPositiveInteger(comment.line, 'Numéro de ligne');
    }

    return request<GitHubReview>(repoPath(repository, `/pulls/${pullNumber}/reviews`), {
      method: 'POST',
      body: JSON.stringify({ event, body, comments }),
    });
  }
}
