import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import {
  budgetEnvelope, isAutomationHalted, reserveBudget, setAutomationHalt, settleBudget,
} from '../../../src/collab-store/owner/automation';
import { advanceGuarded } from '../../../src/collab-store/phases/gate';
import { installPhaseDefinitions } from '../../../src/collab-store/owner/phase-install';

// CC-4 A2 (github-mcp#113, plan §6.5/§7) — arrêt d'urgence et enveloppe budgétaire.
// Base dédiée (COLLAB_DB_C6_RESTORE) : le drapeau halt est global à une base, il ne
// doit pas interférer avec les avances de phase des autres fichiers de test.
const db = (env as unknown as { COLLAB_DB_C6_RESTORE: D1Database }).COLLAB_DB_C6_RESTORE;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const uniq = (label: string) => `a2h-${label}-${Date.now().toString(36)}-${++n}`;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as { code: string }).code; }
  return 'NO_ERROR';
}

afterEach(async () => {
  if (await isAutomationHalted(db)) await setAutomationHalt(db, { halted: false, proof, op: uniq('cleanup') });
});

describe('CC-4 A2 — arrêt d’urgence', () => {
  it('posé : l’avance de phase par policy et toute réservation sont refusées, l’état est conservé ; levé : tout reprend', async () => {
    const cycle = uniq('cycle');
    await installPhaseDefinitions(db, { cycle_id: cycle, definitions: JSON.stringify([{ phase: 'P1', auto_advance: 'a2-halt' }, { phase: 'P2' }]), proof });
    const revision = async () => (await db.prepare('SELECT revision, phase FROM cycles WHERE cycle_id = ?1').bind(cycle)
      .first<{ revision: number; phase: string }>())!;
    const before = await revision();

    const halted = await setAutomationHalt(db, { halted: true, proof, op: uniq('halt') });
    expect(JSON.parse(halted.event.payload_json)).toMatchObject({ action: 'halt_automation', proof_kind: 'secret' });
    expect(await isAutomationHalted(db)).toBe(true);
    expect(await codeOf(advanceGuarded(db, { cycle_id: cycle, expected_revision: before.revision, next_phase: 'P2' }))).toBe('AUTOMATION_HALTED');
    expect(await codeOf(reserveBudget(db, { reservation_id: uniq('inv'), cents: 0 }))).toBe('AUTOMATION_HALTED');
    expect(await revision()).toEqual(before);

    await setAutomationHalt(db, { halted: false, proof, op: uniq('resume') });
    expect(await isAutomationHalted(db)).toBe(false);
    const advanced = await advanceGuarded(db, { cycle_id: cycle, expected_revision: before.revision, next_phase: 'P2' });
    expect(advanced.status).toBe('applied');
  });

  it('TOCTOU (revue #115 R1) : halt posé après le pré-check mais avant le lot → lot annulé, aucune phase.advance', async () => {
    const cycle = uniq('toctou');
    await installPhaseDefinitions(db, { cycle_id: cycle, definitions: JSON.stringify([{ phase: 'P1', auto_advance: 'a2-toctou' }, { phase: 'P2' }]), proof });
    const before = (await db.prepare('SELECT revision, phase FROM cycles WHERE cycle_id = ?1').bind(cycle)
      .first<{ revision: number; phase: string }>())!;
    let posed = false;
    // Le hook de conditions s'exécute après assertAutomationRunning et avant le batch d'advanceByPolicy.
    const conditionsSatisfied = async () => {
      if (!posed) { posed = true; await setAutomationHalt(db, { halted: true, proof, op: uniq('toctou-halt') }); }
      return true;
    };
    expect(await codeOf(advanceGuarded(db, { cycle_id: cycle, expected_revision: before.revision, next_phase: 'P2', conditionsSatisfied })))
      .toBe('AUTOMATION_HALTED');
    expect(posed).toBe(true);
    expect(await db.prepare('SELECT revision, phase FROM cycles WHERE cycle_id = ?1').bind(cycle).first()).toEqual(before);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'phase.advance'").bind(cycle)
      .first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe('CC-4 A2 — enveloppe budgétaire (0 € par défaut, fail-closed)', () => {
  it('sans enveloppe approuvée : une réserve nulle passe, toute réserve positive est refusée sans écriture', async () => {
    const scope = uniq('scope');
    expect(await budgetEnvelope(db, scope)).toMatchObject({ limit_cents: 0, reserved_cents: 0, spent_cents: 0, remaining_cents: 0 });
    expect((await reserveBudget(db, { reservation_id: uniq('free'), cents: 0, scope })).status).toBe('reserved');
    const paid = uniq('paid');
    expect(await codeOf(reserveBudget(db, { reservation_id: paid, cents: 1, scope }))).toBe('BUDGET_INSUFFICIENT');
    await ensureSchema(db);
    expect(await db.prepare('SELECT 1 FROM budget_reservations WHERE reservation_id = ?1').bind(paid).first()).toBeNull();
  });

  it('réserve avant l’appel, solde après : plafond respecté, idempotent, dépassement refusé', async () => {
    const scope = uniq('scope');
    await ensureSchema(db);
    // Plafond posé directement en base pour le test : aucun chemin agent n'écrit limit_cents (relevé = acte owner, lot ultérieur).
    await db.prepare('INSERT INTO budget_envelopes (scope, limit_cents, updated_at) VALUES (?1, 100, 0)').bind(scope).run();
    const first = uniq('inv');
    expect((await reserveBudget(db, { reservation_id: first, cents: 60, scope })).envelope).toMatchObject({ reserved_cents: 60, remaining_cents: 40 });
    expect((await reserveBudget(db, { reservation_id: first, cents: 60, scope })).status).toBe('duplicate');
    expect(await codeOf(reserveBudget(db, { reservation_id: first, cents: 10, scope }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(await codeOf(reserveBudget(db, { reservation_id: uniq('inv'), cents: 50, scope }))).toBe('BUDGET_INSUFFICIENT');
    expect(await codeOf(settleBudget(db, { reservation_id: first, actual_cents: 61 }))).toBe('BUDGET_OVERRUN');
    const settled = await settleBudget(db, { reservation_id: first, actual_cents: 40 });
    expect(settled).toMatchObject({ status: 'settled', envelope: { reserved_cents: 0, spent_cents: 40, remaining_cents: 60 } });
    expect((await settleBudget(db, { reservation_id: first, actual_cents: 40 })).status).toBe('duplicate');
    expect(await codeOf(settleBudget(db, { reservation_id: first, actual_cents: 30 }))).toBe('IDEMPOTENCY_CONFLICT');
    expect((await reserveBudget(db, { reservation_id: uniq('inv'), cents: 60, scope })).envelope.remaining_cents).toBe(0);
  });

  it('livraisons concurrentes (revue #115 R2) : même id → reserved + duplicate ; même id, autre montant → IDEMPOTENCY_CONFLICT', async () => {
    const scope = uniq('scope');
    await ensureSchema(db);
    await db.prepare('INSERT INTO budget_envelopes (scope, limit_cents, updated_at) VALUES (?1, 100, 0)').bind(scope).run();
    const same = uniq('same');
    const pair = await Promise.all([
      reserveBudget(db, { reservation_id: same, cents: 30, scope }),
      reserveBudget(db, { reservation_id: same, cents: 30, scope }),
    ]);
    expect(pair.map(r => r.status).sort()).toEqual(['duplicate', 'reserved']);
    expect(await budgetEnvelope(db, scope)).toMatchObject({ reserved_cents: 30, remaining_cents: 70 });

    const clash = uniq('clash');
    const settled = await Promise.allSettled([
      reserveBudget(db, { reservation_id: clash, cents: 10, scope }),
      reserveBudget(db, { reservation_id: clash, cents: 20, scope }),
    ]);
    expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.map(r => (r.reason as { code: string }).code)).toEqual(['IDEMPOTENCY_CONFLICT']);
    const row = await db.prepare('SELECT reserved_cents FROM budget_reservations WHERE reservation_id = ?1').bind(clash)
      .first<{ reserved_cents: number }>();
    expect((await budgetEnvelope(db, scope)).reserved_cents).toBe(30 + row!.reserved_cents);
  });
});
