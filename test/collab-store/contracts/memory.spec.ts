import { describe, expect, it } from 'vitest';
import {
  validateLedgerEntry,
  validateMemoryActivation,
  validateMemoryEntry,
  validateMemoryScope,
} from '../../../src/collab-store/contracts/memory';
import {
  opIdToIdempotencyKey,
  validateOpId,
  validatePhaseDefinition,
  validateSealedProposal,
} from '../../../src/collab-store/contracts/phases';

const entry = {
  scope: 'role:reviewer',
  kind: 'lesson' as const,
  text: 'Bounded delta reads before full discussion reads.',
  evidence_refs: ['issue-24#issuecomment-1'],
  confidence: 'observed' as const,
  status: 'active' as const,
  author_pid: 'p:muse',
};

describe('CC-3 C1 memory + ledger', () => {
  it('validates scopes, kinds and the 600-char one-fact rule', () => {
    expect(() => validateMemoryEntry(entry)).not.toThrow();
    expect(validateMemoryScope('participant:p:1')).toBe('participant:p:1');
    expect(() => validateMemoryScope('everywhere')).toThrow(/Invalid memory scope/);
    expect(() => validateMemoryEntry({ ...entry, text: 'x'.repeat(601) }))
      .toThrow(/1-600 chars/);
    expect(() => validateMemoryEntry({ ...entry, kind: 'vibe' as never }))
      .toThrow(/unsupported value/);
  });

  it('requires evidence beyond candidate status', () => {
    expect(() => validateMemoryEntry({ ...entry, status: 'candidate', evidence_refs: [] }))
      .not.toThrow();
    expect(() => validateMemoryEntry({ ...entry, evidence_refs: [] }))
      .toThrow(/at least one evidence_ref/);
  });

  it('forbids self-activation (reviewer != author)', () => {
    expect(() => validateMemoryActivation('p:muse', 'p:vibe')).not.toThrow();
    expect(() => validateMemoryActivation('p:muse', 'p:muse')).toThrow(/distinct from the author/);
  });

  it('rejects ledger self-writes (I11: producer = subject)', () => {
    expect(() => validateLedgerEntry({
      subject_pid: 'p:muse', producer: 'p:grok', kind: 'test',
      payload_json: '{"ok":true}',
    })).not.toThrow();
    expect(() => validateLedgerEntry({
      subject_pid: 'p:muse', producer: 'p:muse', kind: 'test',
      payload_json: '{"ok":true}',
    })).toThrow(/cannot produce its own ledger record/);
    expect(() => validateLedgerEntry({
      subject_pid: 'p:muse', producer: 'system', kind: 'metric',
      payload_json: '{"ok":true}',
    })).not.toThrow();
  });
});

describe('CC-3 C1 phases, sealing and op_id', () => {
  it('validates phase definitions and sealed proposals', () => {
    expect(() => validatePhaseDefinition({
      cycle_id: 'cc3', phase: 'P1', entry_conditions: [], exit_conditions: [],
      expected_outputs: [{ role: 'author', kind: 'proposal', count: 1 }],
      auto_advance: 'none',
    })).not.toThrow();
    expect(() => validatePhaseDefinition({
      cycle_id: 'cc3', phase: 'P9' as never, entry_conditions: [], exit_conditions: [],
      expected_outputs: [], auto_advance: 'none',
    })).toThrow();
    expect(() => validateSealedProposal({
      cycle_id: 'cc3', phase: 'P1', participant_id: 'p:muse',
      content_hash: 'a'.repeat(64),
    })).not.toThrow();
    expect(() => validateSealedProposal({
      cycle_id: 'cc3', phase: 'P1', participant_id: 'p:muse', content_hash: 'zzz',
    })).toThrow(/content_hash must be hex/);
  });

  it('enforces the deterministic op_id policy (Vibe R2, F1)', () => {
    const op = 'gh:cc3:task-claim:0000000007';
    expect(validateOpId(op)).toBe(op);
    expect(opIdToIdempotencyKey(op)).toContain(op);
    expect(() => validateOpId('random-key')).toThrow(/op_id must match/);
    expect(() => validateOpId('')).toThrow(/op_id must match/);
  });
});
