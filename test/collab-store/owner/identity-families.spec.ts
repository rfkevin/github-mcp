import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import stateR6 from '../export/fixtures/cc3-state-r6.md?raw';
import { CollabStore, CollabStoreError } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { opIdClientFor } from '../../../src/collab-store/contracts';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { decideOwnerRequest, executablePayloadSha256, latestOwnerActSeq } from '../../../src/collab-store/owner/executable';
import { isCoordinator } from '../../../src/collab-store/owner/coordinators';
import { logicalIdentityOf, listIdentityFamilies } from '../../../src/collab-store/identity/families';
import { authorizePhaseAdvance } from '../../../src/collab-store/identity/guard';
import { buildLabelDirectory } from '../../../src/collab-store/export/labels';
import { planStateImport } from '../../../src/collab-store/export/state-import-plan';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const uniq = (label: string) => (label + '-' + (++n) + '-' + Date.now().toString(36)).slice(0, 60);

async function register(pid: string, label = pid): Promise<void> {
  await registerParticipant(db, { participant_id: pid, display_label: label, proof, op: uniq('reg') });
}

async function configureFamily(familyId: string, members: string[]): Promise<number> {
  const action = 'set_identity_family' as const;
  const params = { family_id: familyId, members };
  const sha = await executablePayloadSha256(action, params);
  const requestCycle = uniq('family-request');
  const requestId = uniq('family-req');
  const store = new CollabStore(db);
  const outcome = await store.appendEvent({
    cycle_id: requestCycle,
    type: 'owner.request',
    participant_id: members[0] ?? 'agent:a',
    expected_rev: 0,
    op_id: opIdClientFor(members[0] ?? 'agent:a') + ':' + requestCycle + ':req:1',
    payload_json: JSON.stringify({
      request_id: requestId,
      summary: 'Configurer une identité logique commune',
      action,
      params,
      payload_sha256: sha,
      preconditions: { previous_seq: await latestOwnerActSeq(db, action, familyId) },
      reason: 'Un même client peut changer de modèle sans devenir un pair D12 distinct.',
      risk: 'Les membres partagent les droits de reprise et comptent comme une seule identité D12.',
      rollback: 'Redéposer la même action avec members vide.',
      max_cost_cents: 0,
    }),
  });
  if (outcome.status !== 'applied') throw new Error('owner.request non appliquée');
  const decided = await decideOwnerRequest(db, {
    request_id: requestId,
    request_seq: outcome.event.seq,
    cycle_id: requestCycle,
    payload_sha256: sha,
    decision: 'approve',
    proof,
  });
  return decided.event.seq;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as { code?: string }).code ?? 'UNKNOWN'; }
  return 'NO_ERROR';
}

describe('CC-4 #126 — famille d’identité ChatGPT', () => {
  it('garde les ids historiques mais leur donne une identité logique commune via acte owner exact-hash', async () => {
    const tag = uniq('keep');
    const gpt = 'gpt6-' + tag;
    const sol = 'sol-' + tag;
    const family = 'chatgpt-' + tag;
    await register(gpt, 'GPT historique');
    await register(sol, 'Sol historique');
    const historyCycle = uniq('history');
    const store = new CollabStore(db);
    await store.appendEvent({ cycle_id: historyCycle, type: 'checkpoint', participant_id: gpt, expected_rev: 0,
      op_id: opIdClientFor(gpt) + ':' + historyCycle + ':cp:1', payload_json: '{}' });

    const seq = await configureFamily(family, [gpt, sol]);
    expect(await logicalIdentityOf(db, gpt)).toBe(family);
    expect(await logicalIdentityOf(db, sol)).toBe(family);
    expect(await listIdentityFamilies(db)).toEqual(expect.arrayContaining([
      expect.objectContaining({ family_id: family, members: [gpt, sol], event_seq: seq }),
    ]));
    const historical = await db.prepare('SELECT participant_id FROM events WHERE cycle_id = ?1 ORDER BY seq')
      .bind(historyCycle).all<{ participant_id: string }>();
    expect(historical.results).toEqual([{ participant_id: gpt }]);
    expect(await db.prepare('SELECT participant_id FROM participants WHERE participant_id IN (?1, ?2) ORDER BY participant_id')
      .bind(gpt, sol).all<{ participant_id: string }>()).toMatchObject({ results: [{ participant_id: gpt }, { participant_id: sol }] });
  });

  it('Sol reprend une tâche GPT, voit son contexte et hérite du grant coordinateur, sans devenir un pair D12', async () => {
    const tag = uniq('roles');
    const gpt = 'gpt6-' + tag;
    const sol = 'sol-' + tag;
    const grok = 'grok-' + tag;
    const vibe = 'vibe-' + tag;
    const family = 'chatgpt-' + tag;
    for (const pid of [gpt, sol, grok, vibe]) await register(pid);
    await configureFamily(family, [gpt, sol]);
    const store = new CollabStore(db);
    const cycle = uniq('task');
    const taskId = 'task' + n;
    const claim = await store.appendEvent({
      cycle_id: cycle, type: 'task.claim', participant_id: gpt, expected_rev: 0,
      op_id: opIdClientFor(gpt) + ':' + cycle + ':claim:1',
      payload_json: JSON.stringify({ task: { task_id: taskId, owner_pid: gpt, reviewer_pid: grok, tester_pid: vibe } }),
    });
    expect(claim.status).toBe('applied');
    const status = await store.appendEvent({
      cycle_id: cycle, type: 'task.status', participant_id: sol, expected_rev: 1,
      op_id: opIdClientFor(sol) + ':' + cycle + ':status:1',
      payload_json: JSON.stringify({ task: { task_id: taskId, status: 'review' } }),
    });
    expect(status.status).toBe('applied');
    expect((await store.getContext(cycle, sol)).tasks.map(task => task.task_id)).toContain(taskId);
    expect(await authorizePhaseAdvance(db, { status: 'registered', participant_id: sol, display_label: 'Sol', client_id: 'x' }, cycle))
      .toBe(sol);

    await ensureSchema(db);
    await db.prepare("INSERT INTO coordinators (participant_id, status, event_seq, updated_at) VALUES (?1, 'active', NULL, 1)")
      .bind(gpt).run();
    expect(await isCoordinator(db, sol)).toBe(true);

    const badCycle = uniq('d12');
    expect(await codeOf(store.appendEvent({
      cycle_id: badCycle, type: 'task.claim', participant_id: gpt, expected_rev: 0,
      op_id: opIdClientFor(gpt) + ':' + badCycle + ':claim:1',
      payload_json: JSON.stringify({ task: { task_id: 'bad' + n, owner_pid: gpt, reviewer_pid: sol, tester_pid: vibe } }),
    }))).toBe('DUPLICATE_LOGICAL_IDENTITY');
  });

  it('gpt6 puis sol ne peuvent pas produire deux propositions dans la même ronde logique', async () => {
    const tag = uniq('proposal');
    const gpt = 'gpt6-' + tag;
    const sol = 'sol-' + tag;
    const family = 'chatgpt-' + tag;
    await register(gpt);
    await register(sol);
    await configureFamily(family, [gpt, sol]);
    const store = new CollabStore(db);
    const cycle = uniq('round');
    expect((await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: gpt, expected_rev: 0,
      op_id: opIdClientFor(gpt) + ':' + cycle + ':cp:1', payload_json: '{}' })).status).toBe('applied');
    expect((await store.appendEvent({ cycle_id: cycle, type: 'proposal.submit', participant_id: gpt, expected_rev: 1,
      op_id: opIdClientFor(gpt) + ':' + cycle + ':prop:1', payload_json: JSON.stringify({ content: 'première' }) })).status).toBe('applied');
    expect(await codeOf(store.appendEvent({ cycle_id: cycle, type: 'proposal.submit', participant_id: sol, expected_rev: 2,
      op_id: opIdClientFor(sol) + ':' + cycle + ':prop:1', payload_json: JSON.stringify({ content: 'seconde' }) })))
      .toBe('PROPOSAL_ALREADY_SUBMITTED');
  });

  it('l’import CC-STATE-1 refuse deux rôles appartenant à la même identité logique', async () => {
    const modified = stateR6.replaceAll('GPT-5.6 Sol', 'Agent G').replaceAll('Claude', 'Agent S');
    const directory = buildLabelDirectory([
      { participant_id: 'pid-g', display_label: 'Agent G' },
      { participant_id: 'pid-s', display_label: 'Agent S' },
      { participant_id: 'muse', display_label: 'Muse Spark' },
      { participant_id: 'vibe', display_label: 'Vibe GLM' },
      { participant_id: 'grok', display_label: 'Grok' },
    ], 'Kevin', new Map([['pid-g', 'chatgpt'], ['pid-s', 'chatgpt']]));
    expect(await codeOf(planStateImport({ cycle_id: uniq('import'), markdown: modified, directory, target: null })))
      .toBe('IMPORT_DUPLICATE_ROLE');
  });
});
