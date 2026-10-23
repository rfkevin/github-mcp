import { describe, expect, it } from 'vitest';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { listClassified, listPendingPage, recordOwnerDecision } from '../../../src/collab-store/owner/decisions';
import {
  decideOwnerRequest, describePending, executablePayloadSha256, latestOwnerActSeq, parseOwnerRequest,
} from '../../../src/collab-store/owner/executable';
import { classifyRequest } from '../../../src/collab-store/owner/classify';
import { closeCycle } from '../../../src/collab-store/owner/close';
import { activeMandate } from '../../../src/collab-store/owner/delegation-execution';
import {
  db, proof, delegatedProof, uniq, makeStoreForMonth, nextSerial, codeOf, refusalOf, fileRequest,
  countOwnerActionEvents,
} from './owner-act-helpers';

// CC-Owner V2 L6 — les trois actes owner deviennent des demandes exécutables
// approuvables : classify_request, close_cycle (mode doux) et
// appoint_cycle_coordinator. Décision et effet dans le même lot CAS, jamais
// déléguables ; l’acte lié porte l’identité de la demande exécutable
// (bindingPayload en dernier), la cible vit dans les tables d’effet.
/** Un jour distinct par store : janvier 2027 (harnais partagé, voir owner-act-helpers.ts). */
function makeStore(): CollabStore {
  return makeStoreForMonth('2027-01');
}

const AGENT = 'agent:a';
/** Participant dédié à la suite : aucune famille d’identité héritée d’une autre suite. */
const PARTICIPANT = 'l6-agent-a';

type L6Action = 'classify_request' | 'close_cycle' | 'appoint_cycle_coordinator';
type OwnerProofLike = Parameters<typeof decideOwnerRequest>[1]['proof'];

interface FiledExecutable {
  seq: number;
  requestId: string;
  sha: string;
  requestCycle: string;
}

/** Dépose une demande exécutable L6 comme le ferait un agent ; renvoie sa seq. */
async function fileExecutable(store: CollabStore, action: L6Action, params: Record<string, unknown>,
  opts: { onCycle?: string; expectedRev?: number; extra?: Record<string, unknown> } = {}): Promise<FiledExecutable> {
  const requestCycle = opts.onCycle ?? uniq('l6req');
  const requestId = uniq('l6id');
  const sha = await executablePayloadSha256(action, params);
  // previous_seq : null pour classify/close (aucun acte du même type observé),
  // dernier acte de mandat pour appoint (l’epoch se chaîne acte par acte).
  const previousSeq = action === 'appoint_cycle_coordinator'
    ? await latestOwnerActSeq(db, action, String(params.cycle_id)) : null;
  const payload = {
    request_id: requestId, summary: 'Acte owner sans copier-coller', action, params, payload_sha256: sha,
    preconditions: { previous_seq: previousSeq },
    reason: 'Acte administratif préparé par l’agent', risk: 'Effet immédiat à l’approbation',
    rollback: 'Redéposer une demande corrigée', ...(opts.extra ?? {}),
  };
  const outcome = await store.appendEvent({ cycle_id: requestCycle, type: 'owner.request', participant_id: AGENT,
    expected_rev: opts.expectedRev ?? 0, op_id: 'agent.a:' + requestCycle + ':l6:' + nextSerial(),
    payload_json: JSON.stringify(payload) });
  if (outcome.status !== 'applied') throw new Error('demande non déposée');
  return { seq: outcome.event.seq, requestId, sha, requestCycle };
}

/** Approuve une demande déposée par fileExecutable, avec surcharges possibles. */
async function approve(filed: FiledExecutable, override: { payload_sha256?: string; proof?: OwnerProofLike } = {}) {
  return decideOwnerRequest(db, { request_id: filed.requestId, decision: 'approve', proof,
    request_seq: filed.seq, payload_sha256: filed.sha, ...override });
}

/** Analyse un payload exécutable L6 comme le ferait parseOwnerRequest côté agent. */
async function parseL6(action: L6Action, params: Record<string, unknown>, requestId: string) {
  const sha = await executablePayloadSha256(action, params);
  return parseOwnerRequest(JSON.stringify({ request_id: requestId, action, params, payload_sha256: sha,
    preconditions: { previous_seq: null }, reason: 'motif lisible', risk: 'risque mesuré', rollback: 'rollback simple' }));
}

/** Crée le cycle cible par un checkpoint (révision 1) : les gardes d’ouverture le verront open. */
async function openCycle(store: CollabStore, cycle: string): Promise<void> {
  const outcome = await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: AGENT,
    expected_rev: 0, payload_json: '{}', op_id: 'agent.a:' + cycle + ':cp:' + nextSerial() });
  if (outcome.status !== 'applied') throw new Error('cycle non créé');
}

/** F1 A08 : les rôles des tâches doivent être des participants actifs (K6). */
async function seedActiveParticipant(...pids: string[]): Promise<void> {
  for (const pid of pids) {
    await db.prepare(
      "INSERT INTO participants (participant_id, display_label, status) VALUES (?1, ?1, 'active') ON CONFLICT(participant_id) DO NOTHING"
    ).bind(pid).run();
  }
}

async function ownerDecisionRow(requestId: string) {
  return db.prepare('SELECT decision, event_seq FROM owner_decisions WHERE request_id = ?1').bind(requestId)
    .first<{ decision: string; event_seq: number }>();
}

async function cycleStatus(cycle: string): Promise<string> {
  return (await db.prepare('SELECT status FROM cycles WHERE cycle_id = ?1').bind(cycle)
    .first<{ status: string }>())?.status ?? 'absent';
}

async function countClassifications(cycle: string, seq: number): Promise<number> {
  return (await db.prepare(
    'SELECT COUNT(*) AS n FROM request_classifications WHERE cycle_id = ?1 AND request_seq = ?2'
  ).bind(cycle, seq).first<{ n: number }>())?.n ?? 0;
}

/** Page /owner décrite : les vues exécutables des demandes en attente. */
async function pendingPage() {
  return describePending(await listPendingPage(db, { limit: 500 }));
}

describe('CC-Owner V2 — L6 : classify_request en demande exécutable', () => {
  it('parse : payload valide (request_seq, verdict, note), refusé sinon', async () => {
    const valid = await parseL6('classify_request', { request_seq: 7, verdict: 'other', note: 'hors périmètre' }, 'c1');
    expect(valid).toMatchObject({ kind: 'executable',
      request: { action: 'classify_request', cycle_id: 'request:7', target: 'request:7', previous_seq: null } });
    expect((await parseL6('classify_request', { request_seq: 7, verdict: 'spam' }, 'c2')).kind).toBe('invalid');
    expect((await parseL6('classify_request', { request_seq: 0, verdict: 'other' }, 'c3')).kind).toBe('invalid');
    expect((await parseL6('classify_request', { request_seq: 7, verdict: 'other', note: 'x'.repeat(501) }, 'c4')).kind).toBe('invalid');
    expect((await parseL6('classify_request', { request_seq: 7, verdict: 'other', extra: 1 }, 'c5')).kind).toBe('invalid');
  });

  it('approbation liée : classification sur le cycle de la cible, décision dans le même lot, la cible quitte l’attente', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const targetId = uniq('req');
    const targetSeq = await fileRequest(store, cycle, 0, targetId);
    const filed = await fileExecutable(store, 'classify_request',
      { request_seq: targetSeq, verdict: 'duplicate', note: 'doublon du formulaire L1' });
    const page = await pendingPage();
    const shown = page.items.find(item => item.seq === filed.seq)!;
    expect(shown.executable).toMatchObject({ action: 'classify_request', cycle_id: 'request:' + targetSeq,
      target: 'request:' + targetSeq, payload_sha256: filed.sha, previous_seq: null, expired: false });
    expect(shown.executable?.preview).toContain('"verdict": "duplicate"');
    const result = await approve(filed);
    expect(result).toMatchObject({ status: 'applied', decision: 'approve', executed: { action: 'classify_request',
      cycle_id: cycle, detail: 'demande seq ' + targetSeq + ' classée duplicate' } });
    // L’acte lié porte l’identité de la demande EXÉCUTABLE (bindingPayload en dernier)…
    expect(JSON.parse(result.event.payload_json)).toMatchObject({ action: 'classify_request',
      request_id: filed.requestId, request_seq: filed.seq, verdict: 'duplicate', note: 'doublon du formulaire L1',
      payload_sha256: filed.sha, decision: 'approve', expected_previous_seq: null, proof_kind: 'secret' });
    // …la cible classée vit dans request_classifications, corrélée par event_seq.
    const row = await db.prepare(
      'SELECT verdict, note, event_seq FROM request_classifications WHERE cycle_id = ?1 AND request_seq = ?2'
    ).bind(cycle, targetSeq).first<{ verdict: string; note: string; event_seq: number }>();
    expect(row).toMatchObject({ verdict: 'duplicate', note: 'doublon du formulaire L1', event_seq: result.event.seq });
    expect(await ownerDecisionRow(filed.requestId)).toEqual({ decision: 'approve', event_seq: result.event.seq });
    // La cible quitte l’attente (drain L3) ; la demande approuvée n’y est plus non plus.
    const after = await pendingPage();
    expect(after.items.some(item => item.seq === targetSeq)).toBe(false);
    expect(after.items.some(item => item.seq === filed.seq)).toBe(false);
    expect(await countOwnerActionEvents(cycle, 'classify_request', filed.seq)).toBe(1);
    expect((await listClassified(db)).some(item => item.request_seq === targetSeq && item.cycle_id === cycle)).toBe(true);
  });

  it('double soumission : le rejeu renvoie l’événement original ; un refus après exécution : ALREADY_DECIDED', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const targetSeq = await fileRequest(store, cycle, 0, uniq('req'));
    const filed = await fileExecutable(store, 'classify_request', { request_seq: targetSeq, verdict: 'other' });
    const first = await approve(filed);
    expect(first.status).toBe('applied');
    const replay = await approve(filed);
    expect(replay).toMatchObject({ status: 'duplicate', decision: 'approve', event: { seq: first.event.seq } });
    expect(await countClassifications(cycle, targetSeq)).toBe(1);
    expect(await countOwnerActionEvents(cycle, 'classify_request', filed.seq)).toBe(1);
    expect(codeOf(await refusalOf(decideOwnerRequest(db, { request_id: filed.requestId, decision: 'deny', proof,
      request_seq: filed.seq })))).toBe('ALREADY_DECIDED');
  });

  it('après approbation liée, un classement formulaire distinct de la même cible : REQUEST_ALREADY_CLASSIFIED', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const targetSeq = await fileRequest(store, cycle, 0, uniq('req'));
    const filed = await fileExecutable(store, 'classify_request', { request_seq: targetSeq, verdict: 'other' });
    expect((await approve(filed)).status).toBe('applied');
    const refusal = await refusalOf(classifyRequest(db, { request_seq: targetSeq, verdict: 'invalid', proof, op: 'form-1' }));
    expect(refusal.code).toBe('REQUEST_ALREADY_CLASSIFIED');
    expect(refusal.message).toContain('other');
    expect(await countClassifications(cycle, targetSeq)).toBe(1);
  });

  it('previous_seq déclaré autre que null : OWNER_PRECONDITION_FAILED, aucune écriture', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const targetSeq = await fileRequest(store, cycle, 0, uniq('req'));
    const filed = await fileExecutable(store, 'classify_request', { request_seq: targetSeq, verdict: 'invalid' },
      { extra: { preconditions: { previous_seq: 5 } } });
    expect(codeOf(await refusalOf(approve(filed)))).toBe('OWNER_PRECONDITION_FAILED');
    expect(await countClassifications(cycle, targetSeq)).toBe(0);
    expect(await ownerDecisionRow(filed.requestId)).toBeNull();
    expect((await pendingPage()).items.some(item => item.seq === targetSeq)).toBe(true);
  });

  it('demande expirée : REQUEST_EXPIRED, la cible reste en attente', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const targetSeq = await fileRequest(store, cycle, 0, uniq('req'));
    const filed = await fileExecutable(store, 'classify_request', { request_seq: targetSeq, verdict: 'blocked' },
      { extra: { expires_at: 1_700_000_000 } });
    expect((await pendingPage()).items.find(item => item.seq === filed.seq)?.executable?.expired).toBe(true);
    expect(codeOf(await refusalOf(approve(filed)))).toBe('REQUEST_EXPIRED');
    expect(await countClassifications(cycle, targetSeq)).toBe(0);
    expect((await pendingPage()).items.some(item => item.seq === targetSeq)).toBe(true);
  });

  it('empreinte approuvée ≠ empreinte de la demande : REQUEST_MISMATCH, aucun effet', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const targetSeq = await fileRequest(store, cycle, 0, uniq('req'));
    const filed = await fileExecutable(store, 'classify_request', { request_seq: targetSeq, verdict: 'other' });
    expect(codeOf(await refusalOf(approve(filed, { payload_sha256: 'f'.repeat(64) })))).toBe('REQUEST_MISMATCH');
    expect(codeOf(await refusalOf(decideOwnerRequest(db, { request_id: filed.requestId, decision: 'approve', proof,
      request_seq: filed.seq })))).toBe('REQUEST_MISMATCH');
    expect(await countClassifications(cycle, targetSeq)).toBe(0);
    expect(await ownerDecisionRow(filed.requestId)).toBeNull();
  });

  it('preuve déléguée : jamais délégable (action_not_allowlisted), aucun effet', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const targetSeq = await fileRequest(store, cycle, 0, uniq('req'));
    const filed = await fileExecutable(store, 'classify_request', { request_seq: targetSeq, verdict: 'other' });
    const refusal = await refusalOf(approve(filed, { proof: delegatedProof(cycle) }));
    expect(refusal.message).toContain('action_not_allowlisted');
    expect(await countClassifications(cycle, targetSeq)).toBe(0);
    expect(await ownerDecisionRow(filed.requestId)).toBeNull();
  });

  it('cible inconnue : UNKNOWN_REQUEST, aucun effet', async () => {
    const store = makeStore();
    const filed = await fileExecutable(store, 'classify_request', { request_seq: 999_999_999, verdict: 'other' });
    expect(codeOf(await refusalOf(approve(filed)))).toBe('UNKNOWN_REQUEST');
    expect(await ownerDecisionRow(filed.requestId)).toBeNull();
  });
});

describe('CC-Owner V2 — L6 : close_cycle (mode doux) en demande exécutable', () => {
  it('force n’est pas approuvable : params invalide, approbation refusée, défense en profondeur', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    const filed = await fileExecutable(store, 'close_cycle',
      { cycle_id: cycle, force: true, reason: 'motif suffisant pour forcer', confirm: cycle });
    expect((await pendingPage()).items.find(item => item.seq === filed.seq)?.executable?.invalid).toContain('cycle_id seul');
    expect(codeOf(await refusalOf(approve(filed)))).toBe('EXECUTABLE_REQUEST_INVALID');
    // Défense en profondeur : closeCycle lié + force refusé avant toute écriture.
    const deep = await refusalOf(closeCycle(db, { cycle_id: cycle, force: true, proof, op: 'x:1',
      binding: { request_id: filed.requestId, request_seq: filed.seq, payload_sha256: filed.sha,
        expected_previous_seq: null } }));
    expect(deep.code).toBe('EXECUTABLE_REQUEST_INVALID');
    expect(await cycleStatus(cycle)).toBe('open');
    expect(await ownerDecisionRow(filed.requestId)).toBeNull();
  });

  it('clôture douce liée : la demande close est exclue (symétrique JS/SQL), le cycle se ferme, décision dans le même lot', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    // Déposée SUR le cycle qu’elle ferme : sans exclusion symétrique, la demande se bloquerait elle-même.
    const filed = await fileExecutable(store, 'close_cycle', { cycle_id: cycle }, { onCycle: cycle, expectedRev: 1 });
    const page = await pendingPage();
    expect(page.items.find(item => item.seq === filed.seq)?.executable)
      .toMatchObject({ action: 'close_cycle', cycle_id: cycle, target: cycle, previous_seq: null });
    const result = await approve(filed);
    expect(result).toMatchObject({ status: 'applied', decision: 'approve', executed: { action: 'close_cycle',
      cycle_id: cycle, detail: 'cycle clos (mode doux), 0 demande(s) en attente au moment de la clôture' } });
    expect(JSON.parse(result.event.payload_json)).toMatchObject({ action: 'close_cycle', cycle_id: cycle, force: false,
      pending_requests: 0, active_tasks: 0, request_id: filed.requestId, request_seq: filed.seq,
      payload_sha256: filed.sha, decision: 'approve', expected_previous_seq: null, proof_kind: 'secret' });
    expect(await cycleStatus(cycle)).toBe('closed');
    expect(await ownerDecisionRow(filed.requestId)).toEqual({ decision: 'approve', event_seq: result.event.seq });
    expect((await pendingPage()).items.some(item => item.seq === filed.seq)).toBe(false);
    expect(await countOwnerActionEvents(cycle, 'close_cycle')).toBe(1);
  });

  it('une autre demande pending bloque la clôture liée : compte exact affiché, rien n’est écrit', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    await fileRequest(store, cycle, 1, uniq('req'));
    const filed = await fileExecutable(store, 'close_cycle', { cycle_id: cycle });
    const refusal = await refusalOf(approve(filed));
    expect(refusal.code).toBe('CYCLE_CLOSE_PENDING_REQUESTS');
    expect(refusal.message).toContain('1 demande(s)');
    expect(await cycleStatus(cycle)).toBe('open');
    expect(await ownerDecisionRow(filed.requestId)).toBeNull();
  });

  it('une demande déjà tranchée ne bloque pas la clôture liée', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    const requestId = uniq('req');
    await fileRequest(store, cycle, 1, requestId);
    expect((await recordOwnerDecision(db, { request_id: requestId, decision: 'deny', proof })).status).toBe('applied');
    const filed = await fileExecutable(store, 'close_cycle', { cycle_id: cycle });
    const result = await approve(filed);
    expect(result.status).toBe('applied');
    expect(JSON.parse(result.event.payload_json)).toMatchObject({ pending_requests: 0 });
    expect(await cycleStatus(cycle)).toBe('closed');
  });

  it('des tâches actives interdisent aussi la clôture liée', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await seedActiveParticipant('agent:a', 'agent:b', 'agent:c');
    expect((await store.appendEvent({ cycle_id: cycle, type: 'task.claim', participant_id: AGENT, expected_rev: 0,
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:a', reviewer_pid: 'agent:b',
        tester_pid: 'agent:c', next_action: 'implement' } }),
      op_id: 'agent.a:' + cycle + ':claim:1' })).status).toBe('applied');
    const filed = await fileExecutable(store, 'close_cycle', { cycle_id: cycle });
    expect(codeOf(await refusalOf(approve(filed)))).toBe('CYCLE_CLOSE_ACTIVE_TASKS');
    expect(await cycleStatus(cycle)).toBe('open');
  });

  it('cycle inconnu : UNKNOWN_CYCLE', async () => {
    const store = makeStore();
    const filed = await fileExecutable(store, 'close_cycle', { cycle_id: 'l6-cycle-inconnu' });
    expect(codeOf(await refusalOf(approve(filed)))).toBe('UNKNOWN_CYCLE');
  });

  it('cycle déjà clos par le formulaire : l’approbation liée reçoit CYCLE_ALREADY_CLOSED', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    expect((await closeCycle(db, { cycle_id: cycle, force: true, reason: 'motif suffisant pour forcer',
      confirm: cycle, proof, op: 'form-1' })).status).toBe('applied');
    const filed = await fileExecutable(store, 'close_cycle', { cycle_id: cycle });
    expect(codeOf(await refusalOf(approve(filed)))).toBe('CYCLE_ALREADY_CLOSED');
    expect(await countOwnerActionEvents(cycle, 'close_cycle')).toBe(1);
  });

  it('preuve déléguée : jamais délégable (action_not_allowlisted)', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    const filed = await fileExecutable(store, 'close_cycle', { cycle_id: cycle });
    const refusal = await refusalOf(approve(filed, { proof: delegatedProof(cycle) }));
    expect(refusal.message).toContain('action_not_allowlisted');
    expect(await cycleStatus(cycle)).toBe('open');
  });

  it('double soumission du formulaire : le rejeu renvoie l’événement original ; refus après : ALREADY_DECIDED', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    const filed = await fileExecutable(store, 'close_cycle', { cycle_id: cycle });
    const first = await approve(filed);
    expect(first.status).toBe('applied');
    const replay = await approve(filed);
    expect(replay).toMatchObject({ status: 'duplicate', decision: 'approve', event: { seq: first.event.seq } });
    expect(await countOwnerActionEvents(cycle, 'close_cycle')).toBe(1);
    expect(codeOf(await refusalOf(decideOwnerRequest(db, { request_id: filed.requestId, decision: 'deny', proof,
      request_seq: filed.seq })))).toBe('ALREADY_DECIDED');
  });
});

describe('CC-Owner V2 — L6 : appoint_cycle_coordinator en demande exécutable', () => {
  it('parse : nomination et vacance valides, ids incomplets ou epoch négatif refusés', async () => {
    const valid = await parseL6('appoint_cycle_coordinator',
      { cycle_id: 'l6-cyc', participant_id: PARTICIPANT, family_id: PARTICIPANT, expected_epoch: 0 }, 'a1');
    expect(valid).toMatchObject({ kind: 'executable',
      request: { action: 'appoint_cycle_coordinator', cycle_id: 'l6-cyc', target: 'l6-cyc', previous_seq: null } });
    expect((await parseL6('appoint_cycle_coordinator', { cycle_id: 'l6-cyc', expected_epoch: 1 }, 'a2')).kind).toBe('executable');
    expect((await parseL6('appoint_cycle_coordinator',
      { cycle_id: 'l6-cyc', participant_id: PARTICIPANT, expected_epoch: 0 }, 'a3')).kind).toBe('invalid');
    expect((await parseL6('appoint_cycle_coordinator', { cycle_id: 'l6-cyc', expected_epoch: -1 }, 'a4')).kind).toBe('invalid');
    expect((await parseL6('close_cycle', { cycle_id: 'l6-cyc' }, 'a5')).kind).toBe('executable');
  });

  it('nomination liée : epoch 1, approbations en file purgées, décision et mandat dans le même lot', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    await seedActiveParticipant(PARTICIPANT);
    // activeMandate crée les tables de mandat ; une approbation en file doit être purgée par la nomination.
    expect(await activeMandate(db, cycle)).toBeNull();
    await db.prepare(
      "INSERT INTO delegated_approvals (request_id, cycle_id, epoch, action, params_hash, max_cost_cents, expires_at, reviewer_pid, reviewer_family)"
      + " VALUES ('l6-appr', ?1, 0, 'install_phases', 'h', 0, 4102444800, 'agent:b', 'agent:b')"
    ).bind(cycle).run();
    const filed = await fileExecutable(store, 'appoint_cycle_coordinator',
      { cycle_id: cycle, participant_id: PARTICIPANT, family_id: PARTICIPANT, expected_epoch: 0 });
    // Jamais déléguable : la preuve déléguée est refusée avant tout effet.
    expect((await refusalOf(approve(filed, { proof: delegatedProof(cycle) }))).message).toContain('action_not_allowlisted');
    const result = await approve(filed);
    expect(result).toMatchObject({ status: 'applied', decision: 'approve', executed: { action: 'appoint_cycle_coordinator',
      cycle_id: cycle, detail: 'mandat epoch 1, participant ' + PARTICIPANT } });
    expect(JSON.parse(result.event.payload_json)).toMatchObject({ action: 'appoint_cycle_coordinator',
      participant_id: PARTICIPANT, epoch: 1, request_id: filed.requestId, request_seq: filed.seq,
      payload_sha256: filed.sha, decision: 'approve', expected_previous_seq: null, proof_kind: 'secret' });
    expect(await activeMandate(db, cycle)).toMatchObject({ cycle_id: cycle, participant_id: PARTICIPANT,
      family_id: PARTICIPANT, epoch: 1 });
    const left = (await db.prepare('SELECT COUNT(*) AS n FROM delegated_approvals WHERE cycle_id = ?1')
      .bind(cycle).first<{ n: number }>())?.n ?? 0;
    expect(left).toBe(0);
    expect(await ownerDecisionRow(filed.requestId)).toEqual({ decision: 'approve', event_seq: result.event.seq });
    expect(await latestOwnerActSeq(db, 'appoint_cycle_coordinator', cycle)).toBe(result.event.seq);
  });

  it('re-nomination : previous_seq = seq du dernier acte de mandat (correction de l’avis seq 688), demande périmée refusée', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    await seedActiveParticipant(PARTICIPANT);
    expect(await latestOwnerActSeq(db, 'appoint_cycle_coordinator', cycle)).toBeNull();
    const first = await fileExecutable(store, 'appoint_cycle_coordinator',
      { cycle_id: cycle, participant_id: PARTICIPANT, family_id: PARTICIPANT, expected_epoch: 0 });
    const firstDone = await approve(first);
    expect(firstDone.status).toBe('applied');
    expect(JSON.parse(firstDone.event.payload_json)).toMatchObject({ epoch: 1, expected_previous_seq: null });
    // Les deux demandes suivantes sont déposées après le premier acte : previous_seq = seq de cet acte.
    const second = await fileExecutable(store, 'appoint_cycle_coordinator',
      { cycle_id: cycle, participant_id: PARTICIPANT, family_id: PARTICIPANT, expected_epoch: 1 });
    const third = await fileExecutable(store, 'appoint_cycle_coordinator',
      { cycle_id: cycle, participant_id: PARTICIPANT, family_id: PARTICIPANT, expected_epoch: 2 });
    const secondDone = await approve(second);
    expect(secondDone.status).toBe('applied');
    expect(JSON.parse(secondDone.event.payload_json)).toMatchObject({ epoch: 2,
      expected_previous_seq: firstDone.event.seq });
    expect(await activeMandate(db, cycle)).toMatchObject({ epoch: 2, participant_id: PARTICIPANT });
    // Déposée avant le deuxième acte, la troisième demande est périmée : OWNER_PRECONDITION_FAILED.
    expect(codeOf(await refusalOf(approve(third)))).toBe('OWNER_PRECONDITION_FAILED');
    expect(await activeMandate(db, cycle)).toMatchObject({ epoch: 2 });
  });

  it('epoch périmé : la garde du lot refuse, le mandat est inchangé', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    await seedActiveParticipant(PARTICIPANT);
    const first = await fileExecutable(store, 'appoint_cycle_coordinator',
      { cycle_id: cycle, participant_id: PARTICIPANT, family_id: PARTICIPANT, expected_epoch: 0 });
    expect((await approve(first)).status).toBe('applied');
    // previous_seq suit (dépôt après l’acte), mais l’epoch attendu est périmé.
    const stale = await fileExecutable(store, 'appoint_cycle_coordinator',
      { cycle_id: cycle, participant_id: PARTICIPANT, family_id: PARTICIPANT, expected_epoch: 0 });
    expect(codeOf(await refusalOf(approve(stale)))).toBe('OWNER_PRECONDITION_FAILED');
    expect(await activeMandate(db, cycle)).toMatchObject({ epoch: 1 });
    expect(await ownerDecisionRow(stale.requestId)).toBeNull();
  });

  it('famille incohérente avec le participant : OWNER_PRECONDITION_FAILED', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    await seedActiveParticipant(PARTICIPANT);
    const filed = await fileExecutable(store, 'appoint_cycle_coordinator',
      { cycle_id: cycle, participant_id: PARTICIPANT, family_id: 'l6-famille-bis', expected_epoch: 0 });
    expect(codeOf(await refusalOf(approve(filed)))).toBe('OWNER_PRECONDITION_FAILED');
    expect(await activeMandate(db, cycle)).toBeNull();
  });

  it('participant non enregistré : OWNER_PRECONDITION_FAILED', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    const filed = await fileExecutable(store, 'appoint_cycle_coordinator',
      { cycle_id: cycle, participant_id: 'l6-fantome', family_id: 'l6-fantome', expected_epoch: 0 });
    expect(codeOf(await refusalOf(approve(filed)))).toBe('OWNER_PRECONDITION_FAILED');
    expect(await activeMandate(db, cycle)).toBeNull();
  });

  it('révocation (vacance) liée : epoch 2, plus de participant', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    await seedActiveParticipant(PARTICIPANT);
    const first = await fileExecutable(store, 'appoint_cycle_coordinator',
      { cycle_id: cycle, participant_id: PARTICIPANT, family_id: PARTICIPANT, expected_epoch: 0 });
    expect((await approve(first)).status).toBe('applied');
    const vacancy = await fileExecutable(store, 'appoint_cycle_coordinator', { cycle_id: cycle, expected_epoch: 1 });
    const result = await approve(vacancy);
    expect(result.status).toBe('applied');
    expect(JSON.parse(result.event.payload_json)).toMatchObject({ participant_id: null, epoch: 2 });
    expect(await activeMandate(db, cycle)).toMatchObject({ participant_id: null, family_id: null, epoch: 2 });
  });

  it('cycle clos : l’approbation liée reçoit CYCLE_CLOSED', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    expect((await closeCycle(db, { cycle_id: cycle, force: true, reason: 'motif suffisant pour forcer',
      confirm: cycle, proof, op: 'form-1' })).status).toBe('applied');
    const filed = await fileExecutable(store, 'appoint_cycle_coordinator', { cycle_id: cycle, expected_epoch: 0 });
    expect(codeOf(await refusalOf(approve(filed)))).toBe('CYCLE_CLOSED');
    expect(await activeMandate(db, cycle)).toBeNull();
  });

  it('previous_seq déclaré alors qu’aucun acte de mandat n’existe : OWNER_PRECONDITION_FAILED', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    const filed = await fileExecutable(store, 'appoint_cycle_coordinator',
      { cycle_id: cycle, participant_id: PARTICIPANT, family_id: PARTICIPANT, expected_epoch: 0 },
      { extra: { preconditions: { previous_seq: 5 } } });
    expect(codeOf(await refusalOf(approve(filed)))).toBe('OWNER_PRECONDITION_FAILED');
    expect(await activeMandate(db, cycle)).toBeNull();
  });
});

describe('CC-Owner V2 — L6 : affichage /owner des demandes exécutables', () => {
  it('describePending : les trois actions s’affichent avec vue exécutable et aperçu JSON', async () => {
    const store = makeStore();
    const cycle = uniq('cyc');
    await openCycle(store, cycle);
    await seedActiveParticipant(PARTICIPANT);
    const targetSeq = await fileRequest(store, cycle, 1, uniq('req'));
    const classifyFiled = await fileExecutable(store, 'classify_request', { request_seq: targetSeq, verdict: 'other' });
    const closeFiled = await fileExecutable(store, 'close_cycle', { cycle_id: cycle });
    const appointFiled = await fileExecutable(store, 'appoint_cycle_coordinator',
      { cycle_id: cycle, participant_id: PARTICIPANT, family_id: PARTICIPANT, expected_epoch: 0 });
    const page = await pendingPage();
    const view = (seq: number) => page.items.find(item => item.seq === seq)?.executable;
    expect(view(classifyFiled.seq)).toMatchObject({ action: 'classify_request', cycle_id: 'request:' + targetSeq,
      target: 'request:' + targetSeq, payload_sha256: classifyFiled.sha, previous_seq: null, expired: false });
    expect(view(classifyFiled.seq)?.preview).toContain('"verdict": "other"');
    expect(view(closeFiled.seq)).toMatchObject({ action: 'close_cycle', cycle_id: cycle, target: cycle,
      payload_sha256: closeFiled.sha, previous_seq: null });
    expect(view(closeFiled.seq)?.preview).toContain('"cycle_id"');
    expect(view(appointFiled.seq)).toMatchObject({ action: 'appoint_cycle_coordinator', cycle_id: cycle, target: cycle,
      payload_sha256: appointFiled.sha, previous_seq: null });
    expect(view(appointFiled.seq)?.preview).toContain('"expected_epoch": 0');
  });
});
