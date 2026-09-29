import type { GitHubCommit, GitHubComparison } from './types';
import type { GitHubServiceContext } from './service-context';

export class GitHubCommits {
  constructor(private readonly dependencies: GitHubServiceContext) {}

  listCommits(
    repository: string,
    options: { ref?: string; path?: string; limit?: number } = {},
  ): Promise<GitHubCommit[]> {
    const { assertGitRef, assertReadablePath, repoPath, request, withQuery } = this.dependencies;
    if (options.ref) assertGitRef(options.ref, 'référence');
    if (options.path) assertReadablePath(options.path);

    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
    return request<GitHubCommit[]>(
      withQuery(repoPath(repository, '/commits'), {
        sha: options.ref,
        path: options.path,
        per_page: limit,
      }),
    );
  }

  getCommit(repository: string, ref: string): Promise<GitHubCommit> {
    const { assertGitRef, encodeSlashPath, repoPath, request } = this.dependencies;
    assertGitRef(ref, 'référence');
    return request<GitHubCommit>(repoPath(repository, `/commits/${encodeSlashPath(ref)}`));
  }

  compareRefs(repository: string, base: string, head: string): Promise<GitHubComparison> {
    const { assertGitRef, encodeSlashPath, repoPath, request } = this.dependencies;
    assertGitRef(base, 'référence');
    assertGitRef(head, 'référence');
    return request<GitHubComparison>(
      repoPath(repository, `/compare/${encodeSlashPath(base)}...${encodeSlashPath(head)}`),
    );
  }
}
