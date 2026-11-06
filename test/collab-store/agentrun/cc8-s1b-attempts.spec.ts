import { describe, expect, it } from 'vitest';
import { attemptRunId, answerAttemptRunId, taskKindMaxTokens } from '../../../src/collab-store/agentrun/plan';

describe('CC8 S1b — identifiants de tentatives et plafonds', () => {
  it('stable au rejeu, différent selon phase, ronde et tentative', async () => {
    const args = ['review', 'cc8-systeme-unique', 'gemini', 'S3', 'sha..base'] as const;
    const one = await attemptRunId(...args, 'P6', 1, 1);
    expect(await attemptRunId(...args, 'P6', 1, 1)).toBe(one);
    expect(await attemptRunId(...args, 'P6', 1, 2)).not.toBe(one);
    expect(await attemptRunId(...args, 'P6', 2, 1)).not.toBe(one);
    expect(await attemptRunId(...args, 'P7', 1, 1)).not.toBe(one);
  });
  it('answer : nouvelle ronde et nouvelle tentative donnent un autre ID', async () => {
    const first = await answerAttemptRunId('cc8', 'gemini', 19, 'P6', 1, 1);
    expect(await answerAttemptRunId('cc8', 'gemini', 19, 'P6', 1, 1)).toBe(first);
    expect(await answerAttemptRunId('cc8', 'gemini', 19, 'P6', 2, 1)).not.toBe(first);
    expect(await answerAttemptRunId('cc8', 'gemini', 19, 'P6', 1, 2)).not.toBe(first);
  });
  it('refuse toute tentative au-delà de trois', async () => {
    await expect(attemptRunId('review', 'cc8', 'gemini', 'S3', 'sha', 'P6', 1, 4)).rejects.toThrow('INVALID_RUN_ATTEMPT');
  });
  it('conserve les plafonds historiques sauf implement gratuit explicitement borné', () => {
    for (const kind of ['answer', 'review', 'test', 'design'] as const) {
      expect(taskKindMaxTokens(kind)).toBeGreaterThan(0);
      expect(taskKindMaxTokens(kind)).toBeLessThanOrEqual(24_000);
    }
    expect(taskKindMaxTokens('implement')).toBe(48_000);
    expect(taskKindMaxTokens('implement', { AGENT_RUN_FREE_IMPLEMENT_MAX_TOKENS: '120000' })).toBe(120_000);
    expect(taskKindMaxTokens('implement', { AGENT_RUN_COST_CENTS_IMPLEMENT: '1' })).toBe(24_000);
  });
});
