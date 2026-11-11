import { describe, expect, it } from 'vitest';
import { attemptRunId, answerAttemptRunId, taskKindMaxTokens } from '../../../src/collab-store/agentrun/plan';

describe('CC8 WorkSession — tentative et jetons cumulés sans plafond arbitraire', () => {
  it('conserve le même run_id au rejeu, distingue phase, ronde et tentative', async () => {
    const args = ['review', 'cc8-systeme-unique', 'gemini', 'S3', 'sha..base'] as const;
    const first = await attemptRunId(...args, 'P6', 1, 1);
    expect(await attemptRunId(...args, 'P6', 1, 1)).toBe(first);
    expect(await attemptRunId(...args, 'P6', 1, 2)).not.toBe(first);
    expect(await attemptRunId(...args, 'P6', 2, 1)).not.toBe(first);
    expect(await attemptRunId(...args, 'P7', 1, 1)).not.toBe(first);
  });
  it('autorise les tentatives 4, 50 et 1 000, sans collision, pour answer et review', async () => {
    for (const attempt of [4, 50, 1000]) {
      const review = await attemptRunId('review','cc8','gemini','S3','sha','P6',1,attempt);
      const answer = await answerAttemptRunId('cc8','gemini',19,'P6',1,attempt);
      expect(review).not.toBe(await attemptRunId('review','cc8','gemini','S3','sha','P6',1,attempt+1));
      expect(answer).not.toBe(await answerAttemptRunId('cc8','gemini',19,'P6',1,attempt+1));
    }
  });
  it('rejette toujours les tentatives invalides sans plafonner les tentatives valides', async () => {
    for(const attempt of [0,-1,NaN,1.2,Number.MAX_SAFE_INTEGER+1]){
      await expect(attemptRunId('review','cc8','gemini','S3','sha','P6',1,attempt))
        .rejects.toThrow('INVALID_RUN_ATTEMPT');
    }
  });
  it('ne borne pas le total des jetons selon kind, gratuité ou coût owner', () => {
    for(const kind of ['answer','design','review','test','implement'] as const){
      expect(taskKindMaxTokens(kind)).toBe(-1);
      expect(taskKindMaxTokens(kind,{AGENT_RUN_FREE_IMPLEMENT_MAX_TOKENS:'120000'})).toBe(-1);
      expect(taskKindMaxTokens(kind,{['AGENT_RUN_COST_CENTS_'+kind.toUpperCase()]:'5'})).toBe(-1);
    }
  });
});
