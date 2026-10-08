import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { listPendingPage, recordOwnerDecision, type PendingRequest } from '../../../src/collab-store/owner/decisions';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { createOAuthFixture } from '../../oauth/helpers';

// CC-3 F2 (audit github-mcp#79) — A02 : une décision vise la demande exacte affichée ;
// A06 : aucune demande non tranchée n'est masquée par une limite appliquée avant filtrage.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const uniq = (label: string) => `f2-${label}-${Date.now().toString(36)}-${++n}`;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as { code: string }).code; }
  return 'NO_ERROR';
}

/** Files an owner.request through the real store and returns its immutable seq. */
async function file(store: CollabStore, cycleId: string, requestId: string, summary = 'demande'): Promise<number> {
  const outcome = await store.appendEvent({ cycle_id: cycleId, type: 'owner.request', participant_id: 'agent:a',
    expected_rev: await store.currentRevision(cycleId), op_id: `t:${cycleId}:req:${++n}`,
    payload_json: JSON.stringify({ request_id: requestId, summary }) });
  expect(outcome.status).toBe('applied');
  return (outcome as { event: { seq: number } }).event.seq;
}

/** Every listed request across all pages (follows next_before). */
async function allPending(pageSize = 100): Promise<{ items: PendingRequest[]; total: number }> {
  const items: PendingRequest[] = [];
  let before: number | undefined;
  let total = 0;
  for (;;) {
    const page = await listPendingPage(db, { limit: pageSize, before });
    total = page.total;
    items.push(...page.items);
    if (page.next_before === null) break;
    before = page.next_before;
  }
  return { items, total };
}

async function decisionRows(requestId: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM owner_decisions WHERE request_id = ?1').bind(requestId).first<{ n: number }>())?.n ?? 0;
}

describe('CC-3 F2 / A02 — la décision vise la demande affichée', () => {
  it('deux cycles, même request_id : la décision reste sur la demande lue ; l’homonyme est listée bloquée', async () => {
    const store = new CollabStore(db);
    const requestId = uniq('homonym');
    const cycleA = uniq('cycle-a');
    const cycleB = uniq('cycle-b');
    const seqA = await file(store, cycleA, requestId, 'lue par Kevin');
    // Kevin affiche le formulaire de A ; une homonyme B arrive ensuite, dans un autre cycle.
    const seqB = await file(store, cycleB, requestId, 'arrivée après affichage');
    const result = await recordOwnerDecision(db, { request_id: requestId, request_seq: seqA, cycle_id: cycleA, decision: 'approve', proof });
    expect(result.status).toBe('applied');
    expect(result.event.cycle_id).toBe(cycleA);
    expect(JSON.parse(result.event.payload_json)).toMatchObject({ request_id: requestId, request_seq: seqA });

    const { items } = await allPending();
    expect(items.find(item => item.seq === seqA)).toBeUndefined();
    expect(items.find(item => item.seq === seqB)).toMatchObject({ state: 'blocked', decided_seq: seqA, cycle_id: cycleB });
    expect(await codeOf(recordOwnerDecision(db, { request_id: requestId, request_seq: seqB, cycle_id: cycleB, decision: 'deny', proof })))
      .toBe('ALREADY_DECIDED');
    expect(await decisionRows(requestId)).toBe(1);
  });

  it('même cycle : une homonyme plus récente ne reçoit pas la décision destinée à l’ancienne', async () => {
    const store = new CollabStore(db);
    const requestId = uniq('same-cycle');
    const cycle = uniq('cycle');
    const older = await file(store, cycle, requestId, 'ancienne');
    const newer = await file(store, cycle, requestId, 'nouvelle');
    const result = await recordOwnerDecision(db, { request_id: requestId, request_seq: older, cycle_id: cycle, decision: 'deny', proof });
    expect(JSON.parse(result.event.payload_json).request_seq).toBe(older);
    expect((await allPending()).items.find(item => item.seq === newer)).toMatchObject({ state: 'blocked', decided_seq: older });
  });

  it('formulaire périmé ou altéré : REQUEST_MISMATCH / UNKNOWN_REQUEST, rien n’est écrit', async () => {
    const store = new CollabStore(db);
    const cycle = uniq('cycle');
    const requestId = uniq('stale');
    const seq = await file(store, cycle, requestId);
    const other = uniq('other');
    expect(await codeOf(recordOwnerDecision(db, { request_id: other, request_seq: seq, decision: 'approve', proof }))).toBe('REQUEST_MISMATCH');
    expect(await codeOf(recordOwnerDecision(db, { request_id: requestId, request_seq: seq, cycle_id: uniq('wrong'), decision: 'approve', proof })))
      .toBe('REQUEST_MISMATCH');
    const checkpoint = await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a',
      expected_rev: await store.currentRevision(cycle), op_id: `t:${cycle}:cp:${++n}`, payload_json: '{}' });
    const checkpointSeq = (checkpoint as { event: { seq: number } }).event.seq;
    expect(await codeOf(recordOwnerDecision(db, { request_id: requestId, request_seq: checkpointSeq, decision: 'approve', proof }))).toBe('UNKNOWN_REQUEST');
    expect(await codeOf(recordOwnerDecision(db, { request_id: requestId, request_seq: 0, decision: 'approve', proof }))).toBe('INVALID_REQUEST_ID');
    expect(await decisionRows(requestId)).toBe(0);
    expect(await decisionRows(other)).toBe(0);
  });

  it('double soumission du même formulaire : idempotente, une seule décision', async () => {
    const store = new CollabStore(db);
    const cycle = uniq('cycle');
    const requestId = uniq('double');
    const seq = await file(store, cycle, requestId);
    const first = await recordOwnerDecision(db, { request_id: requestId, request_seq: seq, cycle_id: cycle, decision: 'approve', proof });
    const again = await recordOwnerDecision(db, { request_id: requestId, request_seq: seq, cycle_id: cycle, decision: 'approve', proof });
    expect(first.status).toBe('applied');
    expect(again).toMatchObject({ status: 'duplicate', decision: 'approve' });
    expect(again.event.seq).toBe(first.event.seq);
    // Sans seq, une demande déjà tranchée reste refusée (contrat C5 inchangé).
    expect(await codeOf(recordOwnerDecision(db, { request_id: requestId, decision: 'deny', proof }))).toBe('ALREADY_DECIDED');
    expect(await decisionRows(requestId)).toBe(1);
  });

  it('sans seq et avec deux homonymes non tranchées : AMBIGUOUS_REQUEST, rien n’est écrit', async () => {
    const store = new CollabStore(db);
    const requestId = uniq('ambiguous');
    await file(store, uniq('cycle'), requestId);
    await file(store, uniq('cycle'), requestId);
    expect(await codeOf(recordOwnerDecision(db, { request_id: requestId, decision: 'approve', proof }))).toBe('AMBIGUOUS_REQUEST');
    expect(await decisionRows(requestId)).toBe(0);
  });

  it('deux décisions concurrentes sur deux homonymes : une seule réussit, liée à sa propre demande', async () => {
    const store = new CollabStore(db);
    const requestId = uniq('race');
    const seqA = await file(store, uniq('cycle'), requestId);
    const seqB = await file(store, uniq('cycle'), requestId);
    const outcomes = await Promise.allSettled([
      recordOwnerDecision(db, { request_id: requestId, request_seq: seqA, decision: 'approve', proof }),
      recordOwnerDecision(db, { request_id: requestId, request_seq: seqB, decision: 'deny', proof }),
    ]);
    const won = outcomes.filter(item => item.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const lost = outcomes.find(item => item.status === 'rejected') as PromiseRejectedResult;
    expect(['ALREADY_DECIDED', 'OWNER_PRECONDITION_FAILED']).toContain((lost.reason as { code: string }).code);
    const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof recordOwnerDecision>>>).value;
    const boundSeq = JSON.parse(winner.event.payload_json).request_seq;
    expect(boundSeq).toBe(winner.decision === 'approve' ? seqA : seqB);
    expect(await decisionRows(requestId)).toBe(1);
  });
});

describe('CC-3 F2 / A06 — aucune demande en attente masquée', () => {
  it('une ancienne demande reste visible et décidable derrière 501 demandes plus récentes déjà tranchées', async () => {
    const store = new CollabStore(db);
    const cycle = uniq('volume');
    const oldest = uniq('oldest');
    const oldestSeq = await file(store, cycle, oldest, 'la plus ancienne');
    const decided: number[] = [];
    for (let i = 0; i < 501; i += 1) {
      const requestId = `${oldest}-n${i}`;
      const seq = await file(store, cycle, requestId);
      await recordOwnerDecision(db, { request_id: requestId, request_seq: seq, decision: 'approve', proof });
      decided.push(seq);
    }
    // Ancien comportement : LIMIT 100 / 500 avant filtrage → zéro demande visible, puis UNKNOWN_REQUEST.
    const { items, total } = await allPending(100);
    expect(items.find(item => item.seq === oldestSeq)).toMatchObject({ state: 'pending', request_id: oldest });
    expect(items.some(item => decided.includes(item.seq))).toBe(false);
    expect(new Set(items.map(item => item.seq)).size).toBe(items.length);
    expect(items.length).toBe(total);
    const result = await recordOwnerDecision(db, { request_id: oldest, decision: 'approve', proof });
    expect(JSON.parse(result.event.payload_json).request_seq).toBe(oldestSeq);
  }, 120_000);

  it('pages ordonnées et complètes : chaque demande non tranchée apparaît une fois, total exact', async () => {
    const store = new CollabStore(db);
    const cycle = uniq('pages');
    const seqs: number[] = [];
    for (let i = 0; i < 7; i += 1) seqs.push(await file(store, cycle, uniq('page')));
    const { items, total } = await allPending(3);
    const mine = items.filter(item => seqs.includes(item.seq)).map(item => item.seq);
    expect(mine).toEqual([...seqs].reverse());
    expect(items.length).toBe(total);
    const sorted = items.map(item => item.seq);
    expect(sorted).toEqual([...sorted].sort((a, b) => b - a));
  });

  it('une demande à l’identifiant invalide est listée non décidable, jamais cachée', async () => {
    const store = new CollabStore(db);
    const cycle = uniq('invalid');
    const outcome = await store.appendEvent({ cycle_id: cycle, type: 'owner.request', participant_id: 'agent:a',
      expected_rev: 0, op_id: `t:${cycle}:req:${++n}`, payload_json: JSON.stringify({ request_id: 'bad id!', summary: 's' }) });
    const seq = (outcome as { event: { seq: number } }).event.seq;
    expect((await allPending()).items.find(item => item.seq === seq)).toMatchObject({ state: 'invalid' });
  });
});

describe('CC-3 F2 — /owner : le formulaire porte la cible immuable', () => {
  const SECRET = 'owner-secret-F2-0123456789abcdefghijklmn';
  const fixture = () => createOAuthFixture({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true', OWNER_AUTH_MODE: 'secret', OWNER_SECRET: SECRET });
  const post = (f: ReturnType<typeof fixture>, fields: Record<string, string>) =>
    f.send('/owner', { method: 'POST', headers: { Origin: f.ORIGIN }, body: new URLSearchParams(fields) });

  it('le bouton affiché décide la demande lue même si une homonyme arrive avant la soumission', async () => {
    const store = new CollabStore(db);
    const f = fixture();
    const requestId = uniq('form');
    const cycleA = uniq('cycle-a');
    const seqA = await file(store, cycleA, requestId, 'lue');
    const view = await (await post(f, { action: 'view', owner_secret: SECRET })).text();
    // Champs cachés du formulaire de A, tels que le navigateur les renverra.
    const form = view.split('</form>').find(part => part.includes('name="request_seq" value="' + seqA + '"')) ?? '';
    const hidden = Object.fromEntries([...form.matchAll(/type="hidden" name="([a-z_]+)" value="([^"]*)"/g)].map(m => [m[1], m[2]]));
    expect(hidden).toMatchObject({ action: 'decide', request_id: requestId, request_seq: String(seqA), cycle_id: cycleA });
    const seqB = await file(store, uniq('cycle-b'), requestId, 'arrivée après affichage');
    const decided = await post(f, { ...hidden, decision: 'approve', owner_secret: SECRET });
    expect(decided.status).toBe(200);
    const row = await db.prepare([
      "SELECT json_extract(e.payload_json, '$.request_seq') AS request_seq, e.cycle_id FROM owner_decisions d",
      'JOIN events e ON e.seq = d.event_seq WHERE d.request_id = ?1',
    ].join(' ')).bind(requestId).first<{ request_seq: number; cycle_id: string }>();
    expect(row).toEqual({ request_seq: seqA, cycle_id: cycleA });
    const after = await decided.text();
    expect(after).toContain('seq ' + seqB);
    expect(after).toContain('Identifiant déjà tranché pour la seq ' + seqA);
    // Formulaire altéré (seq d'une autre demande) : refus explicite, rien d'écrit.
    const other = uniq('form-other');
    const seqOther = await file(store, uniq('cycle'), other);
    const tampered = await post(f, { action: 'decide', request_id: requestId, request_seq: String(seqOther), decision: 'deny', owner_secret: SECRET });
    expect(tampered.status).toBe(409);
    expect(await tampered.text()).toContain('REQUEST_MISMATCH');
    expect(await decisionRows(other)).toBe(0);
    expect(after).not.toContain(SECRET);
  });

  it('pagination : le bouton « Demandes plus anciennes » ouvre la page suivante sans rien masquer', async () => {
    const store = new CollabStore(db);
    const f = fixture();
    const cycle = uniq('paging');
    const oldest = await file(store, cycle, uniq('page-oldest'));
    for (let i = 0; i < 101; i += 1) await file(store, cycle, uniq('page-filler'));
    let body = await (await post(f, { action: 'view', owner_secret: SECRET })).text();
    let found = body.includes('name="request_seq" value="' + oldest + '"');
    for (let guard = 0; !found && guard < 50; guard += 1) {
      const before = body.match(/name="before" value="(\d+)"/)?.[1];
      expect(before, 'bouton de page suivante attendu').toBeDefined();
      body = await (await post(f, { action: 'view', before: before!, owner_secret: SECRET })).text();
      found = body.includes('name="request_seq" value="' + oldest + '"');
    }
    expect(found).toBe(true);
    expect(body).not.toContain(SECRET);
  }, 60_000);
});
