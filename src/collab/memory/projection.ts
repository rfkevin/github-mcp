import type { KnowledgeState, MemoryScope } from '../contracts';
import type { VersionedCandidate } from './candidates';
import type { EvaluationOutcome } from './voting';

export type MemoryEntryStatus = {
  candidate: VersionedCandidate;
  decision: EvaluationOutcome['decision'] | 'none';
  publication: EvaluationOutcome['publication'] | 'unknown';
  knowledgeState: KnowledgeState;
};

export type ProjectionQuery = {
  /** Target repository; filters by candidate.applicability when both are set. */
  repository?: string;
  scopes?: MemoryScope[];
  includeHypotheses?: boolean;
};

export type ProjectedMemory = {
  entries: Array<MemoryEntryStatus & { advisory: string }>;
  accepted: number;
  deferred: number;
  rejected: number;
  contested: number;
  pending: number;
};

/** applicability empty = all repos; otherwise comma-separated repo names or *. */
export function matchesApplicability(applicability: string | undefined, repository: string | undefined): boolean {
  if (!repository) return true;
  if (!applicability || !applicability.trim()) return true;
  const tokens = applicability.split(',').map((part) => part.trim()).filter(Boolean);
  if (tokens.includes('*') || tokens.includes('all')) return true;
  return tokens.includes(repository);
}

function advisoryFor(entry: MemoryEntryStatus): string {
  if (entry.knowledgeState === 'hypothesis') {
    return 'Hypothesis only: not an instruction until verified and accepted.';
  }
  if (entry.decision === 'accepted' && entry.publication !== 'effective') {
    return 'Accepted by vote; publication still ' + entry.publication + '.';
  }
  if (entry.decision === 'accepted') {
    return 'Accepted memory; treat as advisory lesson with source pointers.';
  }
  return 'Not promoted: decision=' + entry.decision + '.';
}

export function projectMemory(
  entries: readonly MemoryEntryStatus[],
  query: ProjectionQuery = {},
): ProjectedMemory {
  const scopes = query.scopes ? new Set(query.scopes) : null;
  const selected: ProjectedMemory['entries'] = [];
  const counts = { accepted: 0, deferred: 0, rejected: 0, contested: 0, pending: 0 };

  for (const entry of entries) {
    if (scopes && !scopes.has(entry.candidate.scope)) continue;
    if (entry.knowledgeState === 'hypothesis' && query.includeHypotheses === false) continue;
    if (!matchesApplicability(entry.candidate.applicability, query.repository)) continue;

    if (entry.decision === 'accepted') counts.accepted += 1;
    else if (entry.decision === 'deferred') counts.deferred += 1;
    else if (entry.decision === 'rejected') counts.rejected += 1;
    else if (entry.decision === 'contested') counts.contested += 1;
    else counts.pending += 1;

    selected.push({ ...entry, advisory: advisoryFor(entry) });
  }

  return { entries: selected, ...counts };
}

export function summarizeCollection(entries: readonly MemoryEntryStatus[]): {
  accepted: string[];
  deferred: string[];
  rejected: string[];
  contested: string[];
  pending: string[];
} {
  const key = (entry: MemoryEntryStatus) => entry.candidate.id + '@' + entry.candidate.version;
  const bucket = (decision: MemoryEntryStatus['decision']) =>
    entries.filter((entry) => entry.decision === decision).map(key);
  return {
    accepted: bucket('accepted'),
    deferred: bucket('deferred'),
    rejected: bucket('rejected'),
    contested: bucket('contested'),
    pending: entries.filter((entry) => entry.decision === 'pending' || entry.decision === 'none').map(key),
  };
}
