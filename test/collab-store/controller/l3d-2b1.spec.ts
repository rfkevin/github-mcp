import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  REMINDER_INTERVAL_S, REMINDER_MAX, readDecisions, reminderBucket, runController, runScheduledControllers, scheduledResearchPassId,
} from '../../../src/collab-store/controller';
import { researchPass } from '../../../src/collab-store/research';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

// CC-5 L3d (incrément 2b-1) — rappels bornés des décisions restées sans suite,
// passage quotidien du chercheur L5 depuis le passage programmé.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let counter = 0;
const uniq = (label: string) => '0000-l3d2b1-' + label + '-' + (++counter);
const T0 = Date.UTC(2031, 0, 1, 0, 0, 0);
const at = (hours: number) => () => new Date(T0 + hours * 3600 * 1000);

async function seed(cycle: string): Promise<void> {
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: 'l0', cycle, owner: 'r-vibe', reviewer: 'r-gpt', tester: 'r-claude' });
}

async function setHalt(on: boolean): Promise<void> {
  await ensureSchema(db);
  await db.prepare("INSERT INTO owner_flags (name, value, event_seq, updated_at) VALUES ('halt', ?1, 0, 0) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
    .bind(on ? '1' : '0').run();
}

describe('CC-5 L3d 2b-1 — tranche de rappel (pure)', () => {
  it('0 avant la première tranche, puis 1..REMINDER_MAX, plafonnée', () => {
    expect(REMINDER_INTERVAL_S).toBe(6 * 3600);
    expect(reminderBucket(1000, 1000)).toBe(0);
    expect(reminderBucket(1000, 1000 + REMINDER_INTERVAL_S - 1)).toBe(0);
    expect(reminderBucket(1000, 1000 + REMINDER_INTERVAL_S)).toBe(1);
    expect(reminderBucket(1000, 1000 + 2 * REMINDER_INTERVAL_S + 5)).toBe(2);
    expect(reminderBucket(1000, 1000 + 100 * REMINDER_INTERVAL_S)).toBe(REMINDER_MAX);
    expect(reminderBucket(1000, 0)).toBe(0); // horloge en arrière : jamais négatif
  });
});

describe('CC-5 L3d 2b-1 — rappels journalisés (D1)', () => {
  it('une ligne par tranche, au plus REMINDER_MAX, puis silence', async () => {
    const cycle = uniq('remind');
    await seed(cycle);
    expect(await runController(db, cycle, { now: at(0) })).toMatchObject({ mode: 'active', recorded: 1, reminded: 0 });
    expect(await runController(db, cycle, { now: at(5) })).toMatchObject({ recorded: 0, reminded: 0 });
    expect(await runController(db, cycle, { now: at(6) })).toMatchObject({ recorded: 0, reminded: 1 });
    expect(await runController(db, cycle, { now: at(7) })).toMatchObject({ reminded: 0 }); // même tranche : idempotent
    expect(await runController(db, cycle, { now: at(12) })).toMatchObject({ reminded: 1 });
    expect(await runController(db, cycle, { now: at(40) })).toMatchObject({ reminded: 1 }); // saut : tranche plafonnée à 3
    expect(await runController(db, cycle, { now: at(500) })).toMatchObject({ reminded: 0 });
    const rows = await readDecisions(db, cycle);
    expect(rows.map(r => r.rule)).toEqual([rows[0].rule, 'reminder', 'reminder', 'reminder']);
    expect(rows.filter(r => r.rule === 'reminder')).toHaveLength(REMINDER_MAX);
    expect(rows[1]).toMatchObject({ kind: rows[0].kind, actor: 'r-vibe', action: rows[0].action, task_id: 'l0' });
    expect(rows.map(r => r.reason.slice(0, 9))).toEqual([rows[0].reason.slice(0, 9), 'Rappel 1/', 'Rappel 2/', 'Rappel 3/']);
  });

  it('HALT posé entre l\'instantané et l\'écriture : aucun rappel journalisé', async () => {
    const cycle = uniq('remind-halt');
    await seed(cycle);
    await runController(db, cycle, { now: at(0) });
    try {
      expect(await runController(db, cycle, { now: at(6), afterSnapshot: () => setHalt(true) }))
        .toMatchObject({ mode: 'halted', recorded: 0 });
      expect(await readDecisions(db, cycle)).toHaveLength(1);
    } finally {
      await setHalt(false);
    }
    expect(await runController(db, cycle, { now: at(6) })).toMatchObject({ reminded: 1 });
  });

  it('HALT avant le passage : ni décision ni rappel', async () => {
    const cycle = uniq('remind-halt2');
    await seed(cycle);
    await runController(db, cycle, { now: at(0) });
    await setHalt(true);
    try {
      expect(await runController(db, cycle, { now: at(30) })).toMatchObject({ mode: 'halted' });
    } finally {
      await setHalt(false);
    }
    expect(await readDecisions(db, cycle)).toHaveLength(1);
  });
});

describe('CC-5 L3d 2b-1 — chercheur L5 depuis le passage programmé', () => {
  it('identifiant quotidien UTC déterministe', () => {
    expect(scheduledResearchPassId(new Date(Date.UTC(2031, 4, 9, 23, 59)))).toBe('rp-daily-2031-05-09');
  });

  it('un passage par jour : recorded, puis duplicate le même jour, recorded le lendemain', async () => {
    const day = (d: number) => () => new Date(Date.UTC(2032, 2, d, 12));
    const first = await runScheduledControllers(db, { now: day(1) });
    expect(first.research).toEqual({ pass_id: 'rp-daily-2032-03-01', status: 'recorded' });
    expect((await runScheduledControllers(db, { now: day(1) })).research.status).toBe('duplicate');
    expect((await runScheduledControllers(db, { now: day(2) })).research).toEqual({ pass_id: 'rp-daily-2032-03-02', status: 'recorded' });
    expect(await researchPass(db, 'rp-daily-2032-03-01')).toMatchObject({ pass_id: 'rp-daily-2032-03-01', cycle_id: null });
  });

  it('HALT : le chercheur n\'écrit pas (halted), les cycles non plus', async () => {
    const cycle = uniq('sched-halt');
    await seed(cycle);
    await setHalt(true);
    try {
      const result = await runScheduledControllers(db, { now: () => new Date(Date.UTC(2033, 0, 1)) });
      expect(result.research).toEqual({ pass_id: 'rp-daily-2033-01-01', status: 'halted' });
      expect(result.cycles.find(c => c.cycle_id === cycle)).toMatchObject({ mode: 'halted', recorded: 0 });
    } finally {
      await setHalt(false);
    }
    // Un passage halted n'est pas consommé : le même jour, le passage reprend.
    expect((await runScheduledControllers(db, { now: () => new Date(Date.UTC(2033, 0, 1)) })).research.status).toBe('recorded');
  });

  it('échec du chercheur isolé : les cycles sont traités, statut failed', async () => {
    const cycle = uniq('sched-fail');
    await seed(cycle);
    const broken = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (/research_/.test(sql)) throw new Error('boom');
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await runScheduledControllers(broken, { now: () => new Date(Date.UTC(2034, 0, 1)) });
    expect(result.research.status).toBe('failed');
    expect(result.cycles.find(c => c.cycle_id === cycle)).toMatchObject({ mode: 'active', recorded: 1 });
  });
});
