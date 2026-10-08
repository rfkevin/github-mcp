import { describe, expect, it } from 'vitest';
import { allowedNextPhases, assertAllowedTransition } from '../../../src/collab-store/phases/gate';
import { CollabStoreError } from '../../../src/collab-store/store/collab-store';

describe('F5 A07 phase gate', () => {
  it('autorise P1 -> P2 et refuse P1 -> P6', () => {
    expect(allowedNextPhases('P1')).toContain('P2');
    expect(() => assertAllowedTransition('P1', 'P2')).not.toThrow();
    expect(() => assertAllowedTransition('P1', 'P6')).toThrow(CollabStoreError);
  });

  it('ferme P6', () => {
    expect(allowedNextPhases('P6')).toEqual([]);
    try {
      assertAllowedTransition('P6', 'P1');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CollabStoreError);
      expect((error as CollabStoreError).code).toBe('PHASE_TRANSITION_FORBIDDEN');
    }
  });
});
