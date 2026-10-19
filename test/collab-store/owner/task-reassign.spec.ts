import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { opIdClientFor } from '../../../src/collab-store/contracts';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { decideOwnerRequest, executablePayloadSha256, latestOwnerActSeq, parseOwnerRequest } from '../../../src/collab-store/owner/executable';
import { reassignTask } from '../../../src/collab-store/owner/task-reassign';
import { previewNextActions } from '../../../src/collab-store/controller';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

// CC-5 l3d (incrément 2b-2c) — réattribution d'une tâche, acte owner exécutable approuvé sur /owner.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const uniq = (label: string) => (label + '-' + (++n) + '-' + Date.now().toString(36)).slice(0, 60);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as { code?: string }).code ?? 'UNKNOWN'; }
  return 'NO_ERROR';
}

interface World { cycle: string; a: string; b: string; c: string; d: string }

/** Cycle avec une tâche t0 (auteur a, relecteur b, testeur c) et un quatrième participant d. */
async function world(): Promise<World> {
  await ensureSchema(db);
  const tag = uniq('w');
  const [a, b, c, d] = ['ra', 'rb', 'rc', 'rd'].map(p => p + '-' + tag);
  for (const pid of [a, b, c, d]) await registerParticipant(db, { participant_id: pid, display_label: pid, proof, op: uniq('reg') });
  const cycle = uniq('reassign');
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: 't0', cycle, owner: a, reviewer: b, tester: c });
  return { cycle, a, b, c, d };
}

async function taskRow(cycle: string) {
  return db.prepare('SELECT owner_pid, reviewer_pid, tester_pid, revision FROM tasks WHERE cycle_id = ?1 AND task_id = ?2')
    .bind(cycle, 't0').first<{ owner_pid: string; reviewer_pid: string; tester_pid: string; revision: number }>();
}

/** Dépose une demande reassign_task (dans un cycle de demandes séparé) ; renvoie de quoi l'approuver. */
async function fileRequest(w: World, roles: { owner_pid: string; reviewer_pid: string; tester_pid: string }, extra: Record<string, unknown> = {}) {
  const action = 'reassign_task' as const;
  const revision = (await taskRow(w.cycle))!.revision;
  const params = { cycle_id: w.cycle, task_id: 't0', ...roles, expected_revision: revision, ...extra };
  const sha = await executablePayloadSha256(action, params);
  const requestCycle = uniq('req-cycle');
  const requestId = uniq('req');
  const outcome = await new CollabStore(db).appendEvent({
    cycle_id: requestCycle, type: 'owner.request', participant_id: w.a, expected_rev: 0,
    op_id: opIdClientFor(w.a) + ':' + requestCycle + ':req:1',
    payload_json: JSON.stringify({
      request_id: requestId, summary: 'Réattribuer t0', action, params, payload_sha256: sha,
      preconditions: { previous_seq: await latestOwnerActSeq(db, action, w.cycle + '/t0') },
      reason: 'Auteur indisponible.', risk: 'Les verdicts déjà rendus restent attachés à leur couple SHA.', rollback: 'Réattribuer à nouveau.',
      max_cost_cents: 0,
    }),
  });
  if (outcome.status !== 'applied') throw new Error('owner.request non appliquée');
  return { requestId, sha, seq: outcome.event.seq, requestCycle };
}

const approve = (req: { requestId: string; sha: string; seq: number; requestCycle: string }) =>
  decideOwnerRequest(db, { request_id: req.requestId, request_seq: req.seq, cycle_id: req.requestCycle, payload_sha256: req.sha, decision: 'approve', proof });

describe('CC-5 l3d 2b-2c — reassign_task (demande exécutable)', () => {
  it('approuvée : rôles remplacés, révision de la tâche = révision du cycle, décision et détail lisibles', async () => {
    const w = await world();
    const req = await fileRequest(w, { owner_pid: w.d, reviewer_pid: w.b, tester_pid: w.c });
    const outcome = await approve(req);
    expect(outcome).toMatchObject({ status: 'applied', decision: 'approve', executed: { action: 'reassign_task', cycle_id: w.cycle } });
    expect(outcome.executed!.detail).toContain(w.a + ' / ' + w.b + ' / ' + w.c + ' → ' + w.d + ' / ' + w.b + ' / ' + w.c);
    const row = await taskRow(w.cycle);
    expect(row).toMatchObject({ owner_pid: w.d, reviewer_pid: w.b, tester_pid: w.c });
    const cycleRev = (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(w.cycle).first<{ revision: number }>())!.revision;
    expect(row!.revision).toBe(cycleRev);
    const payload = JSON.parse(outcome.event.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({ action: 'reassign_task', task_id: 't0', from: { owner_pid: w.a }, to: { owner_pid: w.d }, request_id: req.requestId });
    expect(await approve(req)).toMatchObject({ status: 'duplicate' }); // double soumission du formulaire
  });

  it('le contrôleur réarme le réveil pour le nouvel auteur', async () => {
    const w = await world();
    expect((await previewNextActions(db, w.cycle, w.a)).mine).toEqual([expect.objectContaining({ action: 'implement', task_id: 't0' })]);
    await approve(await fileRequest(w, { owner_pid: w.d, reviewer_pid: w.b, tester_pid: w.c }));
    expect((await previewNextActions(db, w.cycle, w.a)).mine).toEqual([]);
    expect((await previewNextActions(db, w.cycle, w.d)).mine).toEqual([expect.objectContaining({ action: 'implement', task_id: 't0' })]);
  });

  it('révision de la tâche changée depuis le dépôt : refus, aucun effet', async () => {
    const w = await world();
    const req = await fileRequest(w, { owner_pid: w.d, reviewer_pid: w.b, tester_pid: w.c });
    await db.prepare("UPDATE tasks SET revision = revision + 7 WHERE cycle_id = ?1 AND task_id = 't0'").bind(w.cycle).run();
    expect(await codeOf(approve(req))).toBe('OWNER_PRECONDITION_FAILED');
    expect(await taskRow(w.cycle)).toMatchObject({ owner_pid: w.a });
  });

  it('course : rôles changés entre les vérifications et le lot d\'écriture → garde SQL, aucun effet', async () => {
    const w = await world();
    const req = await fileRequest(w, { owner_pid: w.d, reviewer_pid: w.b, tester_pid: w.c });
    let armed = false; // armé seulement après l'amorçage du schéma : la course vise le lot d'écriture
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (armed) {
              armed = false; // handoff concurrent, même révision : seuls les rôles changent
              await target.prepare("UPDATE tasks SET owner_pid = ?2 WHERE cycle_id = ?1 AND task_id = 't0'").bind(w.cycle, w.c).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await ensureSchema(racing);
    armed = true;
    const code = await codeOf(reassignTask(racing, { params: { cycle_id: w.cycle, task_id: 't0', owner_pid: w.d, reviewer_pid: w.b, tester_pid: w.a,
      expected_revision: 1 }, proof, binding: { request_id: req.requestId, request_seq: req.seq, payload_sha256: req.sha, expected_previous_seq: null } }));
    expect(code).toBe('OWNER_PRECONDITION_FAILED');
    expect(await taskRow(w.cycle)).toMatchObject({ owner_pid: w.c, reviewer_pid: w.b, tester_pid: w.c });
  });

  it('D12 : rôles en double → demande invalide, non approuvable', async () => {
    const w = await world();
    const params = { cycle_id: w.cycle, task_id: 't0', owner_pid: w.b, reviewer_pid: w.b, tester_pid: w.c, expected_revision: 1 };
    const parsed = await parseOwnerRequest(JSON.stringify({ request_id: 'x', action: 'reassign_task', params,
      payload_sha256: await executablePayloadSha256('reassign_task', params), preconditions: { previous_seq: null },
      reason: 'r', risk: 'r', rollback: 'r' }));
    expect(parsed).toMatchObject({ kind: 'invalid' });
  });

  it('D12 logique : deux membres d\'une même famille → refus à l\'approbation', async () => {
    const w = await world();
    await db.prepare('INSERT INTO participant_identity_families (participant_id, family_id, event_seq, updated_at) VALUES (?1, ?2, NULL, 0), (?3, ?2, NULL, 0)')
      .bind(w.d, 'fam-' + w.cycle, w.b).run();
    const req = await fileRequest(w, { owner_pid: w.d, reviewer_pid: w.b, tester_pid: w.c });
    expect(await codeOf(approve(req))).toBe('DUPLICATE_LOGICAL_IDENTITY');
    expect(await taskRow(w.cycle)).toMatchObject({ owner_pid: w.a });
  });

  it('participant non enregistré → refus', async () => {
    const w = await world();
    const req = await fileRequest(w, { owner_pid: 'ghost-' + w.cycle, reviewer_pid: w.b, tester_pid: w.c });
    expect(await codeOf(approve(req))).toBe('UNREGISTERED_PARTICIPANT');
  });

  it('tâche terminée → refus', async () => {
    const w = await world();
    await db.prepare("UPDATE tasks SET status = 'done' WHERE cycle_id = ?1 AND task_id = 't0'").bind(w.cycle).run();
    const req = await fileRequest(w, { owner_pid: w.d, reviewer_pid: w.b, tester_pid: w.c });
    expect(await codeOf(approve(req))).toBe('TASK_CLOSED');
  });

  it('précondition previous_seq : deux demandes concurrentes, seule la première s\'exécute', async () => {
    const w = await world();
    const first = await fileRequest(w, { owner_pid: w.d, reviewer_pid: w.b, tester_pid: w.c });
    const second = await fileRequest(w, { owner_pid: w.a, reviewer_pid: w.d, tester_pid: w.c });
    await approve(first);
    expect(await codeOf(approve(second))).toBe('OWNER_PRECONDITION_FAILED');
    expect(await taskRow(w.cycle)).toMatchObject({ owner_pid: w.d, reviewer_pid: w.b });
  });

  it('champ inconnu → demande invalide ; preuve déléguée → DELEGATED_FORBIDDEN', async () => {
    const w = await world();
    const params = { cycle_id: w.cycle, task_id: 't0', owner_pid: w.d, reviewer_pid: w.b, tester_pid: w.c, expected_revision: 1, status: 'done' };
    expect(await parseOwnerRequest(JSON.stringify({ request_id: 'x', action: 'reassign_task', params,
      payload_sha256: await executablePayloadSha256('reassign_task', params), preconditions: { previous_seq: null },
      reason: 'r', risk: 'r', rollback: 'r' }))).toMatchObject({ kind: 'invalid' });
    const delegated = { kind: 'delegated', subject: w.a, cycle_id: w.cycle } as unknown as typeof proof;
    expect(await codeOf(reassignTask(db, { params: { cycle_id: w.cycle, task_id: 't0', owner_pid: w.d, reviewer_pid: w.b, tester_pid: w.c, expected_revision: 1 },
      proof: delegated, binding: { request_id: 'x', request_seq: 1, payload_sha256: 'a'.repeat(64), expected_previous_seq: null } }))).toBe('DELEGATED_FORBIDDEN');
    expect(await taskRow(w.cycle)).toMatchObject({ owner_pid: w.a });
  });
});
