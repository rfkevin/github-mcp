import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, type ToolHost } from '../../../src/collab-store/agentrun/engine';
import { publishRunProof } from '../../../src/collab-store/agentrun/run-proof';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const clock = 2_000_000_000;
const forbiddenGitHub: ToolHost = {
  spec: () => null,
  list: () => [],
  execute: async () => { throw new Error('GitHub is not needed for invalid run proof'); },
};

type Case = {
  label: string; kind: string; state: string; reason: string;
  mandate: boolean; expectedState: 'skipped' | 'refused'; expectedReason: string;
};

const scenarios: Case[] = [
  ...(['answer', 'review', 'test'] as const).map(kind => ({
    label: kind + ' with a terminal final', kind, state: 'completed', reason: 'final',
    mandate: true, expectedState: 'skipped' as const,
    expectedReason: 'not_a_completed_implement_run',
  })),
  ...([
    ['running', 'running'],
    ['failed', 'incomplete_final'],
    ['completed', 'incomplete_final'],
  ] as const).map(([state, reason]) => ({
    label: 'implement ' + state + '/' + reason, kind: 'implement', state, reason,
    mandate: true, expectedState: 'skipped' as const,
    expectedReason: 'not_a_completed_implement_run',
  })),
  {
    label: 'implement final without owner GitHub mandate',
    kind: 'implement', state: 'completed', reason: 'final', mandate: false,
    expectedState: 'skipped', expectedReason: 'no_s7_mandate',
  },
  {
    label: 'implement final with a mandate but no commit/CI/PR',
    kind: 'implement', state: 'completed', reason: 'final', mandate: true,
    expectedState: 'refused', expectedReason: 'completion_evidence_missing',
  },
];

describe('S9 — server run.proof must correspond to a verified implement', () => {
  it.each(scenarios)('$label', async example => {
    await ensureSchema(db);
    const key = crypto.randomUUID();
    const cycle = 's9-real-kind-' + key;
    const runId = 'kind-' + key;
    const taskId = 'runproof-kind';
    const owner = 'vibe';

    expect((await createRun(db, {
      runId, cycleId: cycle, taskId, participantId: owner,
      taskKind: example.kind, prompt: 'Validate server run kind.',
      now: clock, deadlineAt: clock + 3600,
      maxSteps: -1, maxTokens: -1, maxCostCents: 0,
    })).created).toBe(true);

    await db.prepare('UPDATE agent_runs SET status=?2, stop_reason=?3 WHERE run_id=?1')
      .bind(runId, example.state, example.reason).run();

    const result = await publishRunProof(db, runId, {
      tools: forbiddenGitHub,
      now: () => clock + 10,
      githubCompletionGrants: example.mandate
        ? [{ cycle, task: taskId, participant: owner, branch: 'mcp/105856986/vibe-api-kind-proof' }]
        : [],
    });
    expect(result).toMatchObject({
      status: example.expectedState,
      reason: example.expectedReason,
    });

    const log = await db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE cycle_id=?1 AND type='run.proof'"
    ).bind(cycle).first<{ n: number }>();
    expect(log?.n ?? 0).toBe(0);

    const recorded = await db.prepare(
      'SELECT status FROM agent_run_proofs WHERE run_id=?1'
    ).bind(runId).first<{ status: string }>();
    expect(recorded?.status).toBe(example.expectedState === 'refused' ? 'refused' : undefined);
  });
});
