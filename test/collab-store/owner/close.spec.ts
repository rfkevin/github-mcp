import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { closeCycle } from '../../../src/collab-store/owner/close';
import { recordOwnerDecision } from '../../../src/collab-store/owner/decisions';
import { installPhaseDefinitions } from '../../../src/collab-store/owner/phase-install';
import { importStateSnapshot } from '../../../src/collab-store/owner/state-import';
import { appointCycleCoordinator } from '../../../src/collab-store/owner/delegation-execution';
import { exportCycleState } from '../../../src/collab-store/export/state-export';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { doc, TASK } from '../state-doc-helper';

// CC-Owner V2 L2 — clôture d'un cycle par le propriétaire : refuse-soft avec
// compte affiché, force réservée à l'owner (motif + confirmation), tâches
// actives bloquantes même en force, état terminal, decide préservé.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
const delegatedProof = (cycleId: string) => ({ kind: 'delegated' as const, subject: 'reviewer', cycle_id: cycleId,
  epoch: 0, request_id: 'req', reviewer_pid: 'agent:b', reviewer_family: 'agent:b', expires_at: 0,
  params_hash: 'h', max_cost_cents: 0 });
let n = 0;
const uniq = (label: string) => `ccown2-${label}-${++n}`;
let day = 0;

/** Un jour distinct par store : novembre, sans recouvrement avec les suites d'octobre. */
function makeStore(): CollabStore {
  day += 1;
  const stamp = `2026-11-${String(day).padStart(2, '0')}T10:00:00.000Z`;
  return new CollabStore(db, { now: () => new Date(stamp) });
}

function codeOf(error: unknown): string {
  return (error as { code: string }).code;
}

/** Capture le refus (code + message) ; échoue si la promesse aboutit. */
async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('un refus était attendu');
}

/** Dépose une demande d'agent valide sur le cycle. */
async function fileRequest(store: CollabStore, cycle: string, rev: number, requestId: string): Promise<void> {
  const outcome = await store.appendEvent({ cycle_id: cycle, type: 'owner.request', participant_id: 'agent:a',
    expected_rev: rev, op_id: `agent.a:${cycle}:req:${++n}`, payload_json: JSON.stringify({ request_id: requestId, summary: 'demande de test' }) });
  expect(outcome.status).toBe('applied');
}

async function appendCheckpoint(store: CollabStore, cycle: string, expectedRev: number, opSuffix: string) {
  return store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: expectedRev,
    payload_json: '{}', op_id: `agent.a:${cycle}:${opSuffix}` });
}

/** F1 A08 : les rôles des tâches doivent être des participants actifs (K6). */
async function seedParticipants(...pids: string[]): Promise<void> {
  for (const pid of pids) {
    await db.prepare(
      "INSERT INTO participants (participant_id, display_label, status) VALUES (?1, ?1, 'active') ON CONFLICT(participant_id) DO NOTHING"
    ).bind(pid).run();
  }
}

async function countEvents(cycle: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>())?.n ?? 0;
}

async function countCloseEvents(cycle: string): Promise<number> {
  return (await db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND json_valid(payload_json)"
    + " AND json_extract(payload_json, '$.action') = 'close_cycle'"
  ).bind(cycle).first<{ n: number }>())?.n ?? 0;
}

async function cycleStatus(cycle: string): Promise<string> {
  return (await db.prepare('SELECT status FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ status: string }>())?.status ?? 'absent';
}

describe('CC-Owner V2 — L2 : clôture d’un cycle par le propriétaire', () => {
  it('clôture douce appliquée : payload et révision, rejeu duplicate, état terminal, append refusé sans écriture ni quota', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const quotaDay = `2026-11-${String(day).padStart(2, '0')}`;
    expect((await appendCheckpoint(store, cycle, 0, 'cp:1')).status).toBe('applied');
    const quotaBefore = (await db.prepare('SELECT COALESCE(writes, 0) AS w FROM quota_counters WHERE day = ?1')
      .bind(quotaDay).first<{ w: number }>())?.w ?? 0;
    const closed = await closeCycle(db, { cycle_id: cycle, proof, op: 'close-1' });
    expect(closed.status).toBe('applied');
    expect(closed).toMatchObject({ cycle_id: cycle, force: false, pending_requests: 0, active_tasks: 0 });
    expect(JSON.parse(closed.event.payload_json)).toMatchObject({ action: 'close_cycle', cycle_id: cycle,
      force: false, pending_requests: 0, active_tasks: 0, proof_kind: 'secret' });
    expect(await store.currentRevision(cycle)).toBe(2);
    // Rejeu du même op : duplicate, aucune seconde écriture ; nouvelle clé : état terminal.
    expect((await closeCycle(db, { cycle_id: cycle, proof, op: 'close-1' })).status).toBe('duplicate');
    expect(codeOf(await refusalOf(closeCycle(db, { cycle_id: cycle, proof, op: 'close-2' })))).toBe('CYCLE_ALREADY_CLOSED');
    // Append d'agent refusé CYCLE_CLOSED : rien d'écrit, quota inchangé (l'owner n'en consomme pas).
    await expect(appendCheckpoint(store, cycle, 2, 'cp:2')).rejects.toMatchObject({ code: 'CYCLE_CLOSED' });
    expect(await countEvents(cycle)).toBe(2);
    expect((await db.prepare('SELECT COALESCE(writes, 0) AS w FROM quota_counters WHERE day = ?1')
      .bind(quotaDay).first<{ w: number }>())?.w ?? 0).toBe(quotaBefore);
    expect(await cycleStatus(cycle)).toBe('closed');
  });

  it('identifiant invalide, cycle inconnu, cycle système et preuve déléguée refusés avant toute écriture', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    expect((await appendCheckpoint(store, cycle, 0, 'cp:1')).status).toBe('applied');
    expect(codeOf(await refusalOf(closeCycle(db, { cycle_id: 'BAD_ID', proof, op: 'x:1' })))).toBe('INVALID_CYCLE_ID');
    expect(codeOf(await refusalOf(closeCycle(db, { cycle_id: 'ce-cycle-n-existe-pas', proof, op: 'x:2' })))).toBe('UNKNOWN_CYCLE');
    expect(codeOf(await refusalOf(closeCycle(db, { cycle_id: 'owner-registry', proof, op: 'x:3' })))).toBe('CYCLE_CLOSE_SYSTEM_INVALID');
    expect(codeOf(await refusalOf(closeCycle(db, { cycle_id: cycle, proof: delegatedProof(cycle), op: 'x:4' })))).toBe('DELEGATED_FORBIDDEN');
    expect(await countEvents(cycle)).toBe(1);
    expect(await cycleStatus(cycle)).toBe('open');
  });

  it('refuse-soft avec compte affiché ; force exige motif et confirmation ; la demande reste tranchable après', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const requestId = uniq('req');
    await fileRequest(store, cycle, 0, requestId);
    const soft = await refusalOf(closeCycle(db, { cycle_id: cycle, proof, op: 'close-1' }));
    expect(soft.code).toBe('CYCLE_CLOSE_PENDING_REQUESTS');
    expect(soft.message).toContain('1 demande(s)');
    expect(await cycleStatus(cycle)).toBe('open');
    // Force incomplète : motif trop court, puis confirmation erronée.
    expect(codeOf(await refusalOf(closeCycle(db, { cycle_id: cycle, force: true, reason: 'court',
      confirm: cycle, proof, op: 'close-2' })))).toBe('CYCLE_CLOSE_FORCE_INVALID');
    expect(codeOf(await refusalOf(closeCycle(db, { cycle_id: cycle, force: true, reason: 'motif suffisant pour forcer',
      confirm: 'autre-chose', proof, op: 'close-3' })))).toBe('CYCLE_CLOSE_FORCE_INVALID');
    const forced = await closeCycle(db, { cycle_id: cycle, force: true, reason: 'motif suffisant pour forcer',
      confirm: cycle, proof, op: 'close-4' });
    expect(forced.status).toBe('applied');
    expect(forced).toMatchObject({ force: true, pending_requests: 1, active_tasks: 0 });
    expect(JSON.parse(forced.event.payload_json)).toMatchObject({ force: true, reason: 'motif suffisant pour forcer',
      pending_requests: 1 });
    // decide reste possible après la clôture (politique owner).
    expect((await recordOwnerDecision(db, { request_id: requestId, decision: 'deny', proof })).status).toBe('applied');
  });

  it('les demandes non actionnables (invalide, homonyme déjà tranché) ne bloquent pas la clôture douce', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const other = uniq('cyc');
    const requestId = uniq('req');
    // Demande invalide : payload sans request_id exploitable.
    expect((await store.appendEvent({ cycle_id: cycle, type: 'owner.request', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ summary: 'sans identifiant' }), op_id: `agent.a:${cycle}:req:${++n}` })).status).toBe('applied');
    // Homonyme d'un request_id déjà tranché dans un autre cycle : bloquée, jamais décidable.
    await fileRequest(store, other, 0, requestId);
    await recordOwnerDecision(db, { request_id: requestId, decision: 'approve', proof });
    expect((await store.appendEvent({ cycle_id: cycle, type: 'owner.request', participant_id: 'agent:a', expected_rev: 1,
      payload_json: JSON.stringify({ request_id: requestId, summary: 'homonyme' }), op_id: `agent.a:${cycle}:req:${++n}` })).status).toBe('applied');
    const closed = await closeCycle(db, { cycle_id: cycle, proof, op: 'close-1' });
    expect(closed.status).toBe('applied');
    expect(closed.pending_requests).toBe(0);
    expect(await cycleStatus(cycle)).toBe('closed');
  });

  it('des tâches actives interdisent la clôture, même forcée ; done y met fin', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await seedParticipants('agent:a', 'agent:b', 'agent:c');
    expect((await store.appendEvent({ cycle_id: cycle, type: 'task.claim', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:a', reviewer_pid: 'agent:b', tester_pid: 'agent:c', next_action: 'implement' } }),
      op_id: `agent.a:${cycle}:claim:1` })).status).toBe('applied');
    expect(codeOf(await refusalOf(closeCycle(db, { cycle_id: cycle, proof, op: 'close-1' })))).toBe('CYCLE_CLOSE_ACTIVE_TASKS');
    expect(codeOf(await refusalOf(closeCycle(db, { cycle_id: cycle, force: true, reason: 'motif suffisant pour forcer',
      confirm: cycle, proof, op: 'close-2' })))).toBe('CYCLE_CLOSE_ACTIVE_TASKS');
    expect((await store.appendEvent({ cycle_id: cycle, type: 'task.status', participant_id: 'agent:a', expected_rev: 1,
      payload_json: JSON.stringify({ task: { task_id: 't1', status: 'done' } }), op_id: `agent.a:${cycle}:status:1` })).status).toBe('applied');
    const closed = await closeCycle(db, { cycle_id: cycle, proof, op: 'close-3' });
    expect(closed.status).toBe('applied');
    expect(closed.active_tasks).toBe(0);
  });

  it('course réelle append contre clôture : la clôture passe, l’append aboutit ou est refusé CYCLE_CLOSED', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    expect((await appendCheckpoint(store, cycle, 0, 'cp:1')).status).toBe('applied');
    const settled = await Promise.allSettled([
      closeCycle(db, { cycle_id: cycle, proof, op: 'close-1' }),
      appendCheckpoint(store, cycle, 1, 'cp:2'),
    ]);
    // La clôture absorbe la course (reprise interne aux valeurs fraîches).
    expect(settled[0].status).toBe('fulfilled');
    const append = settled[1];
    if (append.status === 'fulfilled') {
      const outcome = append.value as { status: string; currentRevision?: number };
      if (outcome.status === 'stale') {
        // Écriture en vol absorbée : le nouvel essai au courant retombe sur CYCLE_CLOSED.
        await expect(appendCheckpoint(store, cycle, outcome.currentRevision ?? 2, 'cp:2'))
          .rejects.toMatchObject({ code: 'CYCLE_CLOSED' });
      } else {
        expect(outcome.status).toBe('applied');
      }
    } else {
      expect(codeOf(append.reason)).toBe('CYCLE_CLOSED');
    }
    expect(await cycleStatus(cycle)).toBe('closed');
    expect(await countCloseEvents(cycle)).toBe(1);
  });

  it('double clôture concurrente : exactement une appliquée, l’autre CYCLE_ALREADY_CLOSED', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    expect((await appendCheckpoint(store, cycle, 0, 'cp:1')).status).toBe('applied');
    const settled = await Promise.allSettled([
      closeCycle(db, { cycle_id: cycle, proof, op: 'close-a' }),
      closeCycle(db, { cycle_id: cycle, proof, op: 'close-b' }),
    ]);
    const outcomes = settled.map(item => item.status === 'fulfilled'
      ? (item.value as { status: string }).status : codeOf((item as PromiseRejectedResult).reason));
    expect(outcomes.filter(code => code === 'applied')).toHaveLength(1);
    expect(outcomes.filter(code => code === 'CYCLE_ALREADY_CLOSED')).toHaveLength(1);
    expect(await cycleStatus(cycle)).toBe('closed');
    expect(await countCloseEvents(cycle)).toBe(1);
  });

  it('post-clôture : install_phases, import_state et appoint_cycle_coordinator refusés CYCLE_CLOSED, decide préservé', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const requestId = uniq('req');
    await fileRequest(store, cycle, 0, requestId);
    expect((await closeCycle(db, { cycle_id: cycle, force: true, reason: 'motif suffisant pour forcer',
      confirm: cycle, proof, op: 'close-1' })).status).toBe('applied');
    expect(codeOf(await refusalOf(installPhaseDefinitions(db, { cycle_id: cycle, definitions: '', proof })))).toBe('CYCLE_CLOSED');
    expect(codeOf(await refusalOf(importStateSnapshot(db, { cycle_id: cycle, markdown: doc({ revision: 2 }), proof })))).toBe('CYCLE_CLOSED');
    expect(codeOf(await refusalOf(appointCycleCoordinator(db, { cycleId: cycle, participantId: null, familyId: null,
      expectedEpoch: 0, proof, op: 'coordinator-1' })))).toBe('CYCLE_CLOSED');
    expect((await recordOwnerDecision(db, { request_id: requestId, decision: 'deny', proof })).status).toBe('applied');
  });

  it('export et lectures après clôture : l’export superpose les écritures post-import et reste disponible', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    expect((await importStateSnapshot(db, { cycle_id: cycle,
      markdown: doc({ revision: 2, tasks: [TASK('t1', 'done', 1)] }), proof })).status).toBe('applied');
    expect((await store.appendEvent({ cycle_id: cycle, type: 'evidence.add', participant_id: 'agent:a', expected_rev: 1,
      payload_json: JSON.stringify({ task: 't1', source: 'bilan', state: 'ok', review: 'ok' }),
      op_id: `agent.a:${cycle}:ev:1` })).status).toBe('applied');
    expect((await closeCycle(db, { cycle_id: cycle, proof, op: 'close-1' })).status).toBe('applied');
    const exported = await exportCycleState(db, cycle);
    expect(exported.changed).toBe(true);
    expect(exported.changes.evidence).toBe(1);
    // La clôture n'est pas une ligne de décision du document : l'état reste le journal de travail.
    expect(exported.changes.owner_decisions).toBe(0);
    expect(exported.state_revision).toBe(3);
    expect(exported.base_revision).toBe(2);
    expect((await store.getContext(cycle, 'agent:a')).cycle_id).toBe(cycle);
    expect((await store.getDelta(cycle, 0, 10, 'agent:a')).events).toHaveLength(3);
  });
});
