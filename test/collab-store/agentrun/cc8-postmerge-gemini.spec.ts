import { describe, it, expect } from 'vitest';
import { missionOf } from '../../../src/collab-store/agentrun/mission-quality';

describe('cc8-postmerge-gemini functional mission quality tests', () => {
  it('correctly parses functional mission and acceptance list', () => {
    const grant = {
      mission: 'functional' as const,
      acceptance: ['Item 1', 'Item 2']
    };
    const spec = missionOf(grant);
    expect(spec.kind).toBe('functional');
    expect(spec.acceptance).toEqual(['Item 1', 'Item 2']);
  });

  it('falls back to pilot when grant is absent or undefined', () => {
    const spec = missionOf(undefined);
    expect(spec.kind).toBe('pilot');
    expect(spec.acceptance).toEqual([]);
  });
});
