import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { describePending, executablePayloadSha256 } from '../../../src/collab-store/owner/executable';
import { listPendingPage } from '../../../src/collab-store/owner/decisions';
import { importStateSnapshot } from '../../../src/collab-store/owner/state-import';
import { stateDiffRows } from '../../../src/collab-store/owner/page';
import { doc, TASK } from '../state-doc-helper';

// CC-5 l3e 2b : /owner montre la classification de l'import (même calcul que la délégation).
const db = (env as unknown as { COLLAB_DB_C6_RESTORE: D1Database }).COLLAB_DB_C6_RESTORE;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;

async function fileImport(markdown: string, o: { noBase?: boolean; previous?: number | null } = {}) {
  await ensureSchema(db);
  const cycle = 'l3e2b-cycle-' + (++n);
  await db.prepare('INSERT INTO cycles (cycle_id) VALUES (?1)').bind(cycle).run();
  await db.prepare("INSERT INTO participants (participant_id, display_label) VALUES ('l3e2b-author', 'l3e2b-author') ON CONFLICT(participant_id) DO NOTHING").run();
  let baseSeq: number | null = null;
  if (!o.noBase) baseSeq = (await importStateSnapshot(db, { cycle_id: cycle, markdown: doc({ revision: 8 }), proof })).event.seq;
  const params = { cycle_id: cycle, markdown };
  const store = new CollabStore(db);
  const ask = await store.appendEvent({
    cycle_id: cycle, type: 'owner.request', participant_id: 'l3e2b-author', expected_rev: await store.currentRevision(cycle),
    op_id: 'l3e2b-author:' + cycle + ':ask:1',
    payload_json: JSON.stringify({ request_id: 'l3e2b-req-' + n, summary: 'import', action: 'import_state', params,
      payload_sha256: await executablePayloadSha256('import_state', params), preconditions: { previous_seq: o.previous === undefined ? baseSeq : o.previous },
      expires_at: Math.floor(Date.now() / 1000) + 3600, max_cost_cents: 0, reason: 'r', risk: 'r', rollback: 'r' }),
  });
  const page = await describePending(await listPendingPage(db, { limit: 500 }), undefined, db);
  return page.items.find(item => item.seq === ask.event.seq)!.executable!;
}

describe('l3e 2b — verdict d’import affiché sur /owner', () => {
  it('direct et à jour : délégable, changements listés', async () => {
    const exec = await fileImport(doc({ revision: 9, tasks: [TASK('t1', 'done', 2)] }));
    expect(exec.state_diff).toMatchObject({ level: 'direct', stale: false, delegable: true, reasons: [] });
    expect(exec.state_diff?.changes.join(' ')).toMatch(/tâche t1/);
  });

  it('droit ou décision modifié : à valider par Kevin, avec la raison', async () => {
    const exec = await fileImport(doc({ revision: 9, decisions: ['- Kevin: decision one.', '- Kevin: grants everything.'] }));
    expect(exec.state_diff).toMatchObject({ level: 'validate', delegable: false });
    expect(exec.state_diff?.reasons.join(' ')).toMatch(/décisions du propriétaire/);
  });

  it('précondition périmée : direct mais non délégable', async () => {
    const exec = await fileImport(doc({ revision: 9 }), { previous: 1 });
    expect(exec.state_diff).toMatchObject({ level: 'direct', stale: true, delegable: false });
  });

  it('premier import : toujours à valider', async () => {
    const exec = await fileImport(doc({ revision: 1 }), { noBase: true });
    expect(exec.state_diff).toMatchObject({ level: 'validate', delegable: false });
  });

  it('sans accès base, aucune classification et la page reste affichable', async () => {
    const page = await describePending({ items: [], total: 0 } as never);
    expect(page.items).toEqual([]);
  });
});

describe('l3e 2b — rendu HTML du verdict', () => {
  const base = { level: 'direct' as const, reasons: [] as string[], changes: ['tâche t1 : status'], stale: false, delegable: true };
  it('direct à jour', () => {
    const html = stateDiffRows({ action: 'import_state', state_diff: base });
    expect(html).toContain('Direct');
    expect(html).toContain('tâche t1 : status');
    expect(html).not.toContain('À valider par vous');
  });
  it('périmé : avertissement explicite', () => {
    expect(stateDiffRows({ action: 'import_state', state_diff: { ...base, stale: true, delegable: false } })).toContain('le dernier import a changé');
  });
  it('à valider : raisons échappées', () => {
    const html = stateDiffRows({ action: 'import_state', state_diff: { ...base, level: 'validate', delegable: false, reasons: ['<img src=x onerror=alert(1)>'] } });
    expect(html).toContain('À valider par vous');
    expect(html).toContain('&#60;img');
    expect(html).not.toContain('<img');
  });
  it('autre action ou sans verdict : rien', () => {
    expect(stateDiffRows({ action: 'install_phases', state_diff: base })).toBe('');
    expect(stateDiffRows({ action: 'import_state' })).toBe('');
  });
});
