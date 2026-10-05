import { StateContractError } from '../contracts';
import type { BallotValue, MemoryBallot, MemoryCandidate, MemoryDecision, MemoryDecisionRecord, PublicationState } from '../contracts';
import { candidateKey } from './candidates';
import type { VersionedCandidate } from './candidates';

export type ElectorateSnapshot = {
  roster: string[];
  openedAt: string;
  /** ISO-8601 UTC close time, or the literal token all-ballots. */
  closesAt: string;
  n: number;
};

export type BallotEvent = MemoryBallot & {
  candidateVersion: string;
  proposedScope: MemoryCandidate['scope'];
  recordedAt: string;
};

/** Explicit proof that the announced checkpoint may be evaluated. */
export type ClosureEvidence =
  | { kind: 'time'; now: string }
  | { kind: 'all_ballots_received' };

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
  closed: boolean;
};

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
  if (!closesAt.trim()) {
    throw new StateContractError('INVALID_CHECKPOINT_CLOSURE', 'A checkpoint needs closesAt (UTC time or all-ballots)');
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

/** True only when the announced close condition is met; never from quorum alone. */
export function isCheckpointClosed(
  electorate: ElectorateSnapshot,
  events: readonly BallotEvent[],
  closure: ClosureEvidence,
): boolean {
  if (closure.kind === 'time') {
    if (electorate.closesAt === 'all-ballots') return false;
    return closure.now >= electorate.closesAt;
  }
  const effective = latestBallots(events).filter((event) => electorate.roster.includes(event.voter));
  const voters = new Set(effective.map((event) => event.voter));
  return electorate.roster.every((name) => voters.has(name));
}

function pending(
  quorum: number,
  tallies: { keep: number; defer: number; reject: number; abstain: number; nonAbstaining: number; nonProposerKeep: number },
  effective: BallotEvent[],
  reason: string,
  closed: boolean,
): EvaluationOutcome {
  return {
    decision: 'pending',
    publication: 'pending',
    quorum,
    ...tallies,
    reason,
    effectiveBallots: effective,
    closed,
  };
}

function tallyBallots(effective: BallotEvent[], proposedBy: string) {
  let keep = 0;
  let defer = 0;
  let reject = 0;
  let abstain = 0;
  let nonProposerKeep = 0;
  for (const ballot of effective) {
    if (ballot.value === 'keep') {
      keep += 1;
      if (ballot.voter !== proposedBy) nonProposerKeep += 1;
    } else if (ballot.value === 'defer') defer += 1;
    else if (ballot.value === 'reject') reject += 1;
    else abstain += 1;
  }
  return { keep, defer, reject, abstain, nonAbstaining: keep + defer + reject, nonProposerKeep };
}

/**
 * Evaluate only with explicit closure evidence. Quorum alone never closes early.
 * keep: quorum + strict keep majority + >=2 non-proposer keep.
 * reject: quorum + strict reject majority; else deferred.
 * N < 3: always pending broader review.
 */
export function evaluateCheckpoint(
  candidate: VersionedCandidate,
  electorate: ElectorateSnapshot,
  events: readonly BallotEvent[],
  closure: ClosureEvidence,
): EvaluationOutcome {
  const quorum = computeQuorum(electorate.n);
  const matching = events.filter(
    (event) =>
      event.candidateId === candidate.id
      && event.candidateVersion === candidate.version
      && event.proposedScope === candidate.scope,
  );
  const effective = latestBallots(matching).filter((event) => electorate.roster.includes(event.voter));
  const tallies = tallyBallots(effective, candidate.proposedBy);
  const closed = isCheckpointClosed(electorate, matching, closure);

  if (!closed) {
    return pending(
      quorum,
      tallies,
      effective,
      'Checkpoint not closed: wait for closesAt or all-ballots-received; quorum alone is not final',
      false,
    );
  }

  if (electorate.n < 3) {
    return pending(quorum, tallies, effective, 'Fewer than three active participants: retain pending broader review', true);
  }

  if (tallies.nonAbstaining < quorum) {
    return pending(quorum, tallies, effective, 'Quorum not reached among non-abstaining ballots', true);
  }

  if (tallies.keep > tallies.defer + tallies.reject && tallies.nonProposerKeep >= 2) {
    return {
      decision: 'accepted',
      publication: 'pending',
      quorum,
      ...tallies,
      reason: 'Keep majority with two non-proposer favors; publication still pending Git write',
      effectiveBallots: effective,
      closed: true,
    };
  }

  if (tallies.reject > tallies.keep + tallies.defer) {
    return {
      decision: 'rejected',
      publication: 'pending',
      quorum,
      ...tallies,
      reason: 'Reject majority among non-abstaining ballots',
      effectiveBallots: effective,
      closed: true,
    };
  }

  return {
    decision: 'deferred',
    publication: 'pending',
    quorum,
    ...tallies,
    reason: 'No strict keep or reject majority (tie, missing non-proposer support, or defer-heavy)',
    effectiveBallots: effective,
    closed: true,
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
