import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, type ToolHost } from '../../../src/collab-store/agentrun/engine';
import { publishRunProof } from '../../../src/collab-store/agentrun/run-proof';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const NOW = 2_000_000_000;

/** Any GitHub read would mean a non-eligible run escaped the early server guard. */
const noGitHub: ToolHost = {
  spec: () => null,
  list: () => [],
  async execute() {
    throw new Error('GitHub must not be contacted for a run without admissible evidence');
  },
};

async function fixture(kind: string, status: string, stopReason: string) {
  await ensureSchema(db);
  const unique = crypto.randomUUID();
  const cycle = 's9-proof-kind-' + unique;
  const task = 's9-proof-kind';
  const participant = 'vibe';
  const runId = 's9-proof-' + unique;
  const created = await createRun(db, {
    runId, cycleId: cycle, participantId: participant, taskId: task,
    taskKind: kind, prompt: 'Check server proof eligibility.',
    maxSteps: -1, maxTokens: -1, maxCostCents: 0,
    now: NOW, deadlineAt: NOW + 3600,
  });
  expect(created.created).toBe(true);
  await db.prepare('UPDATE agent_runs SET status=?2, stop_reason=?3 WHERE run_id=?1')
    .bind(runId, status, stopReason).run();
  return { cycle, task, participant, runId };
}

async function assertNoPublishedProof(cycle: string, runId: string) {
  const event = await db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE cycle_id=?1 AND type='run.proof'"
  ).bind(cycle).first<{ n: number }>();
  const row = await db.prepare(
    'SELECT status FROM agent_run_proofs WHERE run_id=?1'
  ).bind(runId).first<{ status: string }>();
  expect(event?.n ?? 0).toBe(0);
  expect(row?.status).not.toBe('published');
}

describe('CC8 S9 - proof of real API task kind', () => {
  it.each(['answer', 'review', 'test'])(
    'never publishes an implement run.proof from completed %s',
    async kind => {
      const f = await fixture(kind, 'completed', 'final');
      const result = await publishRunProof(db, f.runId, {
        tools: noGitHub,
        githubCompletionGrants: [{
          cycle: f.cycle, task: f.task, participant: f.participant,
          branch: 'mcp/105856986/vibe-api-kind-proof',
        }],
        now: () => NOW + 10,
      });
      expect(result).toEqual({ status: 'skipped', reason: 'not_a_completed_implement_run' });
      await assertNoPublishedProof(f.cycle, f.runId);
    },
  );

  it.each([
    ['running', 'running'],
    ['failed', 'incomplete_final'],
    ['completed', 'incomplete_final'],
  ])('does not publish an unfinished implement run (%s / %s)', async (status, stopReason) => {
    const f = await fixture('implement', status, stopReason);
    const result = await publishRunProof(db, f.runId, {
      tools: noGitHub,
      now: () => NOW + 10,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'not_a_completed_implement_run' });
    await assertNoPublishedProof(f.cycle, f.runId);
  });

  it('a completed implement without a mandate is not accepted as run proof', async () => {
    const f = await fixture('implement', 'completed', 'final');
    const result = await publishRunProof(db, f.runId, {
      tools: noGitHub,
      now: () => NOW + 10,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'no_s7_mandate' });
    await assertNoPublishedProof(f.cycle, f.runId);
  });

  it('a mandated implement without commit, CI and PR evidence is refused', async () => {
    const f = await fixture('implement', 'completed', 'final');
    const result = await publishRunProof(db, f.runId, {
      tools: noGitHub,
      githubCompletionGrants: [{
        cycle: f.cycle, task: f.task, participant: f.participant,
        branch: 'mcp/105856986/vibe-api-kind-proof',
      }],
      now: () => NOW + 10,
    });
    expect(result).toEqual({ status: 'refused', reason: 'completion_evidence_missing' });
    const row = await db.prepare(
      'SELECT status, reason FROM agent_run_proofs WHERE run_id=?1'
    ).bind(f.runId).first<{ status: string; reason: string }>();
    expect(row).toMatchObject({ status: 'refused', reason: 'completion_evidence_missing' });
    await assertNoPublishedProof(f.cycle, f.runId);
  });
});
