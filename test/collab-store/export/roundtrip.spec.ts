import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import stateR6 from './fixtures/cc3-state-r6.md?raw';
import { deriveTaskContext, parseWorkflowState, taskRecords } from '../../../src/collab/state';
import { canonicalState, sha256Hex } from '../../../src/collab-store/export/document';
import { exportCycleState } from '../../../src/collab-store/export/state-export';
import { recordOwnerDecision } from '../../../src/collab-store/owner/decisions';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { importState, registerCc3 } from './helpers';

// CC-3 C6 — R1 (l'export passe le parser L1), R2 (export → import → export stable),
// critère de sortie 7 (instantané fusionnable, restauration prouvée par hash).
const bindings = env as unknown as { COLLAB_DB_C2: D1Database; COLLAB_DB_C6_RESTORE: D1Database };
const db = bindings.COLLAB_DB_C2;
const restore = bindings.COLLAB_DB_C6_RESTORE;
let n = 0;
const uniq = (label: string) => 'c6-' + label + '-' + (++n);

beforeAll(async () => {
  await ensureSchema(db);
  await registerCc3(db, 'c6-roundtrip');
});

async function append(store: CollabStore, cycle: string, participant: string, type: string, payload: unknown, op: string) {
  const outcome = await store.appendEvent({
    cycle_id: cycle, type: type as never, participant_id: participant,
    expected_rev: await store.currentRevision(cycle), op_id: participant + ':' + cycle + ':' + op + ':1',
    payload_json: JSON.stringify(payload),
  });
  expect(outcome.status, JSON.stringify(outcome)).toBe('applied');
  return outcome;
}

describe('CC-3 C6 — export CC-STATE-1', () => {
  it('sans changement depuis l’import, l’export est l’état importé, octet pour octet (R1)', async () => {
    const cycle = uniq('same');
    const imported = await importState(db, cycle, stateR6);
    expect(imported.status).toBe('applied');
    expect(imported.tasks).toBe(11);
    const exported = await exportCycleState(db, cycle);
    expect(exported.content).toBe(canonicalState(stateR6));
    expect(exported.changed).toBe(false);
    expect(exported.state_revision).toBe(6);
    expect(exported.content_sha256).toBe(imported.content_sha256);
    expect(exported.content_sha256).toBe(await sha256Hex(exported.content));
    parseWorkflowState(exported.content);
  });

  it('l’import matérialise phase et tâches avec des identités serveur (I8), annotations comprises', async () => {
    const cycle = uniq('rows');
    await importState(db, cycle, stateR6);
    const rows = (await db.prepare('SELECT task_id, owner_pid, reviewer_pid, tester_pid, status FROM tasks WHERE cycle_id = ?1 ORDER BY task_id')
      .bind(cycle).all<Record<string, string>>()).results;
    const byId = Object.fromEntries(rows.map(row => [row.task_id, row]));
    expect(byId.C3).toMatchObject({ owner_pid: 'sol', reviewer_pid: 'claude', tester_pid: 'vibe', status: 'review' });
    expect(byId.C2).toMatchObject({ owner_pid: 'vibe', reviewer_pid: 'claude', tester_pid: 'grok' });
    expect(byId.T0).toMatchObject({ owner_pid: 'owner', reviewer_pid: 'claude', tester_pid: '' });
    expect((await db.prepare('SELECT phase FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ phase: string }>())?.phase).toBe('P5');
  });

  it('refuse fail-closed un libellé sans participant enregistré (K6 d’abord)', async () => {
    await expect(importState(db, uniq('unknown'), stateR6.replace('| C4 | in_progress | Grok |', '| C4 | in_progress | Inconnu |')))
      .rejects.toMatchObject({ code: 'IMPORT_UNKNOWN_PARTICIPANT' });
  });

  it('superpose les écritures du store : révision N+1 sur base N, validée par le parser L1', async () => {
    const cycle = uniq('live');
    await importState(db, cycle, stateR6);
    const store = new CollabStore(db, { dailyWriteLimit: 100_000, now: () => new Date('2026-10-08T09:00:00Z') });
    await append(store, cycle, 'sol', 'task.status', { task: { task_id: 'C3', status: 'verified' } }, 'c3-status');
    await append(store, cycle, 'grok', 'task.claim',
      { task: { task_id: 'C8', owner_pid: 'grok', reviewer_pid: 'claude', tester_pid: 'vibe', owned_paths: ['src/x/'], next_action: 'start | now\nplease' } }, 'c8-claim');
    await append(store, cycle, 'vibe', 'evidence.add', { source: 'github-mcp#70 test', state: 'PASS at 779402e' }, 'c3-test');
    await append(store, cycle, 'sol', 'proposal.submit', { content: 'secret-plan' }, 'proposal');
    await append(store, cycle, 'sol', 'owner.request', { request_id: 'c6-req-' + n, summary: 'merge C3' }, 'request');
    await recordOwnerDecision(db, { request_id: 'c6-req-' + n, decision: 'approve',
      proof: { kind: 'secret', subject: 'owner-secret' }, now: () => new Date('2026-10-08T09:30:00Z') });

    const exported = await exportCycleState(db, cycle);
    expect(exported.changed).toBe(true);
    expect(exported.state_revision).toBe(7);
    expect(exported.base_revision).toBe(6);
    expect(exported.changes).toEqual({ phase: false, tasks: ['C3', 'C8'], owner_decisions: 1, evidence: 1 });
    const snapshot = parseWorkflowState(exported.content);
    expect(snapshot.headers.revision).toBe('7');
    expect(snapshot.headers.base_revision).toBe('6');
    const tasks = Object.fromEntries(taskRecords(snapshot).map(task => [task.id, task]));
    const before = Object.fromEntries(taskRecords(parseWorkflowState(stateR6)).map(task => [task.id, task]));
    expect(tasks.C3).toEqual({ ...before.C3, status: 'verified' });
    expect(tasks.C3).toMatchObject({ reviewer: 'Claude (for Muse Spark)', tester: 'Vibe GLM' });
    for (const id of ['C0', 'C1', 'C2', 'C4', 'C5', 'C6', 'C7', 'T0', 'T1', 'K3']) expect(tasks[id], id).toEqual(before[id]);
    expect(tasks.C8).toMatchObject({ status: 'in_progress', owner: 'Grok', reviewer: 'Claude', tester: 'Vibe GLM',
      ownedPaths: 'src/x/', nextAction: 'start / now please' });
    expect(deriveTaskContext(snapshot, 'C8').task.id).toBe('C8');
    expect(exported.content).toContain('owner channel (/owner, proof secret, event seq');
    expect(exported.content).toContain(': approve request c6-req-' + n + ', owner.request by sol');
    expect(exported.content).toContain('| github-mcp#70 test (store seq');
    expect(exported.content).not.toContain('secret-plan');
    // Les décisions owner restent avant la phrase de clôture de la section.
    const owner = exported.content.slice(exported.content.indexOf('## Owner decisions'), exported.content.indexOf('## Roles'));
    expect(owner.trim().split('\n').pop()).toMatch(/^Kevin alone decides/);
  });

  it('export → import dans une base vide → export : identique, même hash (R2, restauration)', async () => {
    const cycle = uniq('restore');
    await importState(db, cycle, stateR6);
    const store = new CollabStore(db, { dailyWriteLimit: 100_000, now: () => new Date('2026-10-08T09:00:00Z') });
    await append(store, cycle, 'vibe', 'task.status', { task: { task_id: 'C4', status: 'review' } }, 'c4');
    const first = await exportCycleState(db, cycle);
    expect(first.changed).toBe(true);

    await ensureSchema(restore);
    await registerCc3(restore, 'c6-restore-' + n);
    expect((await importState(restore, cycle, first.content)).status).toBe('applied');
    const second = await exportCycleState(restore, cycle);
    expect(second.content).toBe(first.content);
    expect(second.content_sha256).toBe(first.content_sha256);
    expect(second.changed).toBe(false);
    expect(second.state_revision).toBe(7);
    const third = await exportCycleState(restore, cycle);
    expect(third.content_sha256).toBe(second.content_sha256);
  });

  it('le dernier import fait foi, y compris le ré-import d’un fichier plus ancien ; un double envoi est un doublon', async () => {
    const cycle = uniq('order');
    const older = await importState(db, cycle, stateR6);
    const newer = stateR6.replace('revision: 6\nbase_revision: 5', 'revision: 7\nbase_revision: 6');
    await importState(db, cycle, newer);
    expect((await exportCycleState(db, cycle)).state_revision).toBe(7);
    const again = await importState(db, cycle, stateR6);
    expect(again.status).toBe('applied');
    expect(again.content_sha256).toBe(older.content_sha256);
    expect((await exportCycleState(db, cycle)).state_revision).toBe(6);
    expect((await importState(db, cycle, stateR6)).status).toBe('duplicate');
  });

  it('sans état importé : NO_STATE_SNAPSHOT, rien n’est inventé', async () => {
    await expect(exportCycleState(db, uniq('none'))).rejects.toMatchObject({ code: 'NO_STATE_SNAPSHOT' });
  });
});
