import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { adjustPhase, SOFT_OPS_PER_CYCLE_MAX, type SoftPhaseInput } from '../../../src/collab-store/phases/soft';
import { advanceGuarded } from '../../../src/collab-store/phases/gate';
import { inspectPhase } from '../../../src/collab-store/phases/engine';
import { phaseEntrySeq } from '../../../src/collab-store/phases/entry-seq';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { appointCycleCoordinator } from '../../../src/collab-store/owner/delegation-execution';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { countEvents, countSealed, insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow, makeDatedStore } from '../a0-helpers';

// CC-5 l3d (incrément 2c-1) — phases souples B1 (round.add, phase.reopen, phase.skip) par le coordinateur mandaté.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const uniq = (label: string) => (label + '-' + (++n) + '-' + Date.now().toString(36)).slice(0, 48);
const PHASES = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as { code?: string }).code ?? 'UNKNOWN'; }
  return 'NO_ERROR';
}

interface World { cycle: string; holder: string; twin: string; other: string; epoch: number; rev: number }

/** Cycle à la phase donnée, définitions P1-P6 neutres, coordinateur `holder` mandaté (twin = même famille). */
async function world(phase = 'P3'): Promise<World> {
  await ensureSchema(db);
  const tag = uniq('w');
  const [holder, twin, other] = ['sh', 'st', 'so'].map(p => p + '-' + tag);
  for (const pid of [holder, twin, other]) await registerParticipant(db, { participant_id: pid, display_label: pid, proof, op: uniq('reg') });
  const family = 'fam-' + tag;
  for (const pid of [holder, twin]) {
    await db.prepare('INSERT INTO participant_identity_families (participant_id, family_id, event_seq, updated_at) VALUES (?1, ?2, NULL, 1)')
      .bind(pid, family).run();
  }
  const cycle = uniq('soft');
  await insertCycleRow(db, cycle, phase);
  for (const p of PHASES) await insertPhaseDefinition(db, cycle, p, []);
  await insertTaskRow(db, { taskId: 't0', cycle, owner: holder, reviewer: other, tester: 'x-' + tag });
  await appointCycleCoordinator(db, { cycleId: cycle, participantId: holder, familyId: family, expectedEpoch: 0, proof, op: uniq('appoint') });
  // La nomination (acte owner) fait avancer la révision du cycle : les tests partent de la révision réelle.
  return { cycle, holder, twin, other, epoch: 1, rev: (await cycleRow(cycle)).revision };
}

async function cycleRow(cycle: string) {
  return (await db.prepare('SELECT phase, revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ phase: string; revision: number }>())!;
}

let opN = 0;
function input(w: World, extra: Partial<SoftPhaseInput> & Pick<SoftPhaseInput, 'op'>, who = w.holder): SoftPhaseInput {
  return { cycle_id: w.cycle, participant_id: who, expected_revision: w.rev, reason: 'Pas de consensus au premier tour.',
    op_id: who + ':' + w.cycle + ':soft:' + (++opN), ...extra };
}

describe('CC-5 l3d 2c-1 — phases souples B1', () => {
  it('round.add : nouveau tour de la phase courante, journalisé, sorties remises à zéro, scellés de la ronde révélés', async () => {
    const w = await world('P2');
    await db.prepare("UPDATE phase_definitions SET expected_outputs = ?2 WHERE cycle_id = ?1 AND phase = 'P2'")
      .bind(w.cycle, JSON.stringify([{ role: 'author', kind: 'evidence.add', count: 1 }])).run();
    await insertEventRow(db, { cycle: w.cycle, type: 'evidence.add', participant: w.holder, role: 'author', payload: {}, key: uniq('ev') });
    await db.prepare("INSERT INTO sealed_items (id, cycle_id, phase, participant_id, content_hash, content, revealed_at) VALUES (?1, ?2, 'P2', ?3, 'h', 'c', NULL)")
      .bind(uniq('seal'), w.cycle, w.other).run();
    expect((await inspectPhase(db, w.cycle)).outputsSatisfied).toBe(true);
    const out = await adjustPhase(db, input(w, { op: 'round.add' }));
    expect(out).toMatchObject({ status: 'applied', revision: w.rev + 1, op: 'round.add', from: 'P2', to: 'P2' });
    expect(await cycleRow(w.cycle)).toEqual({ phase: 'P2', revision: w.rev + 1 });
    const event = (await db.prepare('SELECT participant_id, role, payload_json FROM events WHERE seq = ?1').bind(out.event_seq).first<{ participant_id: string; role: string; payload_json: string }>())!;
    expect(event).toMatchObject({ participant_id: w.holder, role: 'coordinator' });
    expect(JSON.parse(event.payload_json)).toMatchObject({ op: 'round.add', from: 'P2', to: 'P2', reason: 'Pas de consensus au premier tour.', mandate_epoch: 1, extra_rounds: 1 });
    expect(await phaseEntrySeq(db, w.cycle, 'P2')).toBe(out.event_seq);
    expect((await inspectPhase(db, w.cycle)).outputsSatisfied).toBe(false); // le tour repart de zéro
    const unrevealed = await db.prepare('SELECT COUNT(*) AS n FROM sealed_items WHERE cycle_id = ?1 AND revealed_at IS NULL').bind(w.cycle).first<{ n: number }>();
    expect(unrevealed!.n).toBe(0);
  });

  it('round.add sur un tour scellé : le même participant peut proposer à nouveau (garde « une proposition par ronde »)', async () => {
    const w = await world('P1');
    const store = makeDatedStore(db);
    const propose = (rev: number, k: number) => store.appendEvent({ cycle_id: w.cycle, type: 'proposal.submit', participant_id: w.other,
      expected_rev: rev, payload_json: JSON.stringify({ content: 'plan-' + k }), op_id: w.other + ':' + w.cycle + ':prop:' + k });
    expect((await propose(w.rev, 1)).status).toBe('applied');
    expect(await codeOf(propose(w.rev + 1, 2))).toBe('PROPOSAL_ALREADY_SUBMITTED');
    await adjustPhase(db, input(w, { op: 'round.add', expected_revision: w.rev + 1 }));
    expect((await propose(w.rev + 2, 3)).status).toBe('applied');
    expect(await countSealed(db, w.cycle)).toBe(2);
  });

  it('rejeu : même op_id → duplicate sans seconde écriture ; même op_id, raison différente → IDEMPOTENCY_CONFLICT', async () => {
    const w = await world();
    const first = input(w, { op: 'round.add' });
    const a = await adjustPhase(db, first);
    expect(await adjustPhase(db, first)).toMatchObject({ status: 'duplicate', event_seq: a.event_seq, revision: w.rev + 1 });
    expect(await codeOf(adjustPhase(db, { ...first, reason: 'Autre justification du tour.' }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(await countEvents(db, w.cycle, 'phase.advance')).toBe(1);
  });

  it('seul le titulaire logique du mandat agit ; un autre participant, ou après révocation → SOFT_PHASE_FORBIDDEN, rien écrit', async () => {
    const w = await world();
    expect(await codeOf(adjustPhase(db, input(w, { op: 'round.add' }, w.other)))).toBe('SOFT_PHASE_FORBIDDEN');
    expect(await cycleRow(w.cycle)).toEqual({ phase: 'P3', revision: w.rev });
    // Même famille logique (#126) : même principal, donc autorisé.
    expect((await adjustPhase(db, input(w, { op: 'round.add' }, w.twin))).status).toBe('applied');
    await appointCycleCoordinator(db, { cycleId: w.cycle, participantId: null, familyId: null, expectedEpoch: 1, proof, op: uniq('vacancy') });
    expect(await codeOf(adjustPhase(db, input(w, { op: 'round.add', expected_revision: w.rev + 1 })))).toBe('SOFT_PHASE_FORBIDDEN');
    expect(await countEvents(db, w.cycle, 'phase.advance')).toBe(1);
  });

  it('au plus 3 tours par phase : round.add et phase.reopen comptent pour la phase visée → SOFT_PHASE_LIMIT', async () => {
    const w = await world('P3');
    await adjustPhase(db, input(w, { op: 'round.add', expected_revision: w.rev }));
    await adjustPhase(db, input(w, { op: 'phase.skip', expected_revision: w.rev + 1 })); // P3 → P4
    await adjustPhase(db, input(w, { op: 'phase.reopen', target_phase: 'P3', expected_revision: w.rev + 2 })); // 3e tour de P3
    expect(await codeOf(adjustPhase(db, input(w, { op: 'round.add', expected_revision: w.rev + 3 })))).toBe('SOFT_PHASE_LIMIT');
    expect(await cycleRow(w.cycle)).toEqual({ phase: 'P3', revision: w.rev + 3 });
  });

  it('budget du cycle : au-delà de ' + SOFT_OPS_PER_CYCLE_MAX + ' réorganisations → SOFT_PHASE_LIMIT', async () => {
    const w = await world('P3');
    for (let i = 0; i < SOFT_OPS_PER_CYCLE_MAX; i++) {
      await insertEventRow(db, { cycle: w.cycle, type: 'phase.advance', participant: w.holder, role: 'coordinator',
        payload: { op: 'phase.skip', from: 'P1', to: 'P2' }, key: uniq('budget') });
    }
    expect(await codeOf(adjustPhase(db, input(w, { op: 'round.add' })))).toBe('SOFT_PHASE_LIMIT');
  });

  it('phase.skip : phase facultative sautée ; jamais P5, ni une phase à conditions de sortie, ni un tour scellé', async () => {
    const ok = await world('P3');
    expect(await adjustPhase(db, input(ok, { op: 'phase.skip' }))).toMatchObject({ status: 'applied', from: 'P3', to: 'P4' });

    const p5 = await world('P5');
    expect(await codeOf(adjustPhase(db, input(p5, { op: 'phase.skip' })))).toBe('SOFT_PHASE_PROTECTED');

    const gated = await world('P3');
    await db.prepare("UPDATE phase_definitions SET exit_conditions = '[\"owner_validated\"]' WHERE cycle_id = ?1 AND phase = 'P3'").bind(gated.cycle).run();
    expect(await codeOf(adjustPhase(db, input(gated, { op: 'phase.skip' })))).toBe('SOFT_PHASE_PROTECTED');

    const sealed = await world('P1');
    await db.prepare("UPDATE phase_definitions SET expected_outputs = ?2 WHERE cycle_id = ?1 AND phase = 'P1'")
      .bind(sealed.cycle, JSON.stringify([{ role: 'author', kind: 'proposal.submit', count: 1 }])).run();
    expect(await codeOf(adjustPhase(db, input(sealed, { op: 'phase.skip' })))).toBe('SOFT_PHASE_SEALED');

    const pending = await world('P2');
    await db.prepare("INSERT INTO sealed_items (id, cycle_id, phase, participant_id, content_hash, content, revealed_at) VALUES (?1, ?2, 'P2', ?3, 'h', 'c', NULL)")
      .bind(uniq('seal'), pending.cycle, pending.other).run();
    expect(await codeOf(adjustPhase(db, input(pending, { op: 'phase.skip' })))).toBe('SOFT_PHASE_SEALED');

    const last = await world('P6');
    expect(await codeOf(adjustPhase(db, input(last, { op: 'phase.skip' })))).toBe('SOFT_PHASE_INVALID');
    for (const w of [p5, gated, sealed, pending, last]) expect(await countEvents(db, w.cycle, 'phase.advance')).toBe(0);
  });

  it('phase.reopen : cible antérieure obligatoire, conditions d\'entrée de la cible respectées', async () => {
    const w = await world('P4');
    expect(await codeOf(adjustPhase(db, input(w, { op: 'phase.reopen' })))).toBe('SOFT_PHASE_INVALID');
    expect(await codeOf(adjustPhase(db, input(w, { op: 'phase.reopen', target_phase: 'P5' })))).toBe('SOFT_PHASE_INVALID');
    expect(await codeOf(adjustPhase(db, input(w, { op: 'round.add', target_phase: 'P2' })))).toBe('SOFT_PHASE_INVALID');
    await db.prepare("UPDATE phase_definitions SET entry_conditions = '[\"needs_owner\"]' WHERE cycle_id = ?1 AND phase = 'P1'").bind(w.cycle).run();
    expect(await codeOf(adjustPhase(db, input(w, { op: 'phase.reopen', target_phase: 'P1' })))).toBe('PHASE_ENTRY_CONDITIONS_UNMET');
    expect(await adjustPhase(db, input(w, { op: 'phase.reopen', target_phase: 'P2' }))).toMatchObject({ status: 'applied', from: 'P4', to: 'P2' });
    expect(await cycleRow(w.cycle)).toEqual({ phase: 'P2', revision: w.rev + 1 });
  });

  it('révision périmée → STALE ; justification trop courte ou op_id d\'un autre client → refus, rien écrit', async () => {
    const w = await world();
    expect(await codeOf(adjustPhase(db, input(w, { op: 'round.add', expected_revision: w.rev + 50 })))).toBe('STALE');
    expect(await codeOf(adjustPhase(db, input(w, { op: 'round.add', reason: 'court' })))).toBe('SOFT_PHASE_INVALID');
    expect(await codeOf(adjustPhase(db, input(w, { op: 'round.add', op_id: w.other + ':' + w.cycle + ':soft:1' })))).toBe('INVALID_OP_ID');
    expect(await countEvents(db, w.cycle, 'phase.advance')).toBe(0);
  });

  it('course : mandat révoqué entre les vérifications et le lot d\'écriture → SOFT_PHASE_PRECONDITION_FAILED, rien écrit', async () => {
    const w = await world();
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            await target.prepare('UPDATE delegated_mandates SET epoch = epoch + 1 WHERE cycle_id = ?1').bind(w.cycle).run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await codeOf(adjustPhase(racing, input(w, { op: 'round.add' })))).toBe('SOFT_PHASE_PRECONDITION_FAILED');
    expect(await cycleRow(w.cycle)).toEqual({ phase: 'P3', revision: w.rev });
    expect(await countEvents(db, w.cycle, 'phase.advance')).toBe(0);
  });

  it('une réorganisation n\'est jamais prise pour le rejeu d\'une avance par policy (findReplay limité au rôle policy)', async () => {
    const w = await world('P3');
    await adjustPhase(db, input(w, { op: 'phase.skip' })); // rev 1 → 2, P3 → P4
    const code = await codeOf(advanceGuarded(db, { cycle_id: w.cycle, expected_revision: w.rev, next_phase: 'P4' }));
    expect(code).not.toBe('NO_ERROR'); // avant le correctif : « duplicate » silencieux
    expect(await countEvents(db, w.cycle, 'phase.advance')).toBe(1);
  });
});

describe('CC-5 l3d 2c-1 — outil MCP collab_phase_adjust', () => {
  type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
  type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

  async function tool(clientId: string): Promise<ToolHandler> {
    const { registerCollabStoreTools } = await import('../../../src/collab-store/mcp/tools');
    const { createCollabToolContext } = await import('../../../src/collab-store/mcp/context');
    const context = createCollabToolContext({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true' }, 'agent:x', ['collab:'], {}, clientId);
    let handler: ToolHandler | null = null;
    registerCollabStoreTools({ registerTool(name: string, _spec: unknown, h: ToolHandler) { if (name === 'collab_phase_adjust') handler = h; } } as never, context);
    return handler!;
  }

  it('identité issue du jeton : le coordinateur mandaté réorganise ; un client non associé est refusé', async () => {
    const { mapClient } = await import('../../../src/collab-store/owner/decisions');
    const w = await world('P2');
    const client = uniq('client');
    await mapClient(db, { oauth_client_id: client, participant_id: w.holder, proof, op: uniq('map') });
    const ok = await (await tool(client))({ cycle: w.cycle, expected_rev: w.rev, op: 'round.add', reason: 'Second tour : pas de consensus.',
      op_id: w.holder + ':' + w.cycle + ':soft:1' });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0].text)).toMatchObject({ status: 'applied', op: 'round.add', from: 'P2', to: 'P2' });
    const denied = await (await tool(uniq('unknown')))({ cycle: w.cycle, expected_rev: w.rev + 1, op: 'round.add', reason: 'Second tour : pas de consensus.',
      op_id: 'x:' + w.cycle + ':soft:1' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('non associé');
  });
});
