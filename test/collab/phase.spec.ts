import { describe, expect, it } from 'vitest';
import { derivePhaseGuidance } from '../../src/collab/phase';

describe('CC-2 phase guidance', () => {
  it('gives an L1 author implementation actions in P5', () => {
    const guidance = derivePhaseGuidance('P5', 'author');
    expect(guidance.actions).toContain('implement_owned_paths');
    expect(guidance.ownerDecisionRequired).toBe(true);
  });

  it('keeps owner authority explicit while sync is pending', () => {
    const guidance = derivePhaseGuidance('P5', 'owner', { transition: 'P6' });
    expect(guidance.actions).toContain('authorize_transition');
    expect(guidance.ownerDecisionRequired).toBe(false);
    expect(guidance.advisory).toContain('P6');
  });

  it('rejects an unknown phase', () => {
    expect(() => derivePhaseGuidance('P9', 'tester')).toThrow(/unsupported value/);
  });
});
