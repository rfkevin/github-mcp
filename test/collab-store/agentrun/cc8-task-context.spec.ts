import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { createReadToolHost } from '../../../src/collab-store/agentrun/read-tools';
import { insertCycleRow, insertTaskRow } from '../a0-helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let nonce = 0;
const NOW = 2_100_000_000;

async function fixture() {
  const id = ++nonce;
  const cycle = 'cc8-context-' + id + '-' + Date.now();
  const participant = 'cc8-context-agent-' + id;
  const task = 'small-task';
  await insertCycleRow(db, cycle, 'P6');
  await db.prepare("INSERT OR IGNORE INTO participants (participant_id, display_label, status) VALUES (?1, ?1, 'active')").bind(participant).run();
  await insertTaskRow(db, { cycle, taskId: task, owner: participant, reviewer: 'reviewer', tester: 'tester' });
  await db.prepare("UPDATE tasks SET status='in_progress', owned_paths=?3 WHERE cycle_id=?1 AND task_id=?2")
    .bind(cycle, task, JSON.stringify(['src/task.ts'])).run();
  const runId = 'cc8-context-run-' + id + '-' + Date.now();
  expect((await createRun(db, { runId, cycleId: cycle, participantId: participant, taskId: task, taskKind: 'implement',
    prompt: 'test', maxSteps: 6, maxTokens: 24_000, maxCostCents: 0, deadlineAt: NOW + 1200, now: NOW })).created).toBe(true);
  return { runId, task };
}

describe('CC8 S7 — vues du store task-first sous flag', () => {
  it('ne rend que la tâche courante et un curseur quand la compaction est activée', async () => {
    const f = await fixture();
    const host = createReadToolHost({ db, repository: null, github: null, continuity: true, contextCompaction: true });
    const result = await host.execute({ id: 'ctx', name: 'store_context', args: {} }, { run_id: f.runId }) as Record<string, unknown>;
    expect(result.scope).toBe('task-first');
    expect((result.task as { task_id: string }).task_id).toBe(f.task);
    expect(result).not.toHaveProperty('registry');
    expect(result).not.toHaveProperty('tasks');
    expect(result.recent_since_seq).toEqual(expect.any(Number));
    const delta = await host.execute({ id: 'd', name: 'store_delta', args: { since_seq: 0 } }, { run_id: f.runId }) as Record<string, unknown>;
    expect(delta).toHaveProperty('next_since_seq');
    expect(delta.filtered_for).toBe(f.task);
    const full = await host.execute({ id: 'd2', name: 'store_delta', args: { since_seq: 0, full: true } }, { run_id: f.runId }) as Record<string, unknown>;
    expect(full).not.toHaveProperty('filtered_for');
  });

  it('sans flag, conserve la forme historique du contexte en continuité', async () => {
    const f = await fixture();
    const host = createReadToolHost({ db, repository: null, github: null, continuity: true });
    const result = await host.execute({ id: 'ctx', name: 'store_context', args: {} }, { run_id: f.runId }) as Record<string, unknown>;
    expect(result).toHaveProperty('registry');
    expect(result).not.toHaveProperty('scope');
  });
});
