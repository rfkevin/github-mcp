import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { inspectPhase } from '../../../src/collab-store/phases';
import { validatePhaseDefinition } from '../../../src/collab-store/contracts';
import { StateContractError } from '../../../src/collab/contracts';
import { expectRejected, insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

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
  await insertCycleRow(db, cycle, 'P2');
  await insertPhaseDefinition(db, cycle, 'P2', expectedOutputs);
  for (const task of tasks) {
    await insertTaskRow(db, { taskId: task.task_id, cycle, owner: task.owner, reviewer: task.reviewer, tester: task.tester });
  }
}

async function addEvidence(cycle: string, pid: string, task: string, n: number): Promise<void> {
  await insertEventRow(db, { cycle, type: 'evidence.add', participant: pid, role: 'reviewer',
    payload: { task }, key: 'seed-' + cycle + '-' + n });
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

  it('validatePhaseDefinition : task_id invalide → INVALID_PHASE_OUTPUT_TASK', async () => {
    const base = { cycle_id: uniq('def'), phase: 'P2' as const, entry_conditions: [], exit_conditions: [], auto_advance: 'none' };
    await expectRejected(() => validatePhaseDefinition({ ...base, expected_outputs: [{ role: 'reviewer', kind: 'evidence.add', count: 1, task_id: 'BAD_ID' }] }),
      StateContractError, 'INVALID_PHASE_OUTPUT_TASK', 'task_id invalide');
    expect(validatePhaseDefinition({ ...base, expected_outputs: [{ role: 'reviewer', kind: 'evidence.add', count: 1 }] })
      .expected_outputs).toHaveLength(1);
    expect(validatePhaseDefinition({ ...base, expected_outputs: [{ role: 'reviewer', kind: 'evidence.add', count: 1, task_id: 't1' }] })
      .expected_outputs[0].task_id).toBe('t1');
  });
});
