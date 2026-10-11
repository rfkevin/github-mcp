import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { resolveContextTarget } from '../../../src/collab-store/context';
import { insertCycleRow, insertTaskRow } from '../a0-helpers';

// CC-4 A0 (point 3, github-mcp#110) — découverte du cycle pour une reprise
// générique (« Collaboration 3, reprends », défaut constaté au trial C7) :
// sans issue ni cycle explicites, le participant doit tenir un rôle dans
// exactement UN cycle ouvert (ou dans la tâche nommée) ; sinon l'échec est
// explicite — jamais un choix implicite. Pids uniques : la base de test est
// partagée par toutes les specs du dossier.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let counter = 0;
const uniq = (label: string) => 'a0d-' + label + '-' + (++counter);

async function seedCycleWithTask(cycle: string, pid: string, taskId: string, status = 'open'): Promise<void> {
  await insertCycleRow(db, cycle, 'P1', status);
  await insertTaskRow(db, { taskId, cycle, owner: pid, reviewer: 'a0d-reviewer', tester: 'a0d-tester' });
}

describe('CC-4 A0 (point 3) — découverte du cycle quand ni issue ni cycle fournis', () => {
  it('exactement un cycle ouvert où le participant tient un rôle : résolu', async () => {
    const pid = uniq('pid');
    const cycle = uniq('only');
    await seedCycleWithTask(cycle, pid, 't1');
    const resolved = await resolveContextTarget(db, { participant_id: pid });
    expect(resolved.cycle_id).toBe(cycle);
    expect(resolved.task).toMatchObject({ task_id: 't1', participation: 'owner' });
  });

  it('deux cycles ouverts avec un rôle : AMBIGUOUS_CYCLE, la liste est dans le message', async () => {
    const pid = uniq('pid');
    const first = uniq('amb1');
    const second = uniq('amb2');
    await seedCycleWithTask(first, pid, 't1');
    await seedCycleWithTask(second, pid, 't1');
    try {
      await resolveContextTarget(db, { participant_id: pid });
      expect.unreachable('deux cycles ouverts doivent être refusés');
    } catch (error) {
      expect((error as { code: string }).code).toBe('AMBIGUOUS_CYCLE');
      expect((error as Error).message).toContain(first);
      expect((error as Error).message).toContain(second);
    }
  });

  it('filtre task : la tâche nommée sélectionne son cycle', async () => {
    const pid = uniq('pid');
    const first = uniq('f1');
    const second = uniq('f2');
    await seedCycleWithTask(first, pid, 'ta');
    await seedCycleWithTask(second, pid, 'tb');
    const resolved = await resolveContextTarget(db, { participant_id: pid, task: 'ta' });
    expect(resolved.cycle_id).toBe(first);
    expect(resolved.task).toMatchObject({ task_id: 'ta' });
  });

  it('aucun rôle dans aucun cycle : NO_ACTIVE_CYCLE', async () => {
    const pid = uniq('nobody');
    await expect(resolveContextTarget(db, { participant_id: pid }))
      .rejects.toMatchObject({ code: 'NO_ACTIVE_CYCLE' });
  });

  it('cycle fermé (status closed) : NO_ACTIVE_CYCLE, jamais un choix implicite', async () => {
    const pid = uniq('pid');
    const cycle = uniq('closed');
    await seedCycleWithTask(cycle, pid, 't1', 'closed');
    await expect(resolveContextTarget(db, { participant_id: pid }))
      .rejects.toMatchObject({ code: 'NO_ACTIVE_CYCLE' });
  });
});
