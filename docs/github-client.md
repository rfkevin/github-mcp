# GitHub client

`GitHubClient` exposes GitHub operations through readonly service namespaces. The flat methods from the previous API have been removed.

```ts
const github = new GitHubClient(options);

const repository = await github.repositories.getRepository('owner/project');
const file = await github.files.getTextFile('owner/project', 'src/app.ts', 'main');
const result = await github.changes.applyChangeSet(
  'owner/project',
  'mcp/assistant/fix-login',
  [{ path: 'src/app.ts', content: 'updated', expectedSha: file.sha }],
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

`policy.readOnly` blocks all GitHub mutations through the shared transport. A client currently has one policy; construct a separately scoped client when repository policies differ.

Updates and deletions of existing files require `expectedSha` from the last read. New files may omit it. The total change limit includes deletions. Incomplete (truncated) Git trees are rejected before any mutation because the Contents API cannot reliably preserve executable and symlink modes. Branch advancement uses a single-parent commit and `force: false`, so a concurrent divergent commit is not overwritten.

Pull request branch updates validate the source branch and repository and send `expected_head_sha`. Merges remain disabled by default; enabling them does not authorize protected target branches, and the expected PR head SHA is required.

The Worker exposes an OAuth-protected MCP endpoint with `github_list_repositories` only. See [setup.md](setup.md) for configuration and current limitations. Other services are library-only until their tool authorization and tests are added.
