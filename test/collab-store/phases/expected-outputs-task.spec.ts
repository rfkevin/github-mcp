import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { inspectPhase } from '../../../src/collab-store/phases';
import { validatePhaseDefinition } from '../../../src/collab-store/contracts';
import { StateContractError } from '../../../src/collab/contracts';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-4 A0 (point 5, github-mcp#110) — task_id d'une sortie attendue :
// l'événement doit porter payload.task = task_id ET son auteur tenir le rôle
// attendu sur CETTE tâche. La policy P2 ne devait pas compter n'importe quel
// evidence.add du cycle (constat cc4-design). Sans task_id, la branche legacy
// (le rôle existe sur une tâche du cycle) reste le comportement documenté.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let counter = 0;
const uniq = (label: string) => 'a0eo-' + label + '-' + (++counter);

interface SeededTask {
  task_id: string;
  owner: string;
  reviewer: string;
  tester: string;
}

async function seedCycle(cycle: string, expectedOutputs: unknown, tasks: SeededTask[]): Promise<void> {
  await ensureSchema(db);
  await db.prepare("INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P2', 1, 'open')")
    .bind(cycle).run();
  await db.prepare([
    'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
    "VALUES (?1, 'P2', '[]', ?2, '[]', 'none')",
  ].join(' ')).bind(cycle, JSON.stringify(expectedOutputs)).run();
  for (const task of tasks) {
    await db.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
      "VALUES (?1, ?2, ?3, ?4, ?5, 'in_progress', '[]', '', '', 1)",
    ].join(' ')).bind(task.task_id, cycle, task.owner, task.reviewer, task.tester).run();
  }
}

async function addEvidence(cycle: string, pid: string, task: string, n: number): Promise<void> {
  await ensureSchema(db);
  await db.prepare([
    'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
    "VALUES (?1, 1, 'evidence.add', ?2, '', 'reviewer', ?3, 0, ?4, '')",
  ].join(' ')).bind(cycle, pid, JSON.stringify({ task }), 'seed-' + cycle + '-' + n).run();
}

describe('CC-4 A0 (point 5) — expected_outputs task_id : la sortie compte pour SA tâche', () => {
  it('evidence.add du reviewer de t2 sur t2 ne satisfait pas la sortie attendue de t1', async () => {
    const cycle = uniq('task');
    await seedCycle(cycle, [{ role: 'reviewer', kind: 'evidence.add', count: 1, task_id: 't1' }], [
      { task_id: 't1', owner: 'a0eo-alpha', reviewer: 'a0eo-muse', tester: 'a0eo-tst1' },
      { task_id: 't2', owner: 'a0eo-beta', reviewer: 'a0eo-sol', tester: 'a0eo-tst2' },
    ]);
    await addEvidence(cycle, 'a0eo-sol', 't2', 1); // reviewer de t2, sur t2 : ne compte pas pour t1
    expect((await inspectPhase(db, cycle)).outputsSatisfied).toBe(false);
    await addEvidence(cycle, 'a0eo-muse', 't1', 2); // reviewer de t1, sur t1 : compte
    expect((await inspectPhase(db, cycle)).outputsSatisfied).toBe(true);
  });

  it('sans task_id (legacy documenté) : le rôle suffit, quelle que soit la tâche', async () => {
    const cycle = uniq('legacy');
    await seedCycle(cycle, [{ role: 'reviewer', kind: 'evidence.add', count: 1 }], [
      { task_id: 't2', owner: 'a0eo-beta', reviewer: 'a0eo-sol', tester: 'a0eo-tst2' },
    ]);
    await addEvidence(cycle, 'a0eo-sol', 't2', 1);
    expect((await inspectPhase(db, cycle)).outputsSatisfied).toBe(true);
  });

  it('validatePhaseDefinition : task_id invalide → INVALID_PHASE_OUTPUT_TASK', () => {
    const base = { cycle_id: uniq('def'), phase: 'P2' as const, entry_conditions: [], exit_conditions: [], auto_advance: 'none' };
    try {
      validatePhaseDefinition({ ...base, expected_outputs: [{ role: 'reviewer', kind: 'evidence.add', count: 1, task_id: 'BAD_ID' }] });
      expect.unreachable('task_id invalide doit être refusé');
    } catch (error) {
      expect(error).toBeInstanceOf(StateContractError);
      expect((error as { code: string }).code).toBe('INVALID_PHASE_OUTPUT_TASK');
    }
    expect(validatePhaseDefinition({ ...base, expected_outputs: [{ role: 'reviewer', kind: 'evidence.add', count: 1 }] })
      .expected_outputs).toHaveLength(1);
    expect(validatePhaseDefinition({ ...base, expected_outputs: [{ role: 'reviewer', kind: 'evidence.add', count: 1, task_id: 't1' }] })
      .expected_outputs[0].task_id).toBe('t1');
  });
});
