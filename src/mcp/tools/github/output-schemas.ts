import { z } from 'zod';

// Standard MCP outputSchema contracts. Keep the text JSON alongside structuredContent
// for older clients. Error results use isError and are not success-schema validated.
const s = z.string();
const n = z.number();
const b = z.boolean();
const nullableString = s.nullable();
const strings = z.array(s);
const failure = z.object({ code: s, message: s, retryable: b });
const excerpt = { content: s, truncated: b };
const repository = { repository: s };
const atCommit = { ...repository, sha: s };
const expectedCheck = z.object({ source: z.enum(['check', 'workflow', 'status']), name: s });
const followUp = z.object({ taskComplete: z.literal(false), reason: s, nextTool: s,
  arguments: z.object({ repository: s, ref: s, expectedChecks: z.array(expectedCheck).optional() }),
  pullRequestNumber: n.optional(), nextPollSeconds: n, instruction: s });
const pull = { number: n, title: s, state: s, draft: b.optional(), merged: b.optional(), url: s,
  branch: s, headSha: s, headRepository: s.optional(), base: s, baseSha: s.optional(),
  mergeable: b.nullable().optional(), mergeableState: s.optional() };
const comment = { id: n, author: s.optional(), body: s, bodyTruncated: b, url: s };
const issue = { number: n, title: s, state: s, url: s, author: s.optional() };
const discussionEntry = z.object({ kind: s, id: n, author: s.optional(), declaredAgent: s.optional(),
  createdAt: s, updatedAt: nullableString, maskedBytes: n, url: s });
const check = { name: s, status: s, conclusion: nullableString, url: nullableString };
const treeEntry = z.looseObject({ path: s.optional(), type: s.optional(), sha: s.optional(), mode: s.optional(), size: n.optional() });
const capabilities = z.object({ mutationsExposed: b, checkDispatchEnabled: b, managedProjectChecks: b,
  checkPlanPath: s, workflowPreparation: s, codeWritesEnabled: b, issueWritesEnabled: b, conflictResolutionEnabled: b, workingBranchPrefix: s.optional(),
  integrationToolExposed: b, integrationPolicyPath: s,
  toolFeedback: z.object({ repository: s, memoryPath: s, improvementsPath: s, branch: s, publication: s, note: s }),
  collaboration: s, arbitraryShell: z.literal(false), productionDeployment: z.literal(false),
  projectCommandsOnGitHubActions: b,
  requiredPermissions: z.object({ files: s, checks: s, workflows: s, statuses: s, pullRequests: s, issues: s, codeWrites: s.optional(), issueWrites: s.optional() }),
  permissionsNote: s });
const decision = z.object({ version: z.literal(1), agent: s, actor: s, head: s, base: s,
  decision: z.enum(['agree', 'changes_requested']), commentId: n });
const run = { ...repository, targetSha: s, controllerSha: s.optional(), runId: n, url: s,
  status: nullableString, nextPollSeconds: n.nullable() };

export const outputSchemas = {
  github_list_repositories: { repositories: strings },
  github_list_issues: { ...repository, issues: z.array(z.object(issue)), limit: n, page: n,
    potentiallyTruncated: b, nextPage: n.nullable() },
  github_get_issue: { ...repository, ...issue, labels: strings, assignees: strings,
    body: s, bodyTruncated: b, comments: z.array(z.object(comment)),
    commentsPotentiallyTruncated: b, commentsPage: n, nextCommentsPage: n.nullable() },
  github_get_issue_comment: { ...repository, commentId: n, author: s.optional(), url: s, createdAt: s,
    updatedAt: nullableString, maskingVersion: s, content: s, offset: n, nextOffset: n.nullable(),
    totalBytes: n, revision: s, truncated: b },
  github_list_discussion_items: { ...repository, kind: s, number: n,
    items: z.array(z.object({ kind: s, id: n, author: s.optional(), declaredAgent: s.optional(),
      createdAt: s, updatedAt: nullableString, maskedBytes: n, url: s })),
    limit: n, nextCursor: nullableString, order: s },
  github_get_discussion_delta: { ...repository, kind: s, number: n, mode: z.enum(['baseline', 'delta']),
    count: n.optional(), olderOmitted: n.optional(), items: z.array(discussionEntry).optional(),
    added: z.array(discussionEntry).optional(), modified: z.array(discussionEntry).optional(),
    deleted: z.array(n).optional(), unchanged: n.optional(), olderUntracked: n.optional(),
    duplicatesIgnored: n.optional(), reenumerated: b.optional(), deferred: n.optional(), hasMore: b.optional(),
    nextCursor: s, trackedLimit: n, note: s },
  github_get_discussion_item: { ...repository, kind: s, id: n, author: s.optional(), url: s,
    createdAt: nullableString, updatedAt: nullableString, path: nullableString, line: n.nullable(), state: nullableString,
    maskingVersion: s, content: s, offset: n, nextOffset: n.nullable(), totalBytes: n, revision: s, truncated: b },
  github_get_project_guide: { ...atCommit, ref: s,
    documents: z.array(z.object({ path: s, sha: s.optional(), size: n.optional(), content: s.optional(),
      truncated: b.optional(), missing: b.optional() })) },
  github_read_file: { path: s, sha: s, size: n, ...excerpt },
  github_list_directory: { ...repository, path: s, ref: s,
    entries: z.array(z.object({ name: s, path: s, type: s, size: n, sha: s })) },
  github_search_code: { ...repository, query: s,
    matches: z.array(z.object({ name: s, path: s, sha: s, html_url: s })),
    incompleteResults: b, potentiallyTruncated: b, scope: s, note: s },
  github_get_commit: { ...atCommit, url: s.optional(), message: z.object(excerpt),
    parents: z.array(z.looseObject({ sha: s })),
    files: z.array(z.object({ path: s, previousPath: s.optional(), status: s, ...excerpt, patchAvailable: b })),
    filesPotentiallyTruncated: b,
    comments: z.array(z.object({ id: n, author: s.optional(), path: nullableString.optional(),
      line: n.nullable().optional(), ...excerpt, url: s })).optional(),
    commentsPotentiallyTruncated: b.optional(), commentsOrder: s.optional() },
  github_compare_refs: { ...repository, base: s, head: s, status: s, aheadBy: n, behindBy: n, totalCommits: n,
    commitsPotentiallyTruncated: b, filesPotentiallyTruncated: b,
    commits: z.array(z.object({ sha: s, message: s, date: s.optional() })),
    files: z.array(z.object({ filename: s, status: s, additions: n, deletions: n, patch: s.optional() })),
    patchesOmitted: b.optional() },
  github_ci_status: { ...atCommit, ref: s, partial: b,
    unavailable: z.array(failure.extend({ source: s })), availability: z.enum(['available', 'unknown', 'no_checks']),
    combinedState: nullableString, githubCombinedState: nullableString, statusCount: n.nullable(),
    verification: z.object({ state: s, expectationsDeclared: b, expectedChecks: z.array(expectedCheck),
      missing: z.array(expectedCheck), unverified: z.array(expectedCheck.extend({ status: s, conclusion: nullableString })),
      nextPollSeconds: n.nullable(), taskComplete: z.literal(false), nextAction: s, assurance: s }),
    potentiallyTruncated: b, checks: z.array(z.object({ id: n, ...check })),
    runs: z.array(z.object({ id: n, name: nullableString.optional(), status: nullableString, conclusion: nullableString,
      sha: s, branch: nullableString, path: s.optional(), url: s, createdAt: s })),
    limits: z.object({ checks: n, runs: n }), note: s },
  github_get_check_result: { ...atCommit, runId: n, shaMeaning: s, targetVerified: z.literal(false),
    status: nullableString, conclusion: nullableString, url: s, nextPollSeconds: n.nullable(),
    jobs: z.array(z.object({ id: n, ...check, failedSteps: strings })), limit: n, potentiallyTruncated: b },
  github_get_failure_report: { ...atCommit,
    reports: z.array(z.union([
      z.object({ id: n, name: s, conclusion: nullableString, url: nullableString,
        annotations: z.array(z.object({ path: s, startLine: n, endLine: n, level: s, message: s })), potentiallyTruncated: b }),
      z.object({ id: n, name: s, error: failure }),
    ])), truncated: b, note: s },
  github_get_quality_report: { ...atCommit, source: s, available: b, potentiallyTruncated: b,
    checks: z.array(z.object({ ...check, summary: s })), limitation: s },
  github_read_files: { ...atCommit, ref: s, partial: b,
    files: z.array(z.union([
      z.object({ path: s, blobSha: s, size: n, totalLines: n, startLine: n, endLine: n, outOfRange: b,
        ...excerpt, nextStartLine: n.nullable() }),
      z.object({ path: s, error: failure }),
    ])) },
  // A failed ref lookup is a partial context, not a failed tool invocation.
  github_get_project_context: { ...repository, defaultBranch: s, ref: s, partial: b, capabilities,
    sha: s.optional(), error: failure.optional(),
    tree: z.union([z.object({ entries: z.array(treeEntry), truncated: b }), z.object({ error: failure })]).optional(),
    documents: z.array(z.union([
      z.object({ path: s, blobSha: s, ...excerpt }), z.object({ path: s, error: failure }),
    ])).optional() },
  github_list_pull_requests: { ...repository, pulls: z.array(z.object(pull)), limit: n, potentiallyTruncated: b },
  github_get_pull_request: { ...repository, ...pull, body: s, bodyTruncated: b,
    comments: z.array(z.object(comment)).optional(),
    reviews: z.array(z.object({ ...comment, url: s.optional(), state: s })).optional(),
    reviewComments: z.array(z.object({ ...comment, path: s, line: n.nullable().optional() })).optional(),
    discussionPotentiallyTruncated: b.optional(), discussionPage: n.optional(), nextDiscussionPage: n.nullable().optional(),
    discussionOrder: s.optional() },
  // The managed and legacy check controllers share these fields.
  github_run_checks: { ...run, sha: s.optional(), scope: s.optional(), target: s.optional(),
    reused: b, key: s, deduplication: s.optional() },
  github_get_agent_check_result: { ...run, sha: s.optional(), scope: s.optional(), target: s.optional(),
    conclusion: nullableString, verifiedSuccess: b, assurance: s.optional() },
  github_prepare_checks: { ...repository, branch: s, defaultBranch: s, profiles: strings, changedPaths: strings,
    note: s, manualDispatch: s, applied: b, expectedHeadSha: s.optional(), unchanged: b.optional(), commitSha: s.optional(),
    deletedPaths: strings.optional(), changes: z.array(z.object({ path: s, content: s, expectedSha: s.optional() })).optional() },
  github_comment_commit: { ...atCommit, id: n, url: s, note: s },
  github_comment_pull_request: { ...repository, number: n, id: n, url: s, observedHeadSha: s, note: s },
  github_apply_changes: { status: z.enum(['applied', 'rejected', 'unchanged']), applied: b, atomic: b, headBeforeSha: s,
    repository: s.optional(), branch: s.optional(), commitSha: s.optional(), changedPaths: strings.optional(), deletedPaths: strings.optional(),
    operations: z.array(z.object({ index: n, path: s, state: z.enum(['prepared', 'failed', 'not_evaluated', 'unchanged']) })),
    errors: z.array(z.object({ index: n, path: s, code: s, message: s })), followUp: followUp.optional(), note: s.optional() },
  github_create_branch: { ...atCommit, baseBranch: s, branch: s },
  github_commit_changes: { ...repository, branch: s, commitSha: s, changedPaths: strings, deletedPaths: strings, followUp, note: s },
  github_replace_text: { ...repository, branch: s, commitSha: s, changedPaths: strings, deletedPaths: strings, followUp, note: s },
  github_restore_file: { ...repository, branch: s, commitSha: s, changedPaths: strings, deletedPaths: strings, followUp, note: s, sourceSha: s, sourceBlobSha: s },
  github_append_file: { ...repository, branch: s, commitSha: s, changedPaths: strings, deletedPaths: strings, followUp, note: s },
  github_create_issue: { ...repository, number: n, title: s, state: s, url: s, note: s },
  github_comment_issue: { ...repository, number: n, id: n, url: s, note: s },
  github_get_merge_context: { ...repository, branch: s, baseBranch: s, headSha: s, baseSha: s, ancestorSha: s,
    conflicts: z.array(z.object({ path: s, blocked: b, ancestorBlobSha: s.nullable().optional(), oursBlobSha: s.nullable().optional(), theirsBlobSha: s.nullable().optional() })),
    automaticPaths: strings, blockedPaths: strings, canResolve: b, note: s },
  github_resolve_conflicts: { ...repository, branch: s, baseBranch: s, commitSha: s, changedPaths: strings,
    deletedPaths: strings, baseSha: s, ancestorSha: s, followUp, note: s },
  github_open_pull_request: { ...repository, number: n, url: s, draft: b, base: s, branch: s, headSha: s,
    headMatchesExpected: b, followUp, note: s },
  github_merge_integration: { ...atCommit, number: n, branch: s, alreadyIntegrated: b,
    consensus: z.object({ agreed: b, missing: strings, blocking: z.array(decision), evidence: z.array(decision), assurance: s }),
    discussionSummary: s, followUp, note: s },
};
