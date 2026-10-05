import {
  StateContractError,
  validateMemoryCandidate,
} from '../contracts';
import type { KnowledgeState, MemoryCandidate, MemoryScope, SourceReference } from '../contracts';

/** Compact candidate fields for collective selection (C3). */
export type CandidateDraft = {
  id: string;
  version: string;
  scope: MemoryScope;
  statement: string;
  knowledgeState: KnowledgeState;
  source: SourceReference;
  proposedBy: string;
  applicability?: string;
  supersedes?: string;
  related?: string[];
  sensitivity?: 'public' | 'project' | 'restricted';
};

export type VersionedCandidate = CandidateDraft & {
  /** Prior version id this supersedes, when content/scope/evidence changed. */
  previousVersion?: string;
};

/**
 * Build a candidate for discussion history. Hypothesis may exist before complete evidence;
 * decision-time validation still requires complete sources (L1 contract).
 */
export function createCandidate(draft: CandidateDraft): VersionedCandidate {
  if (!draft.id.trim() || !draft.version.trim() || !draft.statement.trim() || !draft.proposedBy.trim()) {
    throw new StateContractError('INVALID_MEMORY_CANDIDATE', 'A memory candidate needs id, version, statement and proposer');
  }
  if (draft.knowledgeState === 'verified' || draft.knowledgeState === 'observed') {
    validateMemoryCandidate({
      id: draft.id,
      version: draft.version,
      scope: draft.scope,
      statement: draft.statement,
      knowledgeState: draft.knowledgeState,
      source: draft.source,
      proposedBy: draft.proposedBy,
    });
  } else {
    // hypothesis: allow partial/unavailable evidence; still require shape
    if (!draft.source.location.trim() || !Number.isSafeInteger(draft.source.revision) || draft.source.revision < 1) {
      throw new StateContractError('INVALID_MEMORY_SOURCE', 'A memory candidate needs a source reference');
    }
  }
  return { ...draft };
}

/**
 * Content/scope/evidence changes produce a new version and invalidate old ballots.
 * Pure navigation reordering does not.
 */
export function bumpCandidateVersion(
  previous: VersionedCandidate,
  changes: Partial<Pick<CandidateDraft, 'scope' | 'statement' | 'knowledgeState' | 'source' | 'applicability' | 'sensitivity'>>,
  nextVersion: string,
): VersionedCandidate {
  if (!nextVersion.trim() || nextVersion === previous.version) {
    throw new StateContractError('INVALID_CANDIDATE_VERSION', 'A changed candidate needs a new distinct version');
  }
  const next = createCandidate({
    ...previous,
    ...changes,
    id: previous.id,
    version: nextVersion,
    proposedBy: previous.proposedBy,
  });
  return { ...next, previousVersion: previous.version, supersedes: previous.id + '@' + previous.version };
}

export function candidateKey(candidate: Pick<MemoryCandidate, 'id' | 'version'>): string {
  return candidate.id + '@' + candidate.version;
}

/** A synthesis that changes meaning is a new candidate, not a silent merge of votes. */
export function assertSameMeaning(a: VersionedCandidate, b: VersionedCandidate): void {
  if (a.id !== b.id || a.version !== b.version) {
    throw new StateContractError('CANDIDATE_VERSION_MISMATCH', 'Ballots target a different candidate version');
  }
  if (a.scope !== b.scope || a.statement !== b.statement || a.knowledgeState !== b.knowledgeState) {
    throw new StateContractError('CANDIDATE_MEANING_CHANGED', 'Candidate meaning changed: open a new version and revote');
  }
}
