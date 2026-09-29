# GitHub client

`GitHubClient` exposes GitHub operations through readonly service namespaces. The flat methods from the previous API have been removed.

```ts
const github = new GitHubClient(options);

const repository = await github.repositories.getRepository('owner/project');
const file = await github.files.getTextFile('owner/project', 'src/app.ts', 'main');
const result = await github.changes.applyChangeSet(
  'owner/project',
  'mcp/assistant/fix-login',
  [{ path: 'src/app.ts', content: 'updated' }],
  'Fix login',
);
```

Available services:

- `repositories`: installation repositories, repository details, branches, and tags.
- `files`: file and directory reads, repository trees, and code search.
- `branches`: working branch creation/deletion and pull request branch updates.
- `changes`: atomic file change sets.
- `pullRequests`: pull request lifecycle, merges, reviewers, and reviews.
- `issues`: issues, comments, search, and labels.
- `actions`: workflows, runs, jobs, checks, and statuses.
- `commits`: commit history, commit details, and comparisons.
- `releases`: releases and rate-limit information.

Services share the same authenticated HTTP transport, repository allowlist, and security policy through the internal `GitHubServiceContext`.
