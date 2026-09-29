import type { GitHubRateLimit, GitHubRelease } from './types';
import type { GitHubServiceContext } from './service-context';

export class GitHubReleases {
  constructor(private readonly dependencies: GitHubServiceContext) {}

  listReleases(repository: string, limit = 30): Promise<GitHubRelease[]> {
    return this.dependencies.paginateArray(
      this.dependencies.repoPath(repository, '/releases'),
      limit,
    );
  }

  getLatestRelease(repository: string): Promise<GitHubRelease> {
    return this.dependencies.request<GitHubRelease>(
      this.dependencies.repoPath(repository, '/releases/latest'),
    );
  }

  createRelease(
    repository: string,
    tagName: string,
    options: {
      name?: string;
      body?: string;
      target?: string;
      draft?: boolean;
      prerelease?: boolean;
      generateNotes?: boolean;
    } = {},
  ): Promise<GitHubRelease> {
    const { assertGitRef, repoPath, request } = this.dependencies;
    assertGitRef(tagName, 'tag');
    if (options.target) assertGitRef(options.target);

    return request<GitHubRelease>(repoPath(repository, '/releases'), {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tagName,
        name: options.name,
        body: options.body,
        target_commitish: options.target,
        draft: options.draft ?? true,
        prerelease: options.prerelease ?? false,
        generate_release_notes: options.generateNotes ?? false,
      }),
    });
  }

  getRateLimit(): Promise<GitHubRateLimit> {
    return this.dependencies.request<GitHubRateLimit>('/rate_limit');
  }
}
