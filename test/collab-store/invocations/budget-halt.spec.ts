import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import {
  InvocationService, invocationReservationId, runSimulatedInvocation,
} from '../../../src/collab-store/invocations';
import { budgetEnvelope, isAutomationHalted, setAutomationHalt } from '../../../src/collab-store/owner/automation';
import { enqueue, uniqueCycle } from './helpers';

// CC-4 A2 × A1 (revue #115 R3/R4) : l'arrêt d'urgence et l'enveloppe budgétaire
// gardent le démarrage d'une invocation. Base dédiée (COLLAB_DB_C6_RESTORE) : le
// drapeau halt est global à une base et ne doit pas gêner les autres fichiers.
const db = (env as unknown as { COLLAB_DB_C6_RESTORE: D1Database }).COLLAB_DB_C6_RESTORE;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const uniq = (label: string) => `a2i-${label}-${Date.now().toString(36)}-${++n}`;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as { code: string }).code; }
  return 'NO_ERROR';
}

async function scopeWithLimit(limit: number): Promise<string> {
  const scope = uniq('scope').toLowerCase();
  await ensureSchema(db);
  await db.prepare('INSERT INTO budget_envelopes (scope, limit_cents, updated_at) VALUES (?1, ?2, 0)').bind(scope, limit).run();
  return scope;
}

async function attempts(invocationId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM invocation_attempts WHERE invocation_id = ?1')
    .bind(invocationId).first<{ n: number }>();
  return row!.n;
}

async function attemptCosts(invocationId: string): Promise<number[]> {
  const { results } = await db.prepare('SELECT cost_microunits FROM invocation_attempts WHERE invocation_id = ?1 ORDER BY attempt_no')
    .bind(invocationId).all<{ cost_microunits: number }>();
  return results.map(row => row.cost_microunits);
}

async function reservations(invocationId: string) {
  const { results } = await db.prepare(
    // Pas de LIKE : D1 limite un motif LIKE à 50 octets, l'identifiant d'invocation en fait 68.
    'SELECT reservation_id, reserved_cents, actual_cents, status FROM budget_reservations WHERE substr(reservation_id, 1, length(?1)) = ?1 ORDER BY reservation_id',
  ).bind('inv:' + invocationId + ':').all<{ reservation_id: string; reserved_cents: number; actual_cents: number | null; status: string }>();
  return results;
}

afterEach(async () => {
  if (await isAutomationHalted(db)) await setAutomationHalt(db, { halted: false, proof, op: uniq('cleanup') });
});

describe('CC-4 A2 × A1 — arrêt d’urgence sur le démarrage d’une invocation (R3)', () => {
  it('halt posé : lease refusé AUTOMATION_HALTED, attempt_count=0, aucune tentative ni réserve ; levé : le lease passe', async () => {
    const { invocation } = await enqueue(db, uniqueCycle('halt-lease'));
    const service = new InvocationService(db);
    await setAutomationHalt(db, { halted: true, proof, op: uniq('halt') });
    expect(await codeOf(service.lease(invocation.wake_key, 'worker-a', 30))).toBe('AUTOMATION_HALTED');
    expect(await service.getByWakeKey(invocation.wake_key)).toMatchObject({ state: 'queued', attempt_count: 0 });
    expect(await attempts(invocation.invocation_id)).toBe(0);
    expect(await reservations(invocation.invocation_id)).toEqual([]);
    expect(await codeOf(runSimulatedInvocation(service, invocation.wake_key))).toBe('AUTOMATION_HALTED');

    await setAutomationHalt(db, { halted: false, proof, op: uniq('resume') });
    expect((await runSimulatedInvocation(service, invocation.wake_key)).status).toBe('succeeded');
  });

  it('TOCTOU : halt posé après le pré-check, juste avant le lot du lease → lot annulé, rien d’écrit', async () => {
    const { invocation } = await enqueue(db, uniqueCycle('halt-toctou'));
    await ensureSchema(db);
    let armed = false;
    let posed = false;
    // Même base, mais le lot suivant est précédé d'un clic « Arrêt d'urgence ».
    const racing = {
      prepare: (query: string) => db.prepare(query),
      exec: (query: string) => db.exec(query),
      dump: () => db.dump(),
      batch: async (statements: D1PreparedStatement[]) => {
        if (armed && !posed) { posed = true; await setAutomationHalt(db, { halted: true, proof, op: uniq('toctou') }); }
        return db.batch(statements);
      },
    } as unknown as D1Database;
    await ensureSchema(racing);
    armed = true;
    const service = new InvocationService(racing);
    expect(await codeOf(service.lease(invocation.wake_key, 'worker-a', 30))).toBe('AUTOMATION_HALTED');
    expect(posed).toBe(true);
    expect(await new InvocationService(db).getByWakeKey(invocation.wake_key)).toMatchObject({ state: 'queued', attempt_count: 0 });
    expect(await attempts(invocation.invocation_id)).toBe(0);
    expect(await reservations(invocation.invocation_id)).toEqual([]);
  });

  it('halt posé entre le lease et l’exécution : markRunning refusé ; l’expiration d’un bail jamais exécuté solde 0', async () => {
    const { invocation } = await enqueue(db, uniqueCycle('halt-running'));
    const scope = await scopeWithLimit(100);
    let now = 1_900_000_000;
    const service = new InvocationService(db, { now: () => new Date(now * 1000) });
    expect((await service.lease(invocation.wake_key, 'worker-a', 10, { max_cost_cents: 40, scope })).status).toBe('leased');
    await setAutomationHalt(db, { halted: true, proof, op: uniq('halt') });
    expect(await codeOf(service.markRunning(invocation.wake_key, 'worker-a'))).toBe('AUTOMATION_HALTED');
    now += 11;
    expect(await service.reconcileExpired()).toBe(1);
    expect(await reservations(invocation.invocation_id)).toEqual([
      { reservation_id: invocationReservationId(invocation.invocation_id, 1), reserved_cents: 40, actual_cents: 0, status: 'settled' },
    ]);
    expect((await service.getByWakeKey(invocation.wake_key))?.cost_microunits).toBe(0);
    expect(await attemptCosts(invocation.invocation_id)).toEqual([0]);
    expect(await budgetEnvelope(db, scope)).toMatchObject({ reserved_cents: 0, spent_cents: 0, remaining_cents: 100 });
  });
});

describe('CC-4 A2 × A1 — réserve avant exécution, solde après (R4)', () => {
  it('invocation gratuite : réserve 0 dans le lot du lease, solde 0 déterministe à la fin', async () => {
    const { invocation } = await enqueue(db, uniqueCycle('free'));
    const scope = await scopeWithLimit(0);
    const service = new InvocationService(db);
    const run = await runSimulatedInvocation(service, invocation.wake_key, { budget_scope: scope });
    expect(run.status).toBe('succeeded');
    expect(run.invocation.cost_microunits).toBe(0);
    expect(await reservations(invocation.invocation_id)).toEqual([
      { reservation_id: invocationReservationId(invocation.invocation_id, 1), reserved_cents: 0, actual_cents: 0, status: 'settled' },
    ]);
    expect(await budgetEnvelope(db, scope)).toMatchObject({ limit_cents: 0, reserved_cents: 0, spent_cents: 0 });
  });

  it('plafond insuffisant : BUDGET_INSUFFICIENT, aucune tentative ne démarre, rien n’est écrit', async () => {
    const { invocation } = await enqueue(db, uniqueCycle('broke'));
    const scope = await scopeWithLimit(0);
    const service = new InvocationService(db);
    expect(await codeOf(runSimulatedInvocation(service, invocation.wake_key, { budget_scope: scope, max_cost_cents: 5 })))
      .toBe('BUDGET_INSUFFICIENT');
    expect(await service.getByWakeKey(invocation.wake_key)).toMatchObject({ state: 'queued', attempt_count: 0 });
    expect(await attempts(invocation.invocation_id)).toBe(0);
    expect(await reservations(invocation.invocation_id)).toEqual([]);
    expect(await budgetEnvelope(db, scope)).toMatchObject({ reserved_cents: 0, spent_cents: 0 });
  });

  it('dans l’enveloppe : réserve le pire cas, refuse un coût supérieur, solde le coût réel ; réponse perdue → aucune double dépense', async () => {
    const { invocation } = await enqueue(db, uniqueCycle('paid'));
    const scope = await scopeWithLimit(100);
    const service = new InvocationService(db);
    expect((await service.lease(invocation.wake_key, 'worker-a', 60, { max_cost_cents: 40, scope })).status).toBe('leased');
    expect(await budgetEnvelope(db, scope)).toMatchObject({ reserved_cents: 40, remaining_cents: 60 });
    await service.markRunning(invocation.wake_key, 'worker-a');
    expect(await codeOf(service.succeed(invocation.wake_key, 'worker-a', 'out', {}, [], 41))).toBe('BUDGET_OVERRUN');
    const done = await service.succeed(invocation.wake_key, 'worker-a', 'out', {}, [], 25);
    expect(done).toMatchObject({ state: 'succeeded', cost_microunits: 250_000 });
    expect(await budgetEnvelope(db, scope)).toMatchObject({ reserved_cents: 0, spent_cents: 25, remaining_cents: 75 });

    // Réponse perdue puis rejeu de l'exécuteur : relecture D1, terminal, aucune nouvelle réserve.
    expect((await runSimulatedInvocation(service, invocation.wake_key, { budget_scope: scope, max_cost_cents: 40 })).status).toBe('terminal');
    expect(await codeOf(service.succeed(invocation.wake_key, 'worker-a', 'out', {}, [], 25))).toBe('INVOCATION_LEASE_LOST');
    expect(await reservations(invocation.invocation_id)).toHaveLength(1);
    expect(await budgetEnvelope(db, scope)).toMatchObject({ reserved_cents: 0, spent_cents: 25 });
  });

  it('bail expiré pendant l’exécution : le pire cas réservé est compté ; la reprise réserve à nouveau, une réserve par tentative', async () => {
    const { invocation } = await enqueue(db, uniqueCycle('expired-paid'));
    const scope = await scopeWithLimit(100);
    let now = 1_900_100_000;
    const service = new InvocationService(db, { now: () => new Date(now * 1000) });
    await service.lease(invocation.wake_key, 'worker-a', 10, { max_cost_cents: 30, scope });
    await service.markRunning(invocation.wake_key, 'worker-a');
    now += 11;
    expect(await service.reconcileExpired()).toBe(1);
    expect(await budgetEnvelope(db, scope)).toMatchObject({ reserved_cents: 0, spent_cents: 30, remaining_cents: 70 });
    // Revue #115 R5 : le ledger A1 porte le même coût que le budget.
    expect((await service.getByWakeKey(invocation.wake_key))?.cost_microunits).toBe(300_000);
    expect(await attemptCosts(invocation.invocation_id)).toEqual([300_000]);

    expect((await service.lease(invocation.wake_key, 'worker-b', 10, { max_cost_cents: 30, scope })).status).toBe('leased');
    await service.markRunning(invocation.wake_key, 'worker-b');
    await service.succeed(invocation.wake_key, 'worker-b', 'ok', {}, [], 10);
    expect((await reservations(invocation.invocation_id)).map(r => [r.reserved_cents, r.actual_cents, r.status])).toEqual([
      [30, 30, 'settled'], [30, 10, 'settled'],
    ]);
    expect(await budgetEnvelope(db, scope)).toMatchObject({ reserved_cents: 0, spent_cents: 40, remaining_cents: 60 });
    expect((await service.getByWakeKey(invocation.wake_key))?.cost_microunits).toBe(400_000);
    expect(await attemptCosts(invocation.invocation_id)).toEqual([300_000, 100_000]);
  });

  it('halt + budget insuffisant ensemble : le halt prime, rien n’est écrit', async () => {
    const { invocation } = await enqueue(db, uniqueCycle('both'));
    const scope = await scopeWithLimit(0);
    const service = new InvocationService(db);
    await setAutomationHalt(db, { halted: true, proof, op: uniq('halt') });
    expect(await codeOf(service.lease(invocation.wake_key, 'worker-a', 30, { max_cost_cents: 5, scope }))).toBe('AUTOMATION_HALTED');
    expect(await service.getByWakeKey(invocation.wake_key)).toMatchObject({ state: 'queued', attempt_count: 0 });
    expect(await reservations(invocation.invocation_id)).toEqual([]);
  });
});
