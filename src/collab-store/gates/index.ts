export { evaluateMergeGate, type MergeCandidate, type GateVerdict } from './merge-gate';
export { executeIntegration, type IntegrationPort, type IntegrationOutcome } from './integration';
export { gateEvidence, type GateEvidence } from './verdicts';
export { closeVerifiedIssue, type ClosurePort } from './closure';

export { githubIntegrationPort, runGitHubIntegration,
  type GitHubGateReader, type FencedMergeExecutor, type GitHubGateTarget } from './github-adapter';
