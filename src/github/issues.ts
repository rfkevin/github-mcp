import type { GitHubComment, GitHubIssue, GitHubLabel } from './types';
import type { GitHubServiceContext } from './service-context';

export class GitHubIssues {
  constructor(private readonly dependencies: GitHubServiceContext) {}

  createIssue(
    repository: string,
    title: string,
    body = '',
    options: { labels?: readonly string[]; assignees?: readonly string[] } = {},
  ): Promise<GitHubIssue> {
    if (!title.trim() || title.length > 256) {
      throw new Error('Le titre de l’issue est invalide.');
    }
    if (body.length > 65_536) {
      throw new Error('Le contenu de l’issue est trop volumineux.');
    }

    return this.dependencies.request<GitHubIssue>(
      this.dependencies.repoPath(repository, '/issues'),
      { method: 'POST', body: JSON.stringify({ title, body, ...options }) },
    );
  }

  getIssue(repository: string, issueNumber: number): Promise<GitHubIssue> {
    this.dependencies.assertPositiveInteger(issueNumber, 'Numéro d’issue');
    return this.dependencies.request<GitHubIssue>(
      this.dependencies.repoPath(repository, `/issues/${issueNumber}`),
    );
  }

  async listIssues(
    repository: string,
    options: {
      state?: 'open' | 'closed' | 'all';
      labels?: readonly string[];
      assignee?: string;
      since?: string;
      limit?: number;
    } = {},
  ): Promise<GitHubIssue[]> {
    const { paginateArray, repoPath, withQuery } = this.dependencies;
    const items = await paginateArray<GitHubIssue>(
      withQuery(repoPath(repository, '/issues'), {
        state: options.state ?? 'open',
        labels: options.labels?.join(','),
        assignee: options.assignee,
        since: options.since,
      }),
      options.limit ?? 100,
    );

    return items.filter(item => !item.pull_request);
  }

  /** The cap applies before PR filtering; a short issue list may still have another page. */
  async listIssuesPage(repository: string, options: { state: 'open' | 'closed' | 'all'; limit: number; page: number }) {
    const { assertPositiveInteger, repoPath, request, withQuery } = this.dependencies;
    assertPositiveInteger(options.limit, 'Limite');
    assertPositiveInteger(options.page, 'Page');
    const items = await request<GitHubIssue[]>(withQuery(repoPath(repository, '/issues'), {
      state: options.state, per_page: Math.min(options.limit, 50), page: options.page,
    }));
    return { issues: items.filter(item => !item.pull_request), potentiallyTruncated: items.length >= Math.min(options.limit, 50) };
  }

  updateIssue(
    repository: string,
    issueNumber: number,
    changes: {
      title?: string;
      body?: string;
      state?: 'open' | 'closed';
      stateReason?: 'completed' | 'not_planned' | 'reopened';
      labels?: readonly string[];
      assignees?: readonly string[];
    },
  ): Promise<GitHubIssue> {
    const { assertPositiveInteger, repoPath, request } = this.dependencies;
    assertPositiveInteger(issueNumber, 'Numéro d’issue');
    const { stateReason, ...rest } = changes;

    return request<GitHubIssue>(repoPath(repository, `/issues/${issueNumber}`), {
      method: 'PATCH',
      body: JSON.stringify({ ...rest, state_reason: stateReason }),
    });
  }

  createComment(repository: string, issueNumber: number, body: string): Promise<GitHubComment> {
    const { assertPositiveInteger, repoPath, request } = this.dependencies;
    assertPositiveInteger(issueNumber, 'Numéro d’issue ou de Pull Request');

    if (!body.trim() || body.length > 65_536) {
      throw new Error('Le commentaire est invalide.');
    }

    return request<GitHubComment>(repoPath(repository, `/issues/${issueNumber}/comments`), {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  listComments(repository: string, issueNumber: number, limit = 100, page?: number): Promise<GitHubComment[]> {
    const { assertPositiveInteger, paginateArray, repoPath, request, withQuery } = this.dependencies;
    assertPositiveInteger(issueNumber, 'Numéro d’issue ou de Pull Request');
    if (page !== undefined) {
      assertPositiveInteger(page, 'Page');
      return request(withQuery(repoPath(repository, `/issues/${issueNumber}/comments`), { per_page: 20, page }));
    }
    return paginateArray(repoPath(repository, `/issues/${issueNumber}/comments`), limit);
  }

  updateComment(repository: string, commentId: number, body: string): Promise<GitHubComment> {
    const { assertPositiveInteger, repoPath, request } = this.dependencies;
    assertPositiveInteger(commentId, 'Identifiant de commentaire');

    if (!body.trim() || body.length > 65_536) {
      throw new Error('Le commentaire est invalide.');
    }

    return request<GitHubComment>(repoPath(repository, `/issues/comments/${commentId}`), {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
  }

  searchIssues(repository: string, query: string, limit = 30): Promise<GitHubIssue[]> {
    if (!query.trim() || query.length > 256) {
      throw new Error('Requête de recherche invalide.');
    }

    const { splitRepository, repoPath, request, withQuery } = this.dependencies;
    const { owner, name } = splitRepository(repository);
    repoPath(repository);

    return request<{ items: GitHubIssue[] }>(
      withQuery('/search/issues', {
        q: `${query} repo:${owner}/${name}`,
        per_page: Math.min(Math.max(limit, 1), 100),
      }),
    ).then(payload => payload.items);
  }

  listLabels(repository: string, limit = 100): Promise<GitHubLabel[]> {
    return this.dependencies.paginateArray(this.dependencies.repoPath(repository, '/labels'), limit);
  }

  createLabel(
    repository: string,
    name: string,
    color = 'ededed',
    description?: string,
  ): Promise<GitHubLabel> {
    if (!name.trim() || name.length > 50 || !/^[0-9a-fA-F]{6}$/.test(color)) {
      throw new Error('Label invalide.');
    }

    return this.dependencies.request<GitHubLabel>(
      this.dependencies.repoPath(repository, '/labels'),
      { method: 'POST', body: JSON.stringify({ name, color, description }) },
    );
  }

  addLabels(repository: string, issueNumber: number, labels: readonly string[]): Promise<GitHubLabel[]> {
    const { assertPositiveInteger, repoPath, request } = this.dependencies;
    assertPositiveInteger(issueNumber, 'Numéro d’issue ou de Pull Request');

    return request<GitHubLabel[]>(repoPath(repository, `/issues/${issueNumber}/labels`), {
      method: 'POST',
      body: JSON.stringify({ labels }),
    });
  }

  removeLabel(repository: string, issueNumber: number, label: string): Promise<GitHubLabel[]> {
    const { assertPositiveInteger, encodeSegment, repoPath, request } = this.dependencies;
    assertPositiveInteger(issueNumber, 'Numéro d’issue ou de Pull Request');

    return request<GitHubLabel[]>(
      repoPath(repository, `/issues/${issueNumber}/labels/${encodeSegment(label)}`),
      { method: 'DELETE' },
    );
  }
}
