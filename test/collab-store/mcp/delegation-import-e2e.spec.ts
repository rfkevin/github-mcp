import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { appointCycleCoordinator } from '../../../src/collab-store/owner/delegation-execution';
import { executablePayloadSha256 } from '../../../src/collab-store/owner/executable';
import { importStateSnapshot } from '../../../src/collab-store/owner/state-import';
import { registerDelegationTools } from '../../../src/collab-store/mcp/delegation-tools';
import type { CollabToolContext } from '../../../src/collab-store/mcp/context';
import { doc, HEADERS, TASK } from '../state-doc-helper';

// CC-5 l3e incrément 2a (D13) : import_state délégué, seulement si le verdict serveur est `direct`.
const db = (env as unknown as { COLLAB_DB_C6_RESTORE: D1Database }).COLLAB_DB_C6_RESTORE;
const ownerProof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const unique = (tag: string) => 'l3e2-' + tag + '-' + (++n);

interface Fixture { cycle: string; requestId: string; store: CollabStore; baseSeq: number; next: string }

async function fixture(o: { next: string; appoint?: boolean; claimedPrevious?: number | null; base?: string; expiresOffset?: number; noBase?: boolean }): Promise<Fixture> {
  await ensureSchema(db);
  const cycle = unique('cycle');
  const requestId = unique('req');
  await db.prepare('INSERT INTO cycles (cycle_id) VALUES (?1)').bind(cycle).run();
  for (const pid of ['l3e2-coord', 'l3e2-author', 'l3e2-review', 'l3e2-outsider']) {
    await db.prepare('INSERT INTO participants (participant_id, display_label) VALUES (?1, ?1) ON CONFLICT(participant_id) DO NOTHING').bind(pid).run();
  }
  if (o.appoint !== false) {
    await appointCycleCoordinator(db, { cycleId: cycle, participantId: 'l3e2-coord', familyId: 'l3e2-coord', expectedEpoch: 0, proof: ownerProof, op: unique('appoint') });
  }
  let baseSeq = 0;
  if (!o.noBase) {
    const base = await importStateSnapshot(db, { cycle_id: cycle, markdown: o.base ?? doc({ revision: 8 }), proof: ownerProof });
    expect(base.status).toBe('applied');
    baseSeq = base.event.seq;
  }
  const params = { cycle_id: cycle, markdown: o.next };
  const hash = await executablePayloadSha256('import_state', params);
  const store = new CollabStore(db);
  const ask = await store.appendEvent({
    cycle_id: cycle, type: 'owner.request', participant_id: 'l3e2-author', expected_rev: await store.currentRevision(cycle),
    op_id: 'l3e2-author:' + cycle + ':ask:1',
    payload_json: JSON.stringify({ request_id: requestId, summary: 'import state', action: 'import_state', params, payload_sha256: hash,
      preconditions: { previous_seq: o.claimedPrevious === undefined ? (o.noBase ? null : baseSeq) : o.claimedPrevious },
      expires_at: Math.floor(Date.now() / 1000) + (o.expiresOffset ?? 3600), max_cost_cents: 0, reason: 'test', risk: 'test', rollback: 'test' }),
  });
  expect(ask.status).toBe('applied');
  return { cycle, requestId, store, baseSeq, next: o.next };
}
async function approve(f: Fixture, reviewer = 'l3e2-review') {
  return f.store.appendEvent({ cycle_id: f.cycle, type: 'delegation.approve', participant_id: reviewer,
    expected_rev: await f.store.currentRevision(f.cycle), op_id: reviewer + ':' + f.cycle + ':approve:1',
    payload_json: JSON.stringify({ request_id: f.requestId }) });
}
async function execute(f: Fixture, participant = 'l3e2-coord') {
  let handler: ((input: { cycle: string; request_id: string }) => Promise<{ isError?: boolean; content?: Array<{ text?: string }> }>) | undefined;
  registerDelegationTools({ registerTool(_name: string, _schema: unknown, callback: typeof handler) { handler = callback; } } as unknown as McpServer,
    { db, identity: async () => ({ status: 'registered', participant_id: participant }) } as unknown as CollabToolContext);
  return handler!({ cycle: f.cycle, request_id: f.requestId });
}
const decisions = async (cycle: string) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'owner.decision'").bind(cycle).first<{ n: number }>())!.n;
const statusOf = async (cycle: string, id: string) =>
  (await db.prepare('SELECT status FROM tasks WHERE cycle_id = ?1 AND task_id = ?2').bind(cycle, id).first<{ status: string }>())?.status;

describe('l3e 2a — import_state délégué : seulement si le verdict serveur est direct', () => {
  it('direct : approbation indépendante puis exécution MCP, preuve déléguée, statut mis à jour', async () => {
    const f = await fixture({ next: doc({ revision: 9, tasks: [TASK('t1', 'done', 2)], evidence: ['| e1 | ok |', '| e2 | ok |'], nextAction: 'after' }) });
    expect((await approve(f)).status).toBe('applied');
    const result = await execute(f);
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(await statusOf(f.cycle, 't1')).toBe('done');
    const last = await db.prepare("SELECT payload_json FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' ORDER BY seq DESC LIMIT 1").bind(f.cycle).first<{ payload_json: string }>();
    const payload = JSON.parse(last!.payload_json);
    expect(payload).toMatchObject({ action: 'import_state', proof_kind: 'delegated', request_id: f.requestId, previous_import_seq: f.baseSeq });
    expect(await db.prepare('SELECT used FROM delegated_approvals WHERE request_id = ?1').bind(f.requestId).first()).toMatchObject({ used: 1 });
    expect((await execute(f)).isError).toBe(true); // rejouer ne réexécute rien
  });

  it.each([
    ['décision du propriétaire ajoutée', { decisions: ['- Kevin: decision one.', '- Kevin: grants everything.'] }],
    ['phase modifiée', { header: HEADERS.map(h => h.replace('phase: P6', 'phase: P5')) }],
    ['référence d’issue modifiée', { header: HEADERS.map(h => h.replace('issues/154', 'issues/999')) }],
    ['tâche ajoutée', { tasks: [TASK('t1', 'accepted', 1), TASK('t2', 'accepted', 1)] }],
    ['tâche retirée', { tasks: [] as string[] }],
    ['droits d’une tâche modifiés', { tasks: ['| t1 | accepted | none | tester | none | none | src/owner | none | none | 1 | ref | next |'] }],
    ['preuve existante modifiée', { evidence: ['| e1 | CHANGED |'] }],
  ])('validate : %s => approbation et exécution refusées, rien n’est écrit', async (_name, change) => {
    const f = await fixture({ next: doc({ revision: 9, ...change }) });
    const before = await decisions(f.cycle);
    await expect(approve(f)).rejects.toThrow();
    expect((await execute(f)).isError).toBe(true);
    expect(await decisions(f.cycle)).toBe(before);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM delegated_approvals WHERE request_id = ?1').bind(f.requestId).first()).toMatchObject({ n: 0 });
    expect(await statusOf(f.cycle, 't1')).toBe('accepted');
  });

  it('validate : une tâche done ne peut pas être rouverte par un import délégué', async () => {
    const f = await fixture({ base: doc({ revision: 8, tasks: [TASK('t1', 'done', 2)] }), next: doc({ revision: 9, tasks: [TASK('t1', 'accepted', 3)] }) });
    const before = await decisions(f.cycle);
    await expect(approve(f)).rejects.toThrow();
    expect((await execute(f)).isError).toBe(true);
    expect(await decisions(f.cycle)).toBe(before);
    expect(await statusOf(f.cycle, 't1')).toBe('done');
  });

  it('précondition périmée : le dernier import n’est plus celui que la demande attendait', async () => {
    const f = await fixture({ next: doc({ revision: 9 }), claimedPrevious: 1 });
    await expect(approve(f)).rejects.toThrow();
    expect((await execute(f)).isError).toBe(true);
  });

  it('course : un import du propriétaire entre l’approbation et l’exécution annule tout', async () => {
    const f = await fixture({ next: doc({ revision: 9, tasks: [TASK('t1', 'done', 2)] }) });
    expect((await approve(f)).status).toBe('applied');
    const other = await importStateSnapshot(db, { cycle_id: f.cycle, markdown: doc({ revision: 8, nextAction: 'owner changed it' }), proof: ownerProof });
    expect(other.status).toBe('applied');
    const before = await decisions(f.cycle);
    expect((await execute(f)).isError).toBe(true);
    expect(await decisions(f.cycle)).toBe(before);
    expect(await statusOf(f.cycle, 't1')).toBe('accepted');
  });

  it('HALT, révocation du mandat et non-coordinateur bloquent après approbation', async () => {
    const f = await fixture({ next: doc({ revision: 9, tasks: [TASK('t1', 'done', 2)] }) });
    expect((await approve(f)).status).toBe('applied');
    expect((await execute(f, 'l3e2-outsider')).isError).toBe(true);
    await db.prepare("INSERT OR REPLACE INTO owner_flags (name, value, updated_at) VALUES ('halt', '1', strftime('%s','now'))").run();
    try { expect((await execute(f)).isError).toBe(true); }
    finally { await db.prepare("DELETE FROM owner_flags WHERE name = 'halt'").run(); }
    await appointCycleCoordinator(db, { cycleId: f.cycle, participantId: null, familyId: null, expectedEpoch: 1, proof: ownerProof, op: unique('revoke') });
    expect((await execute(f)).isError).toBe(true);
    expect(await statusOf(f.cycle, 't1')).toBe('accepted');
  });

  it('une approbation falsifiée d’une autre action (install_phases) ne couvre pas un import_state', async () => {
    const f = await fixture({ next: doc({ revision: 9, tasks: [TASK('t1', 'done', 2)] }) });
    expect((await approve(f)).status).toBe('applied');
    await db.prepare("UPDATE delegated_approvals SET action = 'install_phases' WHERE request_id = ?1").bind(f.requestId).run();
    const before = await decisions(f.cycle);
    expect((await execute(f)).isError).toBe(true);
    expect(await decisions(f.cycle)).toBe(before);
    expect(await statusOf(f.cycle, 't1')).toBe('accepted');
  });

  it('coordinateur, auteur de la demande ou même famille ne peuvent pas approuver', async () => {
    const f = await fixture({ next: doc({ revision: 9, tasks: [TASK('t1', 'done', 2)] }) });
    await expect(approve(f, 'l3e2-coord')).rejects.toThrow();
    await expect(approve(f, 'l3e2-author')).rejects.toThrow();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM delegated_approvals WHERE request_id = ?1').bind(f.requestId).first()).toMatchObject({ n: 0 });
  });

  it('sans mandat (vacance) rien ne s’exécute', async () => {
    const f = await fixture({ next: doc({ revision: 9, tasks: [TASK('t1', 'done', 2)] }), appoint: false });
    expect((await execute(f)).isError).toBe(true);
  });

  it('premier import (aucun état précédent) : jamais délégué', async () => {
    const f = await fixture({ next: doc({ revision: 1 }), noBase: true });
    const before = await decisions(f.cycle);
    await expect(approve(f)).rejects.toThrow();
    expect((await execute(f)).isError).toBe(true);
    expect(await decisions(f.cycle)).toBe(before);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE cycle_id = ?1').bind(f.cycle).first()).toMatchObject({ n: 0 });
  });

  describe('plan résolu : aucun droit ne change sans Kevin (revue ChatGPT)', () => {
    const OWNED = (status: string, version: number) => '| t1 | ' + status + ' | l3e2-author | author | none | none | src/x | none | none | ' + version + ' | ref | next |';
    const sameText = async () => fixture({ base: doc({ revision: 8, tasks: [OWNED('accepted', 1)] }), next: doc({ revision: 9, tasks: [OWNED('done', 2)] }) });
    const pids = async (cycle: string) => db.prepare('SELECT owner_pid, status FROM tasks WHERE cycle_id = ?1 AND task_id = ?2').bind(cycle, 't1').first<{ owner_pid: string; status: string }>();

    it('témoin : sans dérive, le même texte reste direct et applique le statut', async () => {
      const f = await sameText();
      expect((await approve(f)).status).toBe('applied');
      expect((await execute(f)).isError, 'direct').toBeFalsy();
      expect(await pids(f.cycle)).toMatchObject({ owner_pid: 'l3e2-author', status: 'done' });
    });

    it('l’annuaire change entre le dernier import et l’exécution : même texte, autre participant => refusé', async () => {
      const f = await sameText();
      expect((await approve(f)).status).toBe('applied');
      await db.prepare("UPDATE participants SET display_label = 'l3e2-old-author' WHERE participant_id = 'l3e2-author'").run();
      await db.prepare("UPDATE participants SET display_label = 'l3e2-author' WHERE participant_id = 'l3e2-outsider'").run();
      try {
        const before = await decisions(f.cycle);
        expect((await execute(f)).isError).toBe(true);
        expect(await decisions(f.cycle)).toBe(before);
        expect(await pids(f.cycle)).toMatchObject({ owner_pid: 'l3e2-author', status: 'accepted' });
      } finally {
        await db.prepare("UPDATE participants SET display_label = 'l3e2-author' WHERE participant_id = 'l3e2-author'").run();
        await db.prepare("UPDATE participants SET display_label = 'l3e2-outsider' WHERE participant_id = 'l3e2-outsider'").run();
      }
    });

    it('un droit changé en base depuis le dernier import (réattribution) ne peut pas être écrasé par un import délégué', async () => {
      const f = await sameText();
      expect((await approve(f)).status).toBe('applied');
      await db.prepare("UPDATE tasks SET reviewer_pid = 'l3e2-outsider' WHERE cycle_id = ?1 AND task_id = 't1'").bind(f.cycle).run();
      expect((await execute(f)).isError).toBe(true);
      expect(await pids(f.cycle)).toMatchObject({ status: 'accepted' });
    });

    it('la phase du cycle changée depuis le dernier import n’est pas réinitialisée par un import délégué', async () => {
      const f = await sameText();
      expect((await approve(f)).status).toBe('applied');
      await db.prepare("UPDATE cycles SET phase = 'P7' WHERE cycle_id = ?1").bind(f.cycle).run();
      expect((await execute(f)).isError).toBe(true);
      expect(await db.prepare('SELECT phase FROM cycles WHERE cycle_id = ?1').bind(f.cycle).first()).toMatchObject({ phase: 'P7' });
    });

    it('une issue référencée par un autre cycle ne lui est pas reprise par un import délégué', async () => {
      const f = await sameText();
      expect((await approve(f)).status).toBe('applied');
      const other = unique('thief');
      await db.prepare('INSERT INTO cycles (cycle_id) VALUES (?1)').bind(other).run();
      await db.prepare('UPDATE cycle_issue_refs_v2 SET cycle_id = ?1 WHERE cycle_id = ?2').bind(other, f.cycle).run();
      expect((await execute(f)).isError).toBe(true);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM cycle_issue_refs_v2 WHERE cycle_id = ?1').bind(f.cycle).first()).toMatchObject({ n: 0 });
    });
  });
});
