import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, reviewVerdictTurn, type ModelClient, type ToolHost } from '../../../src/collab-store/agentrun/engine';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

describe('CC8 U1 review/test final verdict opportunity', () => {
  it('reserves the last model turn to store_verdict and offers no discovery tool', async () => {
    await ensureSchema(db);
    const runId = 'u1-verdict-' + crypto.randomUUID();
    const now = 2_000_000_000;
    const created = await createRun(db, { runId, cycleId: runId, participantId: 'vibe',
      taskId: 'review-task', taskKind: 'review', prompt: 'Please review', maxSteps: 1,
      maxTokens: 48_000, maxCostCents: 0, deadlineAt: now + 900, now });
    expect(created.created).toBe(true);
    let offered: string[] = [];
    let instructions = '';
    const model: ModelClient = { async complete(input) {
      offered = input.tools;
      instructions = input.messages.map(m => m.content).join('\n');
      return { output: { text: 'No verdict can be written without the required evidence', tool_calls: [] },
        usage: { tokens: 30, cost_cents: 0 } };
    } };
    const tools: ToolHost = {
      spec: (_kind, name) => name === 'store_verdict' ? { name, effect: 'write' }
        : name === 'github_diff' ? { name, effect: 'read' } : null,
      list: () => ['github_diff', 'store_verdict'],
      execute: async () => null,
    };
    const result = await runStep(db, runId, { model, tools, now: () => now + 1, workerId: 'u1-worker' });
    expect(offered).toEqual(['store_verdict']);
    expect(instructions).toContain('store_verdict');
    expect(result.outcome).toBe('failed'); // Text without the structured store effect is NOT D12.
  });

  it('only applies to review/test and only at their terminal step', () => {
    expect(reviewVerdictTurn('review', 5, 6)).toBe(true);
    expect(reviewVerdictTurn('test', 5, 6)).toBe(true);
    expect(reviewVerdictTurn('review', 4, 6)).toBe(false);
    expect(reviewVerdictTurn('implement', 11, 12)).toBe(false);
  });
});
