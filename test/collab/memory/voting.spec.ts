import { describe, expect, it } from 'vitest';
import { createCandidate } from '../../../src/collab/memory/candidates';
import {
  computeQuorum,
  evaluateCheckpoint,
  openElectorate,
  recordBallot,
  toDecisionRecord,
} from '../../../src/collab/memory/voting';

const source = { location: 'rfkevin/project-mcp-collab#16/1', revision: 1, completeness: 'complete' as const };

const candidate = createCandidate({
  id: 'mem-1',
  version: '1',
  scope: 'global_usage',
  statement: 'Prefer portable checkpoints over lastSeen alone.',
  knowledgeState: 'observed',
  source,
  proposedBy: 'Grok',
});

describe('L5 voting policy', () => {
  it('computes quorum for N=6 and N=3', () => {
    expect(computeQuorum(6)).toBe(4);
    expect(computeQuorum(3)).toBe(2);
    expect(computeQuorum(2)).toBe(2);
  });

  it('accepts with 3 keep / 1 defer including two non-proposers (N=6)', () => {
    const electorate = openElectorate(
      ['Codex', 'Vibe GLM', 'GPT-5.6 Sol', 'Cline', 'Muse Spark', 'Grok'],
      '2026-10-05T18:00:00Z',
      '2026-10-05T20:00:00Z',
    );
    const events = [
      recordBallot(electorate, candidate, { voter: 'Grok', value: 'keep', recordedAt: 't1' }),
      recordBallot(electorate, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
      recordBallot(electorate, candidate, { voter: 'Cline', value: 'keep', recordedAt: 't3' }),
      recordBallot(electorate, candidate, { voter: 'Codex', value: 'defer', recordedAt: 't4' }),
    ];
    const outcome = evaluateCheckpoint(candidate, electorate, events);
    expect(outcome.decision).toBe('accepted');
    expect(outcome.nonProposerKeep).toBe(2);
    expect(outcome.publication).toBe('pending');
    expect(toDecisionRecord(candidate, outcome, 'assembler')?.decision).toBe('accepted');
  });

  it('ties 2 keep / 2 reject stay pending (no strict majority)', () => {
    const electorate = openElectorate(
      ['Codex', 'Vibe GLM', 'GPT-5.6 Sol', 'Cline', 'Muse Spark', 'Grok'],
      't0',
      't-close',
    );
    const events = [
      recordBallot(electorate, candidate, { voter: 'Grok', value: 'keep', recordedAt: 't1' }),
      recordBallot(electorate, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
      recordBallot(electorate, candidate, { voter: 'Cline', value: 'reject', recordedAt: 't3' }),
      recordBallot(electorate, candidate, { voter: 'Codex', value: 'reject', recordedAt: 't4' }),
    ];
    expect(evaluateCheckpoint(candidate, electorate, events).decision).toBe('deferred');
  });

  it('proposer keep without two other keeps never promotes', () => {
    const electorate = openElectorate(
      ['Codex', 'Vibe GLM', 'GPT-5.6 Sol', 'Cline', 'Muse Spark', 'Grok'],
      't0',
      't-close',
    );
    const events = [
      recordBallot(electorate, candidate, { voter: 'Grok', value: 'keep', recordedAt: 't1' }),
      recordBallot(electorate, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
      recordBallot(electorate, candidate, { voter: 'Cline', value: 'defer', recordedAt: 't3' }),
      recordBallot(electorate, candidate, { voter: 'Codex', value: 'defer', recordedAt: 't4' }),
    ];
    // keep=2, other non-abstaining=2 → not strict keep majority; also nonProposerKeep=1 < 2
    const outcome = evaluateCheckpoint(candidate, electorate, events);
    expect(outcome.decision).not.toBe('accepted');
    expect(outcome.nonProposerKeep).toBe(1);
  });

  it('N=3 can accept with both non-proposers keep', () => {
    const electorate = openElectorate(['Grok', 'Vibe GLM', 'Cline'], 't0', 't-close');
    const events = [
      recordBallot(electorate, candidate, { voter: 'Grok', value: 'keep', recordedAt: 't1' }),
      recordBallot(electorate, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
      recordBallot(electorate, candidate, { voter: 'Cline', value: 'keep', recordedAt: 't3' }),
    ];
    expect(evaluateCheckpoint(candidate, electorate, events).decision).toBe('accepted');
  });

  it('N<3 always pending broader review', () => {
    const electorate = openElectorate(['Grok', 'Vibe GLM'], 't0', 't-close');
    const events = [
      recordBallot(electorate, candidate, { voter: 'Grok', value: 'keep', recordedAt: 't1' }),
      recordBallot(electorate, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
    ];
    expect(evaluateCheckpoint(candidate, electorate, events).decision).toBe('pending');
  });

  it('latest ballot per voter wins; stale version ballots ignored', () => {
    const electorate = openElectorate(
      ['Codex', 'Vibe GLM', 'GPT-5.6 Sol', 'Cline', 'Muse Spark', 'Grok'],
      't0',
      't-close',
    );
    const events = [
      recordBallot(electorate, candidate, { voter: 'Vibe GLM', value: 'reject', recordedAt: 't1' }),
      recordBallot(electorate, candidate, { voter: 'Vibe GLM', value: 'keep', recordedAt: 't2' }),
      recordBallot(electorate, candidate, { voter: 'Cline', value: 'keep', recordedAt: 't3' }),
      recordBallot(electorate, candidate, { voter: 'Codex', value: 'keep', recordedAt: 't4' }),
      recordBallot(electorate, candidate, { voter: 'GPT-5.6 Sol', value: 'keep', recordedAt: 't5' }),
      {
        candidateId: 'mem-1',
        candidateVersion: '0',
        proposedScope: 'global_usage' as const,
        voter: 'Muse Spark',
        value: 'keep' as const,
        recordedAt: 't6',
      },
    ];
    const outcome = evaluateCheckpoint(candidate, electorate, events);
    // Vibe reject superseded; stale v0 ignored; 4 keep meets Q=4
    expect(outcome.keep).toBe(4);
    expect(outcome.decision).toBe('accepted');
  });

  it('rejects outsider voters', () => {
    const electorate = openElectorate(['Grok', 'Vibe GLM', 'Cline'], 't0', 't-close');
    expect(() => recordBallot(electorate, candidate, { voter: 'Claude', value: 'keep', recordedAt: 't1' })).toThrow(
      /not in the fixed electorate/,
    );
  });
});
