import { describe, expect, it } from 'vitest';
import { allowedNextPhases, assertAllowedTransition } from '../../../src/collab-store/phases/gate';
import { CollabStoreError } from '../../../src/collab-store/store/collab-store';

describe('F5 A07 phase gate', () => {
  it('autorise framing -> proposals et refuse framing -> done', () => {
    expect(allowedNextPhases('framing')).toContain('proposals');
    expect(() => assertAllowedTransition('framing', 'proposals')).not.toThrow();
    expect(() => assertAllowedTransition('framing', 'done')).toThrow(CollabStoreError);
  });

  it('ferme closed', () => {
    expect(allowedNextPhases('closed')).toEqual([]);
    try {
      assertAllowedTransition('closed', 'framing');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CollabStoreError);
      expect((error as CollabStoreError).code).toBe('PHASE_TRANSITION_FORBIDDEN');
    }
  });
});
