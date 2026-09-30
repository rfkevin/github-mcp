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

The Worker preserves the original seven read tools and adds project context, batched file reads, CI failure reports and summaries of Sonar-published checks. Metadata, contents, checks, statuses and Actions reads use separate minimal tokens. Sensitive paths are filtered from diffs (including renames), reads, listings and search. File reads traverse Git trees and immutable blobs, refusing symlinks, submodules, truncated trees and oversized files. See [setup.md](setup.md) for the current catalogue and limits.

`applyChangeSet` also accepts `options.expectedHeadSha`, checked against the loaded parent commit. Directories, submodules and symlinks cannot be replaced through this API. Workflow files, reusable actions, `.github/CODEOWNERS`, `scripts/ci` and their protected parent directories cannot be modified. These are application-level restrictions, not remote GitHub protection rules. These write services are still not exposed as MCP tools.

`dispatchWorkflow` is denied unless both `allowedWorkflows` and `allowedWorkflowRefs` explicitly include the requested values. `apiVersion: '2026-03-10'` enables the run-ID response; older responses may return undefined. The optional MCP coordinator exposes only `agent-checks.yml`, behind server configuration and the separate `mcp:checks` consent. It does not expose arbitrary dispatch, cancellation, merging or deployment. See [checks.md](checks.md) for correlation, best-effort reuse and activation.

Authenticated HTTP requests refuse redirects and JSON responses are bounded. `getJobLogs` is therefore not a general signed-log downloader: its usual GitHub redirect is intentionally rejected. No raw-log MCP tool is exposed. A future downloader must validate the signed destination and must not forward the installation token.
