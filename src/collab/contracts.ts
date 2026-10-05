export const STATE_SCHEMA_VERSION = 'CC-STATE-1' as const;

export const PHASES = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'] as const;
export const TASK_STATUSES = [
  'proposed',
  'accepted',
  'in_progress',
  'review',
  'verified',
  'done',
  'blocked',
] as const;
export const MEMORY_SCOPES = ['mcp_internal', 'global_usage', 'project'] as const;
export const KNOWLEDGE_STATES = ['hypothesis', 'observed', 'verified'] as const;
export const BALLOT_VALUES = ['keep', 'defer', 'reject', 'abstain'] as const;
export const MEMORY_DECISIONS = ['accepted', 'deferred', 'rejected', 'contested'] as const;
export const PUBLICATION_STATES = ['pending', 'effective', 'failed', 'unknown'] as const;

export type Phase = (typeof PHASES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number];
export type BallotValue = (typeof BALLOT_VALUES)[number];
export type MemoryDecision = (typeof MEMORY_DECISIONS)[number];
export type PublicationState = (typeof PUBLICATION_STATES)[number];
export type AgentRole = 'owner' | 'author' | 'reviewer' | 'tester' | 'assembler' | 'consultant';

export class StateContractError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = 'StateContractError';
    this.code = code;
    this.path = path;
  }
}

function oneOf<T extends string>(value: string, values: readonly T[], code: string, field: string): T {
  if (!values.includes(value as T)) {
    throw new StateContractError(code, field + ' has unsupported value: ' + value, field);
  }
  return value as T;
}

export function assertPhase(value: string): Phase {
  return oneOf(value, PHASES, 'INVALID_PHASE', 'phase');
}

export function assertTaskStatus(value: string): TaskStatus {
  return oneOf(value, TASK_STATUSES, 'INVALID_TASK_STATUS', 'status');
}

export function assertSchemaVersion(value: string): typeof STATE_SCHEMA_VERSION {
  if (value !== STATE_SCHEMA_VERSION) {
    throw new StateContractError('UNSUPPORTED_SCHEMA', 'Unsupported state schema: ' + value, 'schema_version');
  }
  return STATE_SCHEMA_VERSION;
}

export function parseRevision(value: string, field = 'revision'): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new StateContractError('INVALID_REVISION', field + ' must be a positive integer', field);
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new StateContractError('INVALID_REVISION', field + ' must be a positive integer', field);
  }
  return revision;
}

export function assertSha(value: string, field = 'sha'): string {
  if (!/^[0-9a-f]{7,64}$/i.test(value.trim())) {
    throw new StateContractError('INVALID_SHA', field + ' must be a hexadecimal Git SHA', field);
  }
  return value.trim();
}

export function assertDistinctRoles(roles: readonly AgentRole[]): void {
  const unique = new Set(roles);
  if (unique.size !== roles.length) {
    throw new StateContractError('DUPLICATE_ROLE', 'Every assigned role must be unique');
  }
}

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

export interface StateSnapshot {
  schemaVersion: string;
  legacySchema: boolean;
  headers: Record<string, string>;
  sections: Record<string, MarkdownTable[]>;
  raw: string;
}

export interface RoleRecord {
  actor: string;
  assignment: string;
  pendingEvidence: string;
}

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  owner: string;
  version: string;
  ref: string;
  nextAction: string;
}

export interface SourceReference {
  location: string;
  revision: number;
  complete: boolean;
}

export interface MemoryCandidate {
  id: string;
  scope: MemoryScope;
  statement: string;
  knowledgeState: KnowledgeState;
  source: SourceReference;
  proposedBy: string;
}

export interface MemoryBallot {
  candidateId: string;
  voter: string;
  value: BallotValue;
  rationale?: string;
}

export interface MemoryDecisionRecord {
  candidateId: string;
  scope: MemoryScope;
  decision: MemoryDecision;
  publication: PublicationState;
  quorum: number;
  ballots: MemoryBallot[];
  decidedBy: string;
}

export function validateMemoryCandidate(candidate: MemoryCandidate): void {
  if (!candidate.id.trim() || !candidate.statement.trim() || !candidate.proposedBy.trim()) {
    throw new StateContractError('INVALID_MEMORY_CANDIDATE', 'A memory candidate needs id, statement and proposer');
  }
  oneOf(candidate.scope, MEMORY_SCOPES, 'INVALID_MEMORY_SCOPE', 'scope');
  oneOf(candidate.knowledgeState, KNOWLEDGE_STATES, 'INVALID_KNOWLEDGE_STATE', 'knowledgeState');
  if (!candidate.source.location.trim() || !Number.isSafeInteger(candidate.source.revision) || candidate.source.revision < 1) {
    throw new StateContractError('INVALID_MEMORY_SOURCE', 'A memory candidate needs a complete source reference');
  }
  if (!candidate.source.complete) {
    throw new StateContractError('INCOMPLETE_MEMORY_SOURCE', 'A memory candidate cannot be decided without complete evidence');
  }
}

export function validateMemoryBallot(ballot: MemoryBallot): void {
  if (!ballot.candidateId.trim() || !ballot.voter.trim()) {
    throw new StateContractError('INVALID_BALLOT', 'A ballot needs a candidate and voter');
  }
  oneOf(ballot.value, BALLOT_VALUES, 'INVALID_BALLOT_VALUE', 'value');
}

export function validateMemoryDecision(decision: MemoryDecisionRecord): void {
  if (!decision.candidateId.trim() || !decision.decidedBy.trim()) {
    throw new StateContractError('INVALID_MEMORY_DECISION', 'A decision needs a candidate and decider');
  }
  oneOf(decision.scope, MEMORY_SCOPES, 'INVALID_MEMORY_SCOPE', 'scope');
  oneOf(decision.decision, MEMORY_DECISIONS, 'INVALID_MEMORY_DECISION', 'decision');
  oneOf(decision.publication, PUBLICATION_STATES, 'INVALID_PUBLICATION_STATE', 'publication');
  if (!Number.isSafeInteger(decision.quorum) || decision.quorum < 2) {
    throw new StateContractError('INVALID_QUORUM', 'Memory decisions require a quorum of at least two');
  }
  if (decision.ballots.length < decision.quorum) {
    throw new StateContractError('INSUFFICIENT_BALLOTS', 'The decision does not contain its declared quorum');
  }
  decision.ballots.forEach(validateMemoryBallot);
}
