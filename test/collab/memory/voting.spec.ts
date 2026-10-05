import { describe, expect, it } from 'vitest';
import { createCandidate } from '../../../src/collab/memory/candidates';
import {
  computeQuorum,
  evaluateCheckpoint,
  openElectorate,
  recordBallot,
  toDecisionRecord,
} from '../../../src/collab/memory/voting';
import type { ClosureEvidence } from '../../../src/collab/memory/voting';

const source = { location: 'rfkevin/project-mcp-collab#16/1', revision: 1, completeness: 'complete' as const };
const closed: ClosureEvidence = { kind: 'time', now: '2026-10-05T21:00:00Z' };
const early: ClosureEvidence = { kind: 'time', now: '2026-10-05T19:00:00Z' };

const candidate = createCandidate({
  id: 'mem-1',
  version: '1',
  scope: 'global_usage',
  statement: 'Prefer portable checkpoints over lastSeen alone.',
  knowledgeState: 'observed',
  source,
  proposedBy: 'Grok',
});

const roster6 = ['Codex', 'Vibe GLM', 'GPT-5.6 Sol', 'Cline', 'Muse Spark', 'Grok'];

function electorate(closesAt = '2026-10-05T20:00:00Z') {
  return openElectorate(roster6, '2026-10-05T18:00:00Z', closesAt);
}

describe('L5 voting policy', () => {
  it('computes quorum for N=6 and N=3', () => {
    expect(computeQuorum(6)).toBe(4);
    expect(computeQuorum(3)).toBe(2);
    expect(computeQuorum(2)).toBe(2);
  });

  it('refuses final decisions before announced closure even with quorum', () => {
    const el = electorate();
    const events = [
      recordBallot(el, candidate, { voter: 'Grok', value: 'keep', recordedAt: 't1' }),
      recordBallot(el, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
      recordBallot(el, candidate, { voter: 'Cline', value: 'keep', recordedAt: 't3' }),
      recordBallot(el, candidate, { voter: 'Codex', value: 'keep', recordedAt: 't4' }),
    ];
    const outcome = evaluateCheckpoint(candidate, el, events, early);
    expect(outcome.closed).toBe(false);
    expect(outcome.decision).toBe('pending');
    expect(outcome.reason).toMatch(/not closed/);
    expect(toDecisionRecord(candidate, outcome, 'assembler')).toBeNull();
  });

  it('accepts with 3 keep / 1 defer including two non-proposers after closure', () => {
    const el = electorate();
    const events = [
      recordBallot(el, candidate, { voter: 'Grok', value: 'keep', recordedAt: 't1' }),
      recordBallot(el, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
      recordBallot(el, candidate, { voter: 'Cline', value: 'keep', recordedAt: 't3' }),
      recordBallot(el, candidate, { voter: 'Codex', value: 'defer', recordedAt: 't4' }),
    ];
    const outcome = evaluateCheckpoint(candidate, el, events, closed);
    expect(outcome.closed).toBe(true);
    expect(outcome.decision).toBe('accepted');
    expect(outcome.nonProposerKeep).toBe(2);
    expect(outcome.publication).toBe('pending');
    expect(toDecisionRecord(candidate, outcome, 'assembler')?.decision).toBe('accepted');
  });

  it('ties 2 keep / 2 reject stay deferred after closure', () => {
    const el = electorate();
    const events = [
      recordBallot(el, candidate, { voter: 'Grok', value: 'keep', recordedAt: 't1' }),
      recordBallot(el, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
      recordBallot(el, candidate, { voter: 'Cline', value: 'reject', recordedAt: 't3' }),
      recordBallot(el, candidate, { voter: 'Codex', value: 'reject', recordedAt: 't4' }),
    ];
    expect(evaluateCheckpoint(candidate, el, events, closed).decision).toBe('deferred');
  });

  it('proposer keep without two other keeps never promotes', () => {
    const el = electorate();
    const events = [
      recordBallot(el, candidate, { voter: 'Grok', value: 'keep', recordedAt: 't1' }),
      recordBallot(el, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
      recordBallot(el, candidate, { voter: 'Cline', value: 'defer', recordedAt: 't3' }),
      recordBallot(el, candidate, { voter: 'Codex', value: 'defer', recordedAt: 't4' }),
    ];
    const outcome = evaluateCheckpoint(candidate, el, events, closed);
    expect(outcome.decision).not.toBe('accepted');
    expect(outcome.nonProposerKeep).toBe(1);
  });

  it('N=3 can accept with both non-proposers keep', () => {
    const el = openElectorate(['Grok', 'Vibe GLM', 'Cline'], 't0', 't-close');
    const events = [
      recordBallot(el, candidate, { voter: 'Grok', value: 'keep', recordedAt: 't1' }),
      recordBallot(el, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
      recordBallot(el, candidate, { voter: 'Cline', value: 'keep', recordedAt: 't3' }),
    ];
    expect(evaluateCheckpoint(candidate, el, events, { kind: 'time', now: 't-close' }).decision).toBe('accepted');
  });

  it('N<3 always pending broader review after closure', () => {
    const el = openElectorate(['Grok', 'Vibe GLM'], 't0', 't-close');
    const events = [
      recordBallot(el, candidate, { voter: 'Grok', value: 'keep', recordedAt: 't1' }),
      recordBallot(el, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
    ];
    expect(evaluateCheckpoint(candidate, el, events, { kind: 'time', now: 't-close' }).decision).toBe('pending');
  });

  it('all-ballots closure works when every elector has voted', () => {
    const el = openElectorate(['Grok', 'Vibe GLM', 'Cline'], 't0', 'all-ballots');
    const events = [
      recordBallot(el, candidate, { voter: 'Grok', value: 'keep', recordedAt: 't1' }),
      recordBallot(el, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
      recordBallot(el, candidate, { voter: 'Cline', value: 'keep', recordedAt: 't3' }),
    ];
    const before = evaluateCheckpoint(candidate, el, events.slice(0, 2), { kind: 'all_ballots_received' });
    expect(before.decision).toBe('pending');
    expect(before.closed).toBe(false);
    const after = evaluateCheckpoint(candidate, el, events, { kind: 'all_ballots_received' });
    expect(after.closed).toBe(true);
    expect(after.decision).toBe('accepted');
  });

  it('latest ballot per voter wins; stale version ballots ignored', () => {
    const el = electorate();
    const events = [
      recordBallot(el, candidate, { voter: 'Vibe GLM', value: 'reject', recordedAt: 't1' }),
      recordBallot(el, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
      recordBallot(el, candidate, { voter: 'Cline', value: 'keep', recordedAt: 't3' }),
      recordBallot(el, candidate, { voter: 'Codex', value: 'keep', recordedAt: 't4' }),
      recordBallot(el, candidate, { voter: 'GPT-5.6 Sol', value: 'keep', recordedAt: 't5' }),
      {
        candidateId: 'mem-1',
        candidateVersion: '0',
        proposedScope: 'global_usage' as const,
        voter: 'Muse Spark',
        value: 'keep' as const,
        recordedAt: 't6',
      },
    ];
    const outcome = evaluateCheckpoint(candidate, el, events, closed);
    expect(outcome.keep).toBe(4);
    expect(outcome.decision).toBe('accepted');
  });

  it('rejects outsider voters', () => {
    const el = openElectorate(['Grok', 'Vibe GLM', 'Cline'], 't0', 't-close');
    expect(() => recordBallot(el, candidate, { voter: 'Claude', value: 'keep', recordedAt: 't1' })).toThrow(
      /not in the fixed electorate/,
    );
  });
});
