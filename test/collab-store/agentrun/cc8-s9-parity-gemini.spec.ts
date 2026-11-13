import { describe, it, expect } from 'vitest';
import { missionOf } from '../../../../src/collab-store/agentrun/mission-quality';

describe('S9 S9-postfix-gemini parity test', () => {
  it('verifies functional grant with missionOf', () => {
    const functionalGrant = { mission: 'functional' as const, acceptance: ['act1'] };
    const spec = missionOf(functionalGrant);
    expect(spec.kind).toBe('functional');
    expect(spec.acceptance).toEqual(['act1']);
  });

  it('verifies absent/pilot grant with missionOf', () => {
    const absentGrant = undefined;
    const spec = missionOf(absentGrant);
    expect(spec.kind).toBe('pilot');
    expect(spec.acceptance).toEqual([]);
  });
});
