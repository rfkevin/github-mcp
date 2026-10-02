# MCP tooling gaps observed on 2026-10-02

This document records concrete limitations encountered while repairing PR #15. It is intentionally documentation-only so the owner can implement the fixes locally and reconcile them with the other in-flight work.

## 1. `github_commit_changes` can accidentally replace an entire existing file

### Observed incident

While attempting to update a few assertions in `test/oauth.spec.ts` on PR #15, the caller supplied `content: "PLACEHOLDER"` for the existing file. The tool accepted it because `content` is defined as the complete replacement content. The resulting commit `5957cad...` replaced a roughly 72 KB test file with the single placeholder string.

The intact version is still available at the previous PR head `0c3ac1ec09b4b003bc29d0c3a9aa12fa9416fca7`, so the data is recoverable.

### Why this is risky

For small edits, agents have to read and resend the complete file. This is token-expensive and makes accidental truncation/replacement much easier. Claude independently reported the same friction in `AGENT_MEMORY.md`: changing one line in a large file requires resending the whole file.

### Suggested fix

Add a safe targeted-edit operation, for example an exact `oldText -> newText` replacement with expected blob SHA and an assertion on the expected number of matches. Alternatively add a dedicated patch tool.

Also consider a guard in `github_commit_changes` for existing files when the new payload is dramatically smaller than the current blob. It should reject or require an explicit `allowLargeTruncation`-style acknowledgement rather than silently accepting likely placeholders/truncations.

A restore-from-ref/blob operation would also make recovery safer than retransmitting a large file.

## 2. Issue operations are incomplete in the exposed MCP catalogue

PR #15 is intended to expose issue reading. The underlying GitHub client already contains issue APIs, but issue operations were not previously exposed to clients, which is why Claude could access the repository but not its Issues.

The MCP used for this report still exposes no `github_create_issue`, so an agent cannot turn a discovered MCP defect into a GitHub Issue directly. A read-only issue tool does not solve this workflow gap.

### Suggested fix

After stabilising the read implementation from PR #15, consider a separately gated `github_create_issue` write tool. It should use explicit write consent/permissions and preserve the existing least-privilege model.

## 3. PR #15 recovery / CI context

PR #15 contained the issue-reading implementation before the accidental test-file replacement. The known-good pre-incident head is:

`0c3ac1ec09b4b003bc29d0c3a9aa12fa9416fca7`

The accidental replacement commit is:

`5957cad...`

Before that accidental commit, CI still needed test maintenance for the additional exposed read tool: several expected tool-count assertions had to be incremented. A reported `trim` failure in `oauth.spec.ts` should be rechecked after restoring the complete file rather than diagnosed from the placeholder state.

## 4. Related feedback already recorded by Claude

`AGENT_MEMORY.md` entry `2026-10-01-claude-conseils-frictions` already reports:

- large-file whole-content rewrites are costly and risky;
- no PR close / test-branch delete capability;
- several diagnostics are not sufficiently actionable (`server isn't responding`, repository 409, ambiguous check-result expectations, `partial: true` / pending interpretation).

Those observations should be considered together with the concrete replacement incident above when redesigning the mutation API.

## Recommended order

1. Restore `test/oauth.spec.ts` on PR #15 from `0c3ac1ec09b4b003bc29d0c3a9aa12fa9416fca7`.
2. Update the legitimate tool-count assertions and rerun the full CI for PR #15.
3. Confirm the issue reader works against a real repository with GitHub App `Issues: Read` permission and a refreshed MCP client connection.
4. Add a targeted patch/replace API plus large-truncation protection.
5. Consider `github_create_issue` and the other lifecycle/diagnostic improvements reported by Claude.
