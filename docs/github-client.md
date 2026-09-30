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

The Worker preserves the original seven read tools and adds project context, batched file reads, CI failure reports and summaries of Sonar-published checks. Metadata, contents, checks, statuses, Actions and pull-request reads use separate minimal tokens. Sensitive paths are filtered from diffs (including renames), reads, listings and search. File reads traverse Git trees and immutable blobs, refusing symlinks, submodules, truncated trees and oversized files. See [setup.md](setup.md) for the current catalogue and limits.

`applyChangeSet` also accepts `options.expectedHeadSha`, checked against the loaded parent commit. Directories, submodules and symlinks cannot be replaced through this API. Workflow files, reusable actions, `.github/CODEOWNERS`, `scripts/ci`, `scripts/deploy` and their protected parent directories cannot be modified. These are application-level restrictions, not remote GitHub protection rules. The optional MCP write coordinator exposes only working-branch creation, atomic commits, draft PR creation and comments on the actor’s open PRs, behind an explicit switch and a new `mcp:write` consent. It requires the expected head SHA, checks installation membership and actor-owned branches, and refuses sensitive filenames. See [writes.md](writes.md).

`branches.createWorkingBranch` accepts optional `expectedBaseSha` (mandatory through MCP) to reject a changed base before creating the reference. `branches.getBranchHead` reads the exact heads reference. The PR coordinator checks the expected head before creation, but GitHub's create-PR API has no head-SHA compare-and-swap; it returns the observed SHA and `headMatchesExpected`. Never treat that observation as a freeze of the branch.

`dispatchWorkflow` is denied unless both `allowedWorkflows` and `allowedWorkflowRefs` explicitly include the requested values. `apiVersion: '2026-03-10'` enables the run-ID response; older responses may return undefined. The optional MCP coordinator exposes only `agent-checks.yml`, behind server configuration and the separate `mcp:checks` consent. It does not expose arbitrary dispatch, cancellation, merging or deployment. See [checks.md](checks.md) for correlation, best-effort reuse and activation.

Authenticated HTTP requests refuse redirects and JSON responses are bounded. `getJobLogs` is therefore not a general signed-log downloader: its usual GitHub redirect is intentionally rejected. No raw-log MCP tool is exposed. A future downloader must validate the signed destination and must not forward the installation token.

## Interpreting read-tool results

- Code search uses GitHub's default-branch index, not a scan of every file at a chosen commit. `github_search_code` preserves `matches` and exposes `incompleteResults` (GitHub did not finish the search, or omitted that information) and `potentiallyTruncated` (more results may exist beyond the returned page). An empty result never proves absence from the source. Inspect relevant directories and files at an explicit ref when needed; the tool does not retry or scan the whole repository automatically. Library callers can use `files.searchCodeWithMetadata`; the historical `files.searchCode` array return remains compatible.
- `github_ci_status.availability` is `available` when checks, runs or commit statuses were found, `no_checks` only when all three sources succeeded and none were found, and `unknown` when none were found but at least one source failed. `partial` and `unavailable` still describe missing sources even when other checks exist. Availability is not a success verdict.
- `combinedState` covers only commit statuses, not checks or Actions runs. It is now `null` when `statusCount` is zero (or the statuses source is inaccessible); consumers must accept null. `githubCombinedState` retains GitHub's raw value, including its `pending` value when no statuses exist. Use each check/run's status and conclusion instead of interpreting that raw pending value as an active test.
- Sonar reports identify the publishing GitHub App, never just a job name. Accepted slugs include `sonarqubecloud`, `sonarcloud`, `sonarqube` and `sonarqube-cloud`. These reports summarize GitHub checks, not a separate query to the Sonar issues API. An empty failure report is not proof that tests passed.
- Comparison refs accept branch names, tags and commit SHAs. Relative expressions such as `master~1` or `HEAD^` remain unsupported and return `UNSUPPORTED_REF_EXPRESSION` with guidance to supply the parent commit SHA. No reference validation or write protection is relaxed.
