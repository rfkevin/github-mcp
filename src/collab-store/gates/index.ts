export { evaluateMergeGate, type MergeCandidate, type GateVerdict } from './merge-gate';
export { executeIntegration, type IntegrationPort, type IntegrationOutcome } from './integration';
export { gateEvidence, type GateEvidence } from './verdicts';
export { closeVerifiedIssue, type ClosurePort } from './closure';

export { githubIntegrationPort, runGitHubIntegration,
  type GitHubGateReader, type FencedMergeExecutor, type GitHubGateTarget } from './github-adapter';

export { claimMergeIntent, reconcileMergeIntent, MERGE_INTENT_SCHEMA, MERGE_INTENT_TTL_SECONDS, type MergeIntent } from './merge-intent';
export { createGitHubMergeExecutor, CC5_AUTO_MERGE_ENABLED, type MergeGitHubPort, type MergeExecutionConfig } from './github-merge-executor';
