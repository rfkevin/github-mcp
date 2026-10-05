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
  /** Target repository for applicability filtering. */
  repository?: string;
  /** Preferred scopes; default all. */
  scopes?: MemoryScope[];
  /** When true, hypotheses are returned with an explicit advisory flag. */
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

/**
 * Context selects relevant applicable entries. It does not dump journals.
 * A hypothesis never appears as unconditional instruction.
 */
export function projectMemory(
  entries: readonly MemoryEntryStatus[],
  query: ProjectionQuery = {},
): ProjectedMemory {
  const scopes = query.scopes ? new Set(query.scopes) : null;
  const selected: ProjectedMemory['entries'] = [];
  let accepted = 0;
  let deferred = 0;
  let rejected = 0;
  let contested = 0;
  let pending = 0;

  for (const entry of entries) {
    if (scopes && !scopes.has(entry.candidate.scope)) continue;
    if (entry.knowledgeState === 'hypothesis' && query.includeHypotheses === false) continue;

    if (entry.decision === 'accepted') accepted += 1;
    else if (entry.decision === 'deferred') deferred += 1;
    else if (entry.decision === 'rejected') rejected += 1;
    else if (entry.decision === 'contested') contested += 1;
    else pending += 1;

    const advisory =
      entry.knowledgeState === 'hypothesis'
        ? 'Hypothesis only: not an instruction until verified and accepted.'
        : entry.decision === 'accepted' && entry.publication !== 'effective'
          ? 'Accepted by vote; publication still ' + entry.publication + '.'
          : entry.decision === 'accepted'
            ? 'Accepted memory; treat as advisory lesson with source pointers.'
            : 'Not promoted: decision=' + entry.decision + '.';

    selected.push({ ...entry, advisory });
  }

  return { entries: selected, accepted, deferred, rejected, contested, pending };
}

/** Final regroup listing for L7-style collection. */
export function summarizeCollection(entries: readonly MemoryEntryStatus[]): {
  accepted: string[];
  deferred: string[];
  rejected: string[];
  contested: string[];
  pending: string[];
} {
  const bucket = (decision: MemoryEntryStatus['decision']) =>
    entries
      .filter((entry) => entry.decision === decision)
      .map((entry) => entry.candidate.id + '@' + entry.candidate.version);
  return {
    accepted: bucket('accepted'),
    deferred: bucket('deferred'),
    rejected: bucket('rejected'),
    contested: bucket('contested'),
    pending: entries
      .filter((entry) => entry.decision === 'pending' || entry.decision === 'none')
      .map((entry) => entry.candidate.id + '@' + entry.candidate.version),
  };
}
