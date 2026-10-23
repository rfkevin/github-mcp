import { describe, expect, it } from 'vitest';
import { advanceGuarded } from '../../../src/collab-store/phases/gate';
import { closeCycle } from '../../../src/collab-store/owner/close';
import { installPhaseDefinitions } from '../../../src/collab-store/owner/phase-install';
import { db, proof, uniq, codeOf, refusalOf, countEvents } from '../owner/owner-act-helpers';

// CC-Owner V2 L5 (contre-revue Claude seq 671) — bloquant : l’avance de phase par
// policy n’emprunte pas appendEvent ; elle doit refuser CYCLE_CLOSED comme les
// appends (L1) : garde CYCLE_OPEN_GUARD dans le lot CAS, rejeu d’une avance
// déposée avant la clôture toujours duplicate, STALE puis CYCLE_CLOSED pour une
// écriture en vol.

/** P1 avec policy « pp », P2 définie : la cible d’avance minimale. */
const DEFINITIONS = JSON.stringify([{ phase: 'P1', auto_advance: 'pp' }, { phase: 'P2' }]);

async function install(cycle: string): Promise<void> {
  expect((await installPhaseDefinitions(db, { cycle_id: cycle, definitions: DEFINITIONS, proof })).status).toBe('applied');
}

async function cycleOf(cycle: string): Promise<{ phase: string; revision: number; status: string }> {
  const row = await db.prepare('SELECT phase, revision, status FROM cycles WHERE cycle_id = ?1')
    .bind(cycle).first<{ phase: string; revision: number; status: string }>();
  expect(row).toBeTruthy();
  return row!;
}

async function countPhaseAdvances(cycle: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'phase.advance'")
    .bind(cycle).first<{ n: number }>())?.n ?? 0;
}

const advance = (cycle: string, expectedRevision: number) =>
  advanceGuarded(db, { cycle_id: cycle, expected_revision: expectedRevision, next_phase: 'P2', conditionsSatisfied: () => true });

describe('CC-Owner V2 — L5 : un cycle clos ne peut plus avancer de phase', () => {
  it('avance après clôture : CYCLE_CLOSED, aucune écriture, phase et révision inchangées', async () => {
    const cycle = uniq('cyc');
    await install(cycle);
    expect((await closeCycle(db, { cycle_id: cycle, proof, op: 'close-1' })).status).toBe('applied');
    const before = await cycleOf(cycle);
    expect(before).toMatchObject({ phase: 'P1', status: 'closed' });
    const refusal = await refusalOf(advance(cycle, before.revision));
    expect(refusal.code).toBe('CYCLE_CLOSED');
    expect(await cycleOf(cycle)).toEqual(before);
    expect(await countEvents(cycle)).toBe(2); // install_phases + close_cycle, aucun phase.advance
    expect(await countPhaseAdvances(cycle)).toBe(0);
  });

  it('le rejeu d’une avance déposée avant la clôture reste duplicate, sans écriture', async () => {
    const cycle = uniq('cyc');
    await install(cycle);
    expect((await advance(cycle, 1)).status).toBe('applied');
    expect((await cycleOf(cycle)).phase).toBe('P2');
    expect((await closeCycle(db, { cycle_id: cycle, proof, op: 'close-1' })).status).toBe('applied');
    const events = await countEvents(cycle);
    expect((await advance(cycle, 1)).status).toBe('duplicate');
    expect(await countEvents(cycle)).toBe(events);
    expect((await cycleOf(cycle)).phase).toBe('P2');
  });

  it('révision périmée après clôture : STALE d’abord, puis CYCLE_CLOSED au nouvel essai, rien d’écrit', async () => {
    const cycle = uniq('cyc');
    await install(cycle);
    expect((await closeCycle(db, { cycle_id: cycle, proof, op: 'close-1' })).status).toBe('applied');
    expect(codeOf(await refusalOf(advance(cycle, 1)))).toBe('STALE');
    const fresh = await cycleOf(cycle);
    expect(codeOf(await refusalOf(advance(cycle, fresh.revision)))).toBe('CYCLE_CLOSED');
    expect(await cycleOf(cycle)).toEqual(fresh);
    expect(await countEvents(cycle)).toBe(2);
    expect(await countPhaseAdvances(cycle)).toBe(0);
  });
});
