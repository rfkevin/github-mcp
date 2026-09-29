import type { GitHubBranch, GitHubRepository } from './types';
import type { GitHubServiceContext } from './service-context';

export class GitHubRepositories {
  constructor(private readonly dependencies: GitHubServiceContext) {}

  async listInstallationRepositories(): Promise<string[]> {
    const { allowedRepositories, paginate } = this.dependencies;
    const repositories = await paginate<
      { repositories: GitHubRepository[] },
      GitHubRepository
    >('/installation/repositories', payload => payload.repositories, 1000);

    return repositories
      .map(repository => repository.full_name)
      .filter(
        fullName =>
          allowedRepositories.size === 0 || allowedRepositories.has(fullName.toLowerCase()),
      );
  }

  getRepository(repository: string): Promise<GitHubRepository> {
    return this.dependencies.request<GitHubRepository>(this.dependencies.repoPath(repository));
  }

  listBranches(repository: string, limit = 100): Promise<GitHubBranch[]> {
    return this.dependencies.paginateArray<GitHubBranch>(
      this.dependencies.repoPath(repository, '/branches'),
      limit,
    );
  }

  listTags(repository: string, limit = 100): Promise<Array<{ name: string; commit: { sha: string } }>> {
    return this.dependencies.paginateArray(
      this.dependencies.repoPath(repository, '/tags'),
      limit,
    );
  }
}
