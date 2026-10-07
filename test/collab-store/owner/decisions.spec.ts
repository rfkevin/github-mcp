import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  listPendingRequests, mapClient, recordOwnerDecision, registerParticipant, REGISTRY_CYCLE,
} from '../../../src/collab-store/owner/decisions';
import { CollabStore } from '../../../src/collab-store/store/collab-store';

// CC-3 C5 — décisions owner : seul le canal owner écrit owner.decision (R1), avec sa preuve.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const uniq = (label: string) => `c5d-${label}-${++n}`;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as { code: string }).code; }
  return 'NO_ERROR';
}

async function fileRequest(store: CollabStore, cycleId: string, rev: number, requestId: string): Promise<void> {
  const outcome = await store.appendEvent({ cycle_id: cycleId, type: 'owner.request', participant_id: 'agent:a',
    expected_rev: rev, op_id: `t:${cycleId}:req:${++n}`, payload_json: JSON.stringify({ request_id: requestId, summary: 'waiver D12' }) });
  expect(outcome.status).toBe('applied');
}

describe('CC-3 C5 — décisions owner', () => {
  it('une demande déposée par un agent apparaît en attente puis est tranchée avec sa preuve', async () => {
    const store = new CollabStore(db);
    const cycleId = uniq('cycle');
    const requestId = uniq('req');
    await fileRequest(store, cycleId, 0, requestId);
    expect((await listPendingRequests(db, 500)).map(item => item.request_id)).toContain(requestId);

    const result = await recordOwnerDecision(db, { request_id: requestId, decision: 'approve', proof });
    expect(result).toMatchObject({ status: 'applied', decision: 'approve' });
    expect(result.event).toMatchObject({ type: 'owner.decision', participant_id: 'owner', role: 'owner', cycle_id: cycleId });
    expect(JSON.parse(result.event.payload_json)).toMatchObject({ request_id: requestId, decision: 'approve', proof_kind: 'secret' });
    const row = await db.prepare('SELECT decision, access_subject, event_seq FROM owner_decisions WHERE request_id = ?1')
      .bind(requestId).first<{ decision: string; access_subject: string; event_seq: number }>();
    expect(row).toEqual({ decision: 'approve', access_subject: 'secret:owner-secret', event_seq: result.event.seq });
    expect((await listPendingRequests(db, 500)).map(item => item.request_id)).not.toContain(requestId);
    // La décision compte comme un événement du cycle : la révision avance.
    expect(await store.currentRevision(cycleId)).toBe(2);
  });

  it('une demande ne se tranche qu’une fois ; une demande inconnue est refusée', async () => {
    const store = new CollabStore(db);
    const cycleId = uniq('cycle');
    const requestId = uniq('req');
    await fileRequest(store, cycleId, 0, requestId);
    await recordOwnerDecision(db, { request_id: requestId, decision: 'deny', proof });
    expect(await codeOf(recordOwnerDecision(db, { request_id: requestId, decision: 'approve', proof }))).toBe('ALREADY_DECIDED');
    expect(await codeOf(recordOwnerDecision(db, { request_id: uniq('missing'), decision: 'approve', proof }))).toBe('UNKNOWN_REQUEST');
    expect(await codeOf(recordOwnerDecision(db, { request_id: requestId, decision: 'maybe', proof }))).toBe('INVALID_DECISION');
  });

  it('un agent ne peut écrire owner.decision par aucun chemin du store (R1)', async () => {
    const store = new CollabStore(db);
    const cycleId = uniq('cycle');
    expect(await codeOf(store.appendEvent({ cycle_id: cycleId, type: 'owner.decision', participant_id: 'agent:a',
      expected_rev: 0, op_id: `t:${cycleId}:forge:1`, payload_json: '{"request_id":"x","decision":"approve"}' })))
      .toBe('OWNER_DECISION_FORBIDDEN');
  });

  it('la décision passe malgré une écriture concurrente d’agent sur le même cycle (CAS + reprise)', async () => {
    const store = new CollabStore(db);
    const cycleId = uniq('cycle');
    const requestId = uniq('req');
    await fileRequest(store, cycleId, 0, requestId);
    const [decision, agent] = await Promise.all([
      recordOwnerDecision(db, { request_id: requestId, decision: 'approve', proof }),
      store.appendEvent({ cycle_id: cycleId, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 1,
        op_id: `t:${cycleId}:cp:1`, payload_json: '{}' }),
    ]);
    expect(decision.status).toBe('applied');
    expect(['applied', 'stale']).toContain(agent.status);
    const { results } = await db.prepare('SELECT type FROM events WHERE cycle_id = ?1 ORDER BY seq').bind(cycleId).all<{ type: string }>();
    expect(results.filter(row => row.type === 'owner.decision')).toHaveLength(1);
  });

  it('le registre est journalisé et refuse les identifiants réservés ou un participant inconnu', async () => {
    expect(await codeOf(registerParticipant(db, { participant_id: 'owner', display_label: 'x', proof, op: uniq('op') }))).toBe('INVALID_PARTICIPANT_ID');
    expect(await codeOf(registerParticipant(db, { participant_id: 'unregistered:abc', display_label: 'x', proof, op: uniq('op') }))).toBe('INVALID_PARTICIPANT_ID');
    expect(await codeOf(mapClient(db, { oauth_client_id: uniq('client'), participant_id: uniq('ghost'), proof, op: uniq('op') })))
      .toBe('OWNER_PRECONDITION_FAILED');
    const pid = uniq('p');
    const registered = await registerParticipant(db, { participant_id: pid, display_label: 'P', proof, op: uniq('op') });
    expect(registered.event).toMatchObject({ cycle_id: REGISTRY_CYCLE, type: 'owner.decision', participant_id: 'owner' });
    const client = uniq('client');
    const mapped = await mapClient(db, { oauth_client_id: client, participant_id: pid, proof, op: uniq('op') });
    const row = await db.prepare('SELECT approved_event_seq FROM participant_clients WHERE oauth_client_id = ?1')
      .bind(client).first<{ approved_event_seq: number }>();
    expect(row?.approved_event_seq).toBe(mapped.event.seq);
  });
});
