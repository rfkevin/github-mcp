import { StateContractError } from '../contracts';
import type { BallotValue, MemoryBallot, MemoryCandidate, MemoryDecision, MemoryDecisionRecord, PublicationState } from '../contracts';
import { candidateKey } from './candidates';
import type { VersionedCandidate } from './candidates';

export type ElectorateSnapshot = {
  /** Participants who accepted the cycle and were active when the checkpoint opened. */
  roster: string[];
  openedAt: string;
  /** UTC close time or explicit all-ballots condition label. */
  closesAt: string;
  /** Fixed N for this checkpoint; silence does not reduce N. */
  n: number;
};

export type BallotEvent = MemoryBallot & {
  candidateVersion: string;
  proposedScope: MemoryCandidate['scope'];
  recordedAt: string;
};

export type EvaluationOutcome = {
  decision: MemoryDecision | 'pending';
  publication: PublicationState;
  quorum: number;
  keep: number;
  defer: number;
  reject: number;
  abstain: number;
  nonAbstaining: number;
  nonProposerKeep: number;
  reason: string;
  effectiveBallots: BallotEvent[];
};

/** Q = max(2, floor(N/2)+1) among non-abstaining capacity; N is fixed at open. */
export function computeQuorum(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new StateContractError('INVALID_ELECTORATE', 'Electorate size must be a positive integer');
  }
  return Math.max(2, Math.floor(n / 2) + 1);
}

export function openElectorate(roster: readonly string[], openedAt: string, closesAt: string): ElectorateSnapshot {
  const cleaned = [...new Set(roster.map((name) => name.trim()).filter(Boolean))];
  if (cleaned.length !== roster.filter((name) => name.trim()).length) {
    throw new StateContractError('DUPLICATE_ELECTOR', 'Electorate roster cannot list a participant twice');
  }
  if (cleaned.length < 1) {
    throw new StateContractError('INVALID_ELECTORATE', 'Electorate needs at least one participant');
  }
  return { roster: cleaned, openedAt, closesAt, n: cleaned.length };
}

function latestBallots(events: readonly BallotEvent[]): BallotEvent[] {
  const byVoter = new Map<string, BallotEvent>();
  for (const event of events) {
    const previous = byVoter.get(event.voter);
    if (!previous || previous.recordedAt <= event.recordedAt) {
      byVoter.set(event.voter, event);
    }
  }
  return [...byVoter.values()];
}

export function recordBallot(
  electorate: ElectorateSnapshot,
  candidate: VersionedCandidate,
  ballot: { voter: string; value: BallotValue; rationale?: string; recordedAt: string },
): BallotEvent {
  if (!electorate.roster.includes(ballot.voter)) {
    throw new StateContractError('VOTER_NOT_IN_ELECTORATE', 'Voter is not in the fixed electorate snapshot');
  }
  if (!ballot.recordedAt.trim()) {
    throw new StateContractError('INVALID_BALLOT', 'A ballot needs a recordedAt timestamp');
  }
  return {
    candidateId: candidate.id,
    candidateVersion: candidate.version,
    proposedScope: candidate.scope,
    voter: ballot.voter,
    value: ballot.value,
    rationale: ballot.rationale,
    recordedAt: ballot.recordedAt,
  };
}

/**
 * Evaluate at announced closure only. Uncast votes are absence, not agreement.
 * keep: quorum + strict keep majority among non-abstaining + >=2 non-proposer keep.
 * reject: quorum + strict reject majority; else defer/pending.
 * N < 3: always pending broader review.
 */
export function evaluateCheckpoint(
  candidate: VersionedCandidate,
  electorate: ElectorateSnapshot,
  events: readonly BallotEvent[],
): EvaluationOutcome {
  const quorum = computeQuorum(electorate.n);
  const matching = events.filter(
    (event) =>
      event.candidateId === candidate.id
      && event.candidateVersion === candidate.version
      && event.proposedScope === candidate.scope,
  );
  const effective = latestBallots(matching).filter((event) => electorate.roster.includes(event.voter));

  let keep = 0;
  let defer = 0;
  let reject = 0;
  let abstain = 0;
  let nonProposerKeep = 0;
  for (const ballot of effective) {
    if (ballot.value === 'keep') {
      keep += 1;
      if (ballot.voter !== candidate.proposedBy) nonProposerKeep += 1;
    } else if (ballot.value === 'defer') defer += 1;
    else if (ballot.value === 'reject') reject += 1;
    else abstain += 1;
  }
  const nonAbstaining = keep + defer + reject;

  if (electorate.n < 3) {
    return {
      decision: 'pending',
      publication: 'pending',
      quorum,
      keep,
      defer,
      reject,
      abstain,
      nonAbstaining,
      nonProposerKeep,
      reason: 'Fewer than three active participants: retain pending broader review',
      effectiveBallots: effective,
    };
  }

  if (nonAbstaining < quorum) {
    return {
      decision: 'pending',
      publication: 'pending',
      quorum,
      keep,
      defer,
      reject,
      abstain,
      nonAbstaining,
      nonProposerKeep,
      reason: 'Quorum not reached among non-abstaining ballots',
      effectiveBallots: effective,
    };
  }

  if (keep > defer + reject && nonProposerKeep >= 2) {
    return {
      decision: 'accepted',
      publication: 'pending',
      quorum,
      keep,
      defer,
      reject,
      abstain,
      nonAbstaining,
      nonProposerKeep,
      reason: 'Keep majority with two non-proposer favors; publication still pending Git write',
      effectiveBallots: effective,
    };
  }

  if (reject > keep + defer) {
    return {
      decision: 'rejected',
      publication: 'pending',
      quorum,
      keep,
      defer,
      reject,
      abstain,
      nonAbstaining,
      nonProposerKeep,
      reason: 'Reject majority among non-abstaining ballots',
      effectiveBallots: effective,
    };
  }

  return {
    decision: 'deferred',
    publication: 'pending',
    quorum,
    keep,
    defer,
    reject,
    abstain,
    nonAbstaining,
    nonProposerKeep,
    reason: 'No strict keep or reject majority (tie, missing non-proposer support, or defer-heavy)',
    effectiveBallots: effective,
  };
}

export function toDecisionRecord(
  candidate: VersionedCandidate,
  outcome: EvaluationOutcome,
  decidedBy: string,
): MemoryDecisionRecord | null {
  if (outcome.decision === 'pending') return null;
  return {
    candidateId: candidate.id,
    candidateVersion: candidate.version,
    scope: candidate.scope,
    decision: outcome.decision,
    publication: outcome.publication,
    quorum: outcome.quorum,
    ballots: outcome.effectiveBallots.map((event) => ({
      candidateId: event.candidateId,
      voter: event.voter,
      value: event.value,
      rationale: event.rationale,
    })),
    decidedBy,
  };
}

export function assertBallotTargetsCandidate(event: BallotEvent, candidate: VersionedCandidate): void {
  if (event.candidateId !== candidate.id || event.candidateVersion !== candidate.version) {
    throw new StateContractError(
      'CANDIDATE_VERSION_MISMATCH',
      'Ballot targets ' + event.candidateId + '@' + event.candidateVersion + ' not ' + candidateKey(candidate),
    );
  }
  if (event.proposedScope !== candidate.scope) {
    throw new StateContractError('INVALID_MEMORY_SCOPE', 'Ballot scope does not match the candidate scope');
  }
}
