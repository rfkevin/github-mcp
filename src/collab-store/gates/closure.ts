/** Close only after confirmed merge, using an explicit issue association. */
export interface ClosurePort {
  /** Returns GitHub's current merged PR state, not a cached result. */
  mergedPullRequest(pr: number, mergeSha: string): Promise<boolean>;
  /** Must be idempotent: already-closed issues are success. */
  closeIssue(issue: number): Promise<void>;
}
export async function closeVerifiedIssue(port: ClosurePort, pr: number, issue: number, mergeSha: string): Promise<boolean> {
  if (!Number.isSafeInteger(pr) || pr <= 0 || !Number.isSafeInteger(issue) || issue <= 0 ||
      !/^[a-f0-9]{40}$/.test(mergeSha)) return false;
  if (!await port.mergedPullRequest(pr, mergeSha)) return false;
  await port.closeIssue(issue);
  return true;
}
