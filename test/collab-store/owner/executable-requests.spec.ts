import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import stateR6 from '../export/fixtures/cc3-state-r6.md?raw';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { opIdClientFor } from '../../../src/collab-store/contracts';
import { listPendingPage } from '../../../src/collab-store/owner/decisions';
import { installPhaseDefinitions } from '../../../src/collab-store/owner/phase-install';
import {
  decideOwnerRequest, describePending, executablePayloadSha256, latestOwnerActSeq, parseOwnerRequest,
} from '../../../src/collab-store/owner/executable';
import { registerCc3 } from '../export/helpers';
import { createOAuthFixture } from '../../oauth/helpers';

// CC-4 A2 (github-mcp#113, plan §8) — demandes owner exécutables : l'agent prépare,
// le propriétaire approuve ; l'acte EXACT est exécuté avec la décision dans le même lot,
// ou rien du tout (empreinte, précondition, expiration, double soumission).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
const AGENT = 'agent:a';
let n = 0;
const uniq = (label: string) => `a2x-${label}-${Date.now().toString(36)}-${++n}`;

type Action = 'install_phases' | 'import_state';

/** Dépose une demande exécutable comme le ferait un agent ; renvoie sa seq. */
async function fileExecutable(target: string, action: Action, params: Record<string, unknown>,
  extra: Record<string, unknown> = {}, sha?: string): Promise<{ seq: number; requestId: string; sha: string; requestCycle: string }> {
  const store = new CollabStore(db);
  const requestCycle = uniq('req-cycle');
  const requestId = uniq('req').slice(0, 60);
  const payloadSha = sha ?? await executablePayloadSha256(action, params);
  const payload = {
    request_id: requestId, summary: 'Demande préparée par ' + AGENT, action, params, payload_sha256: payloadSha,
    preconditions: { previous_seq: await latestOwnerActSeq(db, action, target) },
    reason: 'Lancer le cycle sans copier-coller', risk: 'Remplace l’ensemble courant', rollback: 'Redéposer l’ensemble précédent',
    ...extra,
  };
  const outcome = await store.appendEvent({ cycle_id: requestCycle, type: 'owner.request', participant_id: AGENT, expected_rev: 0,
    op_id: opIdClientFor(AGENT) + ':' + requestCycle + ':req:1', payload_json: JSON.stringify(payload) });
  if (outcome.status !== 'applied') throw new Error('demande non déposée');
  return { seq: outcome.event.seq, requestId, sha: payloadSha, requestCycle };
}

async function phaseRows(cycle: string) {
  await ensureSchema(db);
  return (await db.prepare('SELECT phase, auto_advance FROM phase_definitions WHERE cycle_id = ?1 ORDER BY phase')
    .bind(cycle).all<{ phase: string; auto_advance: string }>()).results;
}

async function decisionRow(requestId: string) {
  return db.prepare('SELECT decision, event_seq FROM owner_decisions WHERE request_id = ?1').bind(requestId)
    .first<{ decision: string; event_seq: number }>();
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as { code: string }).code; }
  return 'NO_ERROR';
}

const PHASES = JSON.stringify([{ phase: 'P1', auto_advance: 'a2-p1-to-p2', expected_outputs: [{ role: 'author', kind: 'proposal.submit', count: 2 }] }, { phase: 'P2' }]);

describe('CC-4 A2 — demandes owner exécutables (install_phases)', () => {
  it('approuver exécute exactement le payload affiché, décision et acte dans UN seul événement', async () => {
    const target = uniq('target');
    const req = await fileExecutable(target, 'install_phases', { cycle_id: target, definitions: PHASES });
    const page = await describePending(await listPendingPage(db, { limit: 500 }));
    const shown = page.items.find(item => item.seq === req.seq)!;
    expect(shown.executable).toMatchObject({ action: 'install_phases', cycle_id: target, payload_sha256: req.sha, previous_seq: null, expired: false });
    expect(shown.executable?.preview).toContain('a2-p1-to-p2');

    const result = await decideOwnerRequest(db, { request_id: req.requestId, decision: 'approve', proof,
      request_seq: req.seq, payload_sha256: shown.executable!.payload_sha256 });
    expect(result).toMatchObject({ status: 'applied', decision: 'approve', executed: { action: 'install_phases', cycle_id: target } });
    expect(await phaseRows(target)).toEqual([{ phase: 'P1', auto_advance: 'a2-p1-to-p2' }, { phase: 'P2', auto_advance: 'none' }]);
    expect(JSON.parse(result.event.payload_json)).toMatchObject({ action: 'install_phases', request_id: req.requestId,
      request_seq: req.seq, payload_sha256: req.sha, decision: 'approve', proof_kind: 'secret' });
    expect(await decisionRow(req.requestId)).toEqual({ decision: 'approve', event_seq: result.event.seq });
    const after = await listPendingPage(db, { limit: 500 });
    expect(after.items.some(item => item.seq === req.seq)).toBe(false);
  });

  it('empreinte affichée ≠ empreinte de la demande : REQUEST_MISMATCH, aucun effet', async () => {
    const target = uniq('mismatch');
    const req = await fileExecutable(target, 'install_phases', { cycle_id: target, definitions: PHASES });
    expect(await codeOf(decideOwnerRequest(db, { request_id: req.requestId, decision: 'approve', proof, request_seq: req.seq,
      payload_sha256: 'f'.repeat(64) }))).toBe('REQUEST_MISMATCH');
    expect(await codeOf(decideOwnerRequest(db, { request_id: req.requestId, decision: 'approve', proof, request_seq: req.seq })))
      .toBe('REQUEST_MISMATCH');
    expect(await phaseRows(target)).toEqual([]);
    expect(await decisionRow(req.requestId)).toBeNull();
  });

  it('payload modifié par rapport à son empreinte déclarée : invalide, non approuvable, aucun effet', async () => {
    const target = uniq('forged');
    const declared = await executablePayloadSha256('install_phases', { cycle_id: target, definitions: '[]' });
    const req = await fileExecutable(target, 'install_phases', { cycle_id: target, definitions: PHASES }, {}, declared);
    const page = await describePending(await listPendingPage(db, { limit: 500 }));
    expect(page.items.find(item => item.seq === req.seq)?.executable?.invalid).toContain('payload_sha256');
    expect(await codeOf(decideOwnerRequest(db, { request_id: req.requestId, decision: 'approve', proof, request_seq: req.seq,
      payload_sha256: declared }))).toBe('EXECUTABLE_REQUEST_INVALID');
    expect(await phaseRows(target)).toEqual([]);
    // Elle reste refusable.
    expect((await decideOwnerRequest(db, { request_id: req.requestId, decision: 'deny', proof, request_seq: req.seq })).decision).toBe('deny');
  });

  it('précondition périmée (acte du même type survenu depuis le dépôt) : OWNER_PRECONDITION_FAILED, aucun effet', async () => {
    const target = uniq('stale');
    const req = await fileExecutable(target, 'install_phases', { cycle_id: target, definitions: PHASES });
    await installPhaseDefinitions(db, { cycle_id: target, definitions: JSON.stringify([{ phase: 'P1' }]), proof });
    expect(await codeOf(decideOwnerRequest(db, { request_id: req.requestId, decision: 'approve', proof, request_seq: req.seq,
      payload_sha256: req.sha }))).toBe('OWNER_PRECONDITION_FAILED');
    expect(await phaseRows(target)).toEqual([{ phase: 'P1', auto_advance: 'none' }]);
    expect(await decisionRow(req.requestId)).toBeNull();
  });

  it('refus ou expiration : aucun effet ; une demande expirée n’est pas approuvable', async () => {
    const denied = uniq('deny');
    const req = await fileExecutable(denied, 'install_phases', { cycle_id: denied, definitions: PHASES });
    const result = await decideOwnerRequest(db, { request_id: req.requestId, decision: 'deny', proof, request_seq: req.seq });
    expect(result.decision).toBe('deny');
    expect(await phaseRows(denied)).toEqual([]);
    expect(await codeOf(decideOwnerRequest(db, { request_id: req.requestId, decision: 'approve', proof, request_seq: req.seq,
      payload_sha256: req.sha }))).toBe('NO_ERROR'); // déjà tranché : le rejeu renvoie la décision existante (deny)…
    expect(await phaseRows(denied)).toEqual([]); // …et n'exécute rien.

    const expired = uniq('expired');
    const late = await fileExecutable(expired, 'install_phases', { cycle_id: expired, definitions: PHASES }, { expires_at: 1_700_000_000 });
    const page = await describePending(await listPendingPage(db, { limit: 500 }));
    expect(page.items.find(item => item.seq === late.seq)?.executable?.expired).toBe(true);
    expect(await codeOf(decideOwnerRequest(db, { request_id: late.requestId, decision: 'approve', proof, request_seq: late.seq,
      payload_sha256: late.sha }))).toBe('REQUEST_EXPIRED');
    expect(await phaseRows(expired)).toEqual([]);
  });

  it('double soumission du formulaire : idempotente, une seule exécution', async () => {
    const target = uniq('double');
    const req = await fileExecutable(target, 'install_phases', { cycle_id: target, definitions: PHASES });
    const input = { request_id: req.requestId, decision: 'approve', proof, request_seq: req.seq, payload_sha256: req.sha };
    const first = await decideOwnerRequest(db, input);
    const second = await decideOwnerRequest(db, input);
    expect(second).toMatchObject({ status: 'duplicate', decision: 'approve', event: { seq: first.event.seq } });
    const installs = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'owner.decision'")
      .bind(target).first<{ n: number }>();
    expect(installs?.n).toBe(1);
    // Un refus après l'approbation exécutée est refusé, rien n'est écrit.
    expect(await codeOf(decideOwnerRequest(db, { request_id: req.requestId, decision: 'deny', proof, request_seq: req.seq })))
      .toBe('ALREADY_DECIDED');
  });

  it('parseOwnerRequest : demande simple inchangée, champs obligatoires vérifiés', async () => {
    expect(await parseOwnerRequest('{"request_id":"r1","summary":"waiver"}')).toEqual({ kind: 'plain' });
    const params = { cycle_id: 'c1', definitions: '' };
    const sha = await executablePayloadSha256('install_phases', params);
    const missingRisk = await parseOwnerRequest(JSON.stringify({ request_id: 'r2', action: 'install_phases', params, payload_sha256: sha,
      preconditions: { previous_seq: null }, reason: 'x', rollback: 'y' }));
    expect(missingRisk).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('risk') });
    const unknown = await parseOwnerRequest(JSON.stringify({ request_id: 'r3', action: 'merge_main', params }));
    expect(unknown.kind).toBe('invalid');
  });
});

describe('CC-4 A2 — demandes owner exécutables (import_state)', () => {
  it('approuver importe l’état exact de la demande, avec la décision liée', async () => {
    await registerCc3(db, uniq('reg'));
    const target = uniq('import');
    const params = { cycle_id: target, markdown: stateR6, owner_label: 'Kevin' };
    const req = await fileExecutable(target, 'import_state', params);
    const result = await decideOwnerRequest(db, { request_id: req.requestId, decision: 'approve', proof, request_seq: req.seq,
      payload_sha256: req.sha });
    expect(result).toMatchObject({ status: 'applied', decision: 'approve', executed: { action: 'import_state', cycle_id: target } });
    const tasks = await db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE cycle_id = ?1').bind(target).first<{ n: number }>();
    expect(tasks?.n).toBeGreaterThan(0);
    expect(JSON.parse(result.event.payload_json)).toMatchObject({ action: 'import_state', request_id: req.requestId, request_seq: req.seq });
    expect(await decisionRow(req.requestId)).toEqual({ decision: 'approve', event_seq: result.event.seq });
  });
});

describe('CC-4 A2 — /owner : la demande préparée s’affiche et s’approuve sans copier-coller (HTTP)', () => {
  const SECRET = 'owner-secret-A2-EXEC-0123456789abcdefghij';
  const fixture = () => createOAuthFixture({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true', OWNER_AUTH_MODE: 'secret', OWNER_SECRET: SECRET });
  const post = (fx: ReturnType<typeof createOAuthFixture>, fields: Record<string, string>) =>
    fx.send('/owner', { method: 'POST', headers: { Origin: fx.ORIGIN }, body: new URLSearchParams(fields) });

  it('détail lisible + empreinte dans le formulaire ; Approuver exécute l’acte ; le secret n’est jamais renvoyé', async () => {
    const fx = fixture();
    const target = uniq('http');
    const req = await fileExecutable(target, 'install_phases', { cycle_id: target, definitions: PHASES });
    const view = await (await post(fx, { action: 'view', owner_secret: SECRET })).text();
    expect(view).toContain('Installer les définitions de phase');
    expect(view).toContain('Lancer le cycle sans copier-coller');
    expect(view).toContain('name="payload_sha256" value="' + req.sha + '"');
    expect(view).not.toContain(SECRET);

    const decided = await post(fx, { action: 'decide', request_id: req.requestId, request_seq: String(req.seq),
      cycle_id: req.requestCycle, payload_sha256: req.sha, decision: 'approve', owner_secret: SECRET });
    expect(decided.status).toBe(200);
    const body = await decided.text();
    expect(body).toContain('Exécuté : install_phases sur ' + target);
    expect(body).not.toContain(SECRET);
    expect(await phaseRows(target)).toEqual([{ phase: 'P1', auto_advance: 'a2-p1-to-p2' }, { phase: 'P2', auto_advance: 'none' }]);
  });
});
