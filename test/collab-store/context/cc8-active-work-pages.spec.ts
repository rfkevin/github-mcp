import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { loadActiveWork, loadActiveWorkPage } from '../../../src/collab-store/context/active-work';
import { createReadToolHost } from '../../../src/collab-store/agentrun/read-tools';
import { registerParticipant, mapClient } from '../../../src/collab-store/owner/decisions';
import { collabToolHandler, OWNER_PROOF } from '../coordinator-helpers';
import { outputSchemas } from '../../../src/collab-store/mcp/schemas';
import { z } from 'zod';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

async function seedCycle(): Promise<{ cycle: string; mine: string; other: string }> {
  await ensureSchema(db);
  const cycle = 'cc8-page-' + crypto.randomUUID();
  const mine = 'cc8-agent-' + crypto.randomUUID();
  const other = 'cc8-other-' + crypto.randomUUID();
  await db.prepare(
    "INSERT INTO cycles (cycle_id, project, phase, revision, status) VALUES (?1, 'rfkevin/github-mcp', 'P6', 1, 'open')"
  ).bind(cycle).run();
  return { cycle, mine, other };
}

async function checkpoint(cycle: string, participant: string, task: string, n: number): Promise<void> {
  await db.prepare([
    'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
    "VALUES (?1, ?2, 'checkpoint', ?3, '', ?4, ?5, 0, ?6, '')",
  ].join(' ')).bind(cycle, 10_000 + n, participant, n % 2 === 0 ? 'api-agent' : 'author',
    JSON.stringify({ task, summary: 'step ' + n }), cycle + ':page-' + participant + ':' + n).run();
}

describe('CC8 shared active_work historical paging', () => {
  it('recovers distinct old checkpoints after 76 events without mixing another participant', async () => {
    const { cycle, mine, other } = await seedCycle();
    for (let i = 0; i < 76; i++) await checkpoint(cycle, mine, 'work-' + (i % 13), i);
    await checkpoint(cycle, other, 'private-task', 900);
    const pages = await Promise.all([0, 1, 2].map(checkpointPage =>
      loadActiveWorkPage(db, cycle, [mine], { checkpointPage, pageSize: 5 })));
    const tasks = pages.flatMap(view => view.last_checkpoints.map(c => c.task));
    expect(tasks).toHaveLength(13);
    expect(new Set(tasks).size).toBe(13);
    expect(tasks).not.toContain('private-task');
    expect(pages.map(page => page.next_page.last_checkpoints)).toEqual([1, 2, null]);
    expect(pages[0].last_checkpoints).toEqual((await loadActiveWork(db, cycle, [mine])).last_checkpoints);
  });

  it('preserves the same eight open API runs across two pages and excludes foreign runs', async () => {
    const { cycle, mine, other } = await seedCycle();
    const mineIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = 'cc8-open-' + crypto.randomUUID();
      mineIds.push(id);
      expect((await createRun(db, { runId: id, cycleId: cycle, participantId: mine,
        taskId: 'task-' + i, taskKind: 'answer', prompt: 'continue',
        maxSteps: -1, maxTokens: -1, maxCostCents: 0,
        deadlineAt: 9_999, now: 5_000 + i })).created).toBe(true);
    }
    const hidden = 'cc8-hidden-' + crypto.randomUUID();
    await createRun(db, { runId: hidden, cycleId: cycle, participantId: other,
      taskId: 'private', taskKind: 'answer', prompt: 'private',
      maxSteps: -1, maxTokens: -1, maxCostCents: 0,
      deadlineAt: 9_999, now: 5_100 });
    const first = await loadActiveWorkPage(db, cycle, [mine], { pageSize: 5 });
    const second = await loadActiveWorkPage(db, cycle, [mine], { runPage: 1, pageSize: 5 });
    const ids = [...first.open_api_runs, ...second.open_api_runs].map(r => r.run_id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids)).toEqual(new Set(mineIds));
    expect(ids).not.toContain(hidden);
    expect(first.next_page.open_api_runs).toBe(1);
    expect(second.next_page.open_api_runs).toBeNull();
  });
  it('chat MCP et agent API voient les mêmes checkpoints paginés de leur identité', async () => {
    const { cycle, mine, other } = await seedCycle();
    const taskId = 'shared-' + crypto.randomUUID();
    await db.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid,',
      "status, owned_paths, target_ref, next_action, revision) VALUES (?1, ?2, ?3, ?4,",
      "'cc8-tester', 'in_progress', '[]', '', 'continue', 1)",
    ].join(' ')).bind(taskId, cycle, mine, other).run();
    for (let i = 0; i < 76; i++) await checkpoint(cycle, mine, 'task-' + (i % 13), i);
    await checkpoint(cycle, other, 'private-checkpoint', 800);
    const runId = 'cc8-api-' + crypto.randomUUID();
    expect((await createRun(db, { runId, cycleId: cycle, participantId: mine,
      taskId, taskKind: 'answer', prompt: 'continue from shared memory',
      maxSteps: -1, maxTokens: -1, maxCostCents: 0, deadlineAt: 15_000, now: 10_000 })).created).toBe(true);

    const client = 'cc8-client-' + crypto.randomUUID();
    await registerParticipant(db, { participant_id: mine, display_label: mine,
      proof: OWNER_PROOF, op: 'reg-' + client });
    await mapClient(db, { oauth_client_id: client, participant_id: mine,
      proof: OWNER_PROOF, op: 'map-' + client });
    const chat = await collabToolHandler(db, 'collab_get_context', client);
    const api = createReadToolHost({ db, repository: null, github: null,
      continuity: true, unifiedCapabilities: true });
    const seen: string[] = [];

    for (let page = 0; page < 3; page++) {
      const args = { active_work_checkpoint_page: page, active_work_page_size: 5 };
      const chatResponse = await chat({ cycle, ...args });
      expect(chatResponse.isError, chatResponse.content[0]?.text).toBeFalsy();
      const chatBody = z.object(outputSchemas.collab_get_context).parse(JSON.parse(chatResponse.content[0].text));
      const apiBody = await api.execute({
        id: 'shared-' + page, name: 'store_context', args,
      }, { run_id: runId }) as { active_work: {
        last_checkpoints: Array<{ task: string | null; seq: number }>;
        next_page: { last_checkpoints: number | null };
      } };
      const chatWork = chatBody.active_work!;
      expect(apiBody.active_work.last_checkpoints).toEqual(chatWork.last_checkpoints);
      expect(apiBody.active_work.next_page.last_checkpoints).toBe(chatWork.next_page?.last_checkpoints);
      seen.push(...apiBody.active_work.last_checkpoints.map(row => row.task ?? ''));
    }
    expect(seen).toHaveLength(13);
    expect(new Set(seen).size).toBe(13);
    expect(seen).not.toContain('private-checkpoint');
  });

});
