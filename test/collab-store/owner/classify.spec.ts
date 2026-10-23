import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { classifyRequest } from '../../../src/collab-store/owner/classify';
import { listClassified, listPendingPage, recordOwnerDecision } from '../../../src/collab-store/owner/decisions';
import { closeCycle } from '../../../src/collab-store/owner/close';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-Owner V2 L3 — classification owner d'une demande d'agent : drain
// append-only de la liste d'attente, audit complet, anti-re-classement PK
// (cycle_id, request_seq), idempotence par op, possible sur un cycle clos.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
const delegatedProof = (cycleId: string) => ({ kind: 'delegated' as const, subject: 'reviewer', cycle_id: cycleId,
  epoch: 0, request_id: 'req', reviewer_pid: 'agent:b', reviewer_family: 'agent:b', expires_at: 0,
  params_hash: 'h', max_cost_cents: 0 });
let n = 0;
const uniq = (label: string) => `ccown3-${label}-${++n}`;
let day = 0;

/** Un jour distinct par store : décembre, sans recouvrement avec les suites d'octobre et de novembre. */
function makeStore(): CollabStore {
  day += 1;
  const stamp = `2026-12-${String(day).padStart(2, '0')}T10:00:00.000Z`;
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

/** Dépose une demande d'agent valide sur le cycle et renvoie sa seq d'événement. */
async function fileRequest(store: CollabStore, cycle: string, rev: number, requestId: string): Promise<number> {
  const outcome = await store.appendEvent({ cycle_id: cycle, type: 'owner.request', participant_id: 'agent:a',
    expected_rev: rev, op_id: `agent.a:${cycle}:req:${++n}`, payload_json: JSON.stringify({ request_id: requestId, summary: 'demande de test' }) });
  expect(outcome.status).toBe('applied');
  const row = await db.prepare(
    "SELECT seq FROM events WHERE cycle_id = ?1 AND type IN ('owner.request', 'phase.request') ORDER BY seq DESC LIMIT 1"
  ).bind(cycle).first<{ seq: number }>();
  return row!.seq;
}

async function countEvents(cycle: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>())?.n ?? 0;
}

async function countClassifications(cycle: string, seq: number): Promise<number> {
  return (await db.prepare(
    'SELECT COUNT(*) AS n FROM request_classifications WHERE cycle_id = ?1 AND request_seq = ?2'
  ).bind(cycle, seq).first<{ n: number }>())?.n ?? 0;
}

async function countClassifyEvents(cycle: string, seq: number): Promise<number> {
  return (await db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND json_valid(payload_json)"
    + " AND json_extract(payload_json, '$.action') = 'classify_request' AND json_extract(payload_json, '$.request_seq') = ?2"
  ).bind(cycle, seq).first<{ n: number }>())?.n ?? 0;
}

describe('CC-Owner V2 — L3 : classification owner d’une demande', () => {
  it('classement nominal : événement owner corrélé, ligne 0011, la demande quitte l’attente et reste dans l’audit', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const requestId = uniq('req');
    const seq = await fileRequest(store, cycle, 0, requestId);
    expect((await listPendingPage(db, { limit: 100 })).items.some(item => item.seq === seq)).toBe(true);
    const classified = await classifyRequest(db, { request_seq: seq, verdict: 'invalid', note: 'jamais décidable', proof, op: 'cl-1' });
    expect(classified.status).toBe('applied');
    expect(classified).toMatchObject({ cycle_id: cycle, request_seq: seq, verdict: 'invalid' });
    expect(JSON.parse(classified.event.payload_json)).toMatchObject({ action: 'classify_request',
      request_id: requestId, request_seq: seq, verdict: 'invalid', note: 'jamais décidable', proof_kind: 'secret' });
    const row = await db.prepare(
      'SELECT verdict, note, event_seq, created_at FROM request_classifications WHERE cycle_id = ?1 AND request_seq = ?2'
    ).bind(cycle, seq).first<{ verdict: string; note: string; event_seq: number | null; created_at: number }>();
    expect(row).toMatchObject({ verdict: 'invalid', note: 'jamais décidable', event_seq: classified.event.seq });
    expect(row!.created_at).toBeGreaterThan(0);
    expect(await store.currentRevision(cycle)).toBe(2);
    // La demande quitte la liste d'attente…
    const pending = await listPendingPage(db, { limit: 100 });
    expect(pending.items.some(item => item.seq === seq)).toBe(false);
    expect(pending.total).toBe(0);
    // …l'événement de demande n'est jamais effacé, l'audit la restitue.
    expect(await countEvents(cycle)).toBe(2);
    const audit = await listClassified(db);
    const entry = audit.find(item => item.request_seq === seq && item.cycle_id === cycle);
    expect(entry).toMatchObject({ cycle_id: cycle, request_seq: seq, verdict: 'invalid', note: 'jamais décidable',
      request_id: requestId, participant_id: 'agent:a', type: 'owner.request' });
  });

  it('rejeu du même op : duplicate ; op distinct : REQUEST_ALREADY_CLASSIFIED, aucune seconde écriture', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const seq = await fileRequest(store, cycle, 0, uniq('req'));
    expect((await classifyRequest(db, { request_seq: seq, verdict: 'duplicate', proof, op: 'same' })).status).toBe('applied');
    expect((await classifyRequest(db, { request_seq: seq, verdict: 'duplicate', proof, op: 'same' })).status).toBe('duplicate');
    const refusal = await refusalOf(classifyRequest(db, { request_seq: seq, verdict: 'other', proof, op: 'distinct' }));
    expect(refusal.code).toBe('REQUEST_ALREADY_CLASSIFIED');
    expect(refusal.message).toContain('duplicate');
    expect(await countClassifications(cycle, seq)).toBe(1);
    expect(await countClassifyEvents(cycle, seq)).toBe(1);
  });

  it('gardes d’entrée : verdict hors vocabulaire, seq invalide ou inconnu, preuve déléguée — rien n’est écrit', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const seq = await fileRequest(store, cycle, 0, uniq('req'));
    expect(codeOf(await refusalOf(classifyRequest(db, { request_seq: seq, verdict: 'spam', proof, op: 'x:1' })))).toBe('INVALID_CLASSIFICATION');
    expect(codeOf(await refusalOf(classifyRequest(db, { request_seq: 0, verdict: 'invalid', proof, op: 'x:2' })))).toBe('INVALID_REQUEST_ID');
    expect(codeOf(await refusalOf(classifyRequest(db, { request_seq: seq + 1000, verdict: 'invalid', proof, op: 'x:3' })))).toBe('UNKNOWN_REQUEST');
    expect(codeOf(await refusalOf(classifyRequest(db, { request_seq: seq, verdict: 'invalid', proof: delegatedProof(cycle), op: 'x:4' })))).toBe('DELEGATED_FORBIDDEN');
    expect(await countEvents(cycle)).toBe(1);
    expect(await countClassifications(cycle, seq)).toBe(0);
  });

  it('une demande classée ne bloque plus la clôture douce ; classification et decide restent possibles après clôture', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const seq1 = await fileRequest(store, cycle, 0, uniq('req'));
    const seq2 = await fileRequest(store, cycle, 1, uniq('req'));
    const softRefused = await refusalOf(closeCycle(db, { cycle_id: cycle, proof, op: 'close-1' }));
    expect(softRefused.code).toBe('CYCLE_CLOSE_PENDING_REQUESTS');
    expect(softRefused.message).toContain('2 demande(s)');
    expect((await classifyRequest(db, { request_seq: seq1, verdict: 'blocked', proof, op: 'cl-1' })).status).toBe('applied');
    // seq2 reste en attente : la clôture douce reste refusée, avec le compte exact.
    const stillRefused = await refusalOf(closeCycle(db, { cycle_id: cycle, proof, op: 'close-2' }));
    expect(stillRefused.code).toBe('CYCLE_CLOSE_PENDING_REQUESTS');
    expect(stillRefused.message).toContain('1 demande(s)');
    const closed = await closeCycle(db, { cycle_id: cycle, force: true, reason: 'motif suffisant pour forcer la clôture',
      confirm: cycle, proof, op: 'close-3' });
    expect(closed.status).toBe('applied');
    expect(closed.pending_requests).toBe(1);
    // Drain post-clôture : classifier (puis décider) seq2 reste possible.
    expect((await classifyRequest(db, { request_seq: seq2, verdict: 'other', note: 'hors périmètre', proof, op: 'cl-2' })).status).toBe('applied');
    expect((await recordOwnerDecision(db, { request_id: (await listClassified(db)).find(item => item.request_seq === seq2)!.request_id,
      decision: 'deny', proof, request_seq: seq2 })).status).toBe('applied');
  });

  it('une demande classée reste décidable : la classification n’est pas une décision', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const requestId = uniq('req');
    const seq = await fileRequest(store, cycle, 0, requestId);
    expect((await classifyRequest(db, { request_seq: seq, verdict: 'other', proof, op: 'cl-1' })).status).toBe('applied');
    const decided = await recordOwnerDecision(db, { request_id: requestId, decision: 'deny', proof, request_seq: seq });
    expect(decided.status).toBe('applied');
    // Les deux traces coexistent : classification (0011) et décision (owner_decisions).
    expect(await countClassifications(cycle, seq)).toBe(1);
    const decisionRow = await db.prepare('SELECT decision FROM owner_decisions WHERE request_id = ?1')
      .bind(requestId).first<{ decision: string }>();
    expect(decisionRow).toMatchObject({ decision: 'deny' });
  });

  it('deux classements concurrents : un seul gagne, l’autre reçoit REQUEST_ALREADY_CLASSIFIED, une seule ligne', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const seq = await fileRequest(store, cycle, 0, uniq('req'));
    const outcomes = await Promise.allSettled([
      classifyRequest(db, { request_seq: seq, verdict: 'invalid', proof, op: 'race-a' }),
      classifyRequest(db, { request_seq: seq, verdict: 'other', proof, op: 'race-b' }),
    ]);
    const applied = outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value.status === 'applied');
    expect(applied).toHaveLength(1);
    const refused = outcomes.find(outcome => outcome.status === 'rejected');
    expect(refused && codeOf((refused as PromiseRejectedResult).reason)).toBe('REQUEST_ALREADY_CLASSIFIED');
    expect(await countClassifications(cycle, seq)).toBe(1);
    expect(await countClassifyEvents(cycle, seq)).toBe(1);
  });

  it('migration 0011 idempotente : ensureSchema rejouable, table request_classifications présente', async () => {
    await ensureSchema(db, true);
    await ensureSchema(db, true);
    const total = (await db.prepare('SELECT COUNT(*) AS n FROM request_classifications').first<{ n: number }>())?.n ?? -1;
    expect(total).toBeGreaterThanOrEqual(0);
  });
});
