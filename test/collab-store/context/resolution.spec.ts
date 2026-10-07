import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureContextSchema, mapIssueToCycle, resolveContextTarget } from '../../../src/collab-store/context';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;
const uniq = (label: string) => 'c3r-' + label + '-' + (++n);

async function setup() {
  await ensureContextSchema(db);
  const cycle = uniq('cycle');
  await db.prepare("INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P5', 1, 'open')").bind(cycle).run();
  await mapIssueToCycle(db, 'issue 24', cycle);
  await db.prepare([
    'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
    "VALUES ('c3', ?1, 'sol', 'muse', 'vibe', 'in_progress', '[]', 'ref-c3', 'implement', 1)",
  ].join(' ')).bind(cycle).run();
  await db.prepare([
    'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
    "VALUES ('c4', ?1, 'grok', 'sol', 'claude', 'proposed', '[]', 'ref-c4', 'wait', 1)",
  ].join(' ')).bind(cycle).run();
  return cycle;
}

describe('CC-3 C3 — issue -> cycle -> participant -> task', () => {
  it('la seule instruction issue 24 résout une tâche différente pour deux participants', async () => {
    const cycle = await setup();
    const sol = await resolveContextTarget(db, { issue: 'issue 24', participant_id: 'muse' });
    const vibe = await resolveContextTarget(db, { issue: '#24', participant_id: 'vibe' });
    expect(sol.cycle_id).toBe(cycle);
    expect(sol.task).toMatchObject({ task_id: 'c3', participation: 'reviewer' });
    expect(vibe.task).toMatchObject({ task_id: 'c3', participation: 'tester' });
  });

  it('échoue fermé sur ambiguïté', async () => {
    const cycle = await setup();
    await db.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
      "VALUES ('c6', ?1, 'muse', 'claude', 'vibe', 'proposed', '[]', '', '', 1)",
    ].join(' ')).bind(cycle).run();
    await expect(resolveContextTarget(db, { issue: '24', participant_id: 'vibe' }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS_TASK' });
  });
});
