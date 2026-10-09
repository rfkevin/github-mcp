import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../../src/collab-store/memory/memory-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-3 CR-D (github-mcp#89, constat GPT6-02) — un id mémoire n'a qu'un scope, immuable sur
// toutes ses versions. Unitaire : les INSERT SQL ne servent qu'à simuler des données anciennes
// incohérentes (antérieures à CR-D) ou une écriture concurrente committée entre les pré-checks
// et le batch. Le parcours public par le journal est couvert par memory-scope-identity-e2e.spec.ts.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const mem = () => new MemoryStore(db);

async function seed(id: string, version: number, scope: string, status: string, author = 'agent:a'): Promise<void> {
  await ensureSchema(db);
  await db.prepare([
    'INSERT INTO memory_entries (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid, token_cost)',
    "VALUES (?1, ?2, ?3, 'fact', 'donnee ancienne', '[\"ev:legacy\"]', 'observed', ?4, ?5, '', 4)",
  ].join(' ')).bind(id, version, scope, status, author).run();
}

async function lineage(id: string): Promise<Array<{ version: number; scope: string; status: string }>> {
  return (await db.prepare('SELECT version, scope, status FROM memory_entries WHERE id = ?1 ORDER BY version')
    .bind(id).all<{ version: number; scope: string; status: string }>()).results;
}

const propose = (id: string, scope: string, author = 'agent:a') => mem().propose({
  id, scope, kind: 'fact', text: 'texte ' + scope, evidence_refs: ['ev:crd'], confidence: 'observed', author_pid: author,
});

describe('CC-3 CR-D — données anciennes multi-scope : lignée figée, fail-closed', () => {
  // État exact du constat GPT6-02 avant CR-D : v1 privée active, v2 commune candidate du même id.
  it('aucune activation, consolidation, retrait ni proposition ne touche la lignée', async () => {
    const id = 'crd-legacy-1';
    await seed(id, 1, 'participant:agent:a', 'active');
    await seed(id, 2, 'common', 'candidate', 'agent:b');
    const before = await lineage(id);

    // L'activation de v2 commune aurait superseded v1 privée sans action de son propriétaire.
    await expect(mem().activate(id, 2, 'agent:c')).rejects.toMatchObject({ code: 'MEMORY_SCOPE_MISMATCH' });
    await expect(mem().prepareSupersede(id, 'agent:a', 'consolide', ['ev:x'], undefined, undefined, undefined, 'agent:a'))
      .rejects.toMatchObject({ code: 'MEMORY_SCOPE_MISMATCH' });
    await expect(mem().prepareRetire(id, 2, 'default', undefined, 'agent:b')).rejects.toMatchObject({ code: 'MEMORY_SCOPE_MISMATCH' });
    await expect(mem().prepareRetire(id, 1, 'default', undefined, 'agent:a')).rejects.toMatchObject({ code: 'MEMORY_SCOPE_MISMATCH' });
    await expect(propose(id, 'common')).rejects.toMatchObject({ code: 'MEMORY_SCOPE_MISMATCH' });
    await expect(propose(id, 'participant:agent:a')).rejects.toMatchObject({ code: 'MEMORY_SCOPE_MISMATCH' });

    expect(await lineage(id)).toEqual(before);
  });

  it('le message ne révèle pas le scope existant (potentiellement privé)', async () => {
    const id = 'crd-legacy-2';
    await seed(id, 1, 'participant:agent:secret', 'retired');
    const error = await propose(id, 'common').catch((caught: Error) => caught);
    expect(error).toMatchObject({ code: 'MEMORY_SCOPE_MISMATCH' });
    expect((error as Error).message).not.toContain('agent:secret');
  });
});

describe('CC-3 CR-D — gardes au commit : écriture concurrente entre pré-checks et batch', () => {
  it('propose : un autre scope committé entre-temps roule tout le batch en arrière', async () => {
    const id = 'crd-race-propose';
    const prepared = await mem().preparePropose({ id, scope: 'common', kind: 'fact', text: 'course', evidence_refs: ['ev:r'],
      confidence: 'observed', author_pid: 'agent:a' });
    await seed(id, 7, 'project:autre', 'candidate', 'agent:b');
    await expect(db.batch(prepared.statements)).rejects.toThrow();
    expect(await lineage(id)).toEqual([{ version: 7, scope: 'project:autre', status: 'candidate' }]);
  });

  it('activation : jamais de supersession d’une version d’un autre scope apparue au commit', async () => {
    const id = 'crd-race-activate';
    await propose(id, 'common');
    const prepared = await mem().prepareActivation(id, 1, 'agent:b');
    await seed(id, 2, 'participant:agent:z', 'active', 'agent:z');
    await expect(db.batch(prepared.statements)).rejects.toThrow();
    expect(await lineage(id)).toEqual([
      { version: 1, scope: 'common', status: 'candidate' },
      { version: 2, scope: 'participant:agent:z', status: 'active' },
    ]);
  });

  it('consolidation et retrait : un autre scope apparu au commit annule l’effet', async () => {
    const consolidated = 'crd-race-consolidate';
    await propose(consolidated, 'common');
    await mem().activate(consolidated, 1, 'agent:b');
    const supersede = await mem().prepareSupersede(consolidated, 'agent:a', 'v2', ['ev:v2']);
    await seed(consolidated, 9, 'project:autre', 'candidate', 'agent:b');
    await expect(db.batch(supersede.statements)).rejects.toThrow();
    expect((await lineage(consolidated)).find(row => row.version === 1)?.status).toBe('active');

    const retired = 'crd-race-retire';
    await propose(retired, 'common');
    const retire = await mem().prepareRetire(retired, 1);
    await seed(retired, 9, 'project:autre', 'candidate', 'agent:b');
    await expect(db.batch(retire.statements)).rejects.toThrow();
    expect((await lineage(retired)).find(row => row.version === 1)?.status).toBe('candidate');
  });
});

describe('CC-3 CR-D — lifecycle légitime dans le scope d’origine', () => {
  it('candidate → active → consolidate → active → retire → re-proposition : même scope, versions suivantes', async () => {
    const id = 'crd-same-scope';
    // Scope dédié : l'alarme de croissance C4 compte les actives du scope (données des autres cas).
    const scope = 'participant:agent:same';
    await propose(id, scope);
    await mem().activate(id, 1, 'agent:b');
    await mem().supersede(id, 'agent:a', 'v2 consolidee', ['ev:v2']);
    await mem().activate(id, 2, 'agent:b');
    await mem().retire(id, 2);
    expect((await propose(id, scope)).version).toBe(3);
    expect(await lineage(id)).toEqual([
      { version: 1, scope, status: 'superseded' },
      { version: 2, scope, status: 'retired' },
      { version: 3, scope, status: 'candidate' },
    ]);
  });
});

/** Copies promues depuis la version `version` de la lignée `id` (lignée tracée par supersedes). */
async function liftedCopies(id: string, version: number): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE supersedes = ?1')
    .bind(`${id}@${version}`).first<{ n: number }>())?.n ?? 0;
}

// Revue GPT-6 de la PR #91 (CRD-R1, CRD-R2) : la promotion de scope respecte le même invariant.
describe('CC-3 CR-D — promotion de scope (revue GPT-6 CRD-R1/CRD-R2)', () => {
  it('CRD-R1 : une lignée ancienne multi-scope n’est jamais promue (ni supersession ni copie)', async () => {
    const id = 'crd-promote-legacy';
    await seed(id, 1, 'participant:agent:a', 'active');
    await seed(id, 2, 'common', 'candidate', 'agent:b');
    const before = await lineage(id);
    await expect(mem().promoteScope(id, 1, 'agent:b', 'project:crd')).rejects.toMatchObject({ code: 'MEMORY_SCOPE_MISMATCH' });
    expect(await lineage(id)).toEqual(before);
    expect(await liftedCopies(id, 1)).toBe(0);
  });

  it('CRD-R1 : une autre version hors scope apparue au commit annule la promotion', async () => {
    const id = 'crd-promote-commit';
    await propose(id, 'participant:agent:p', 'agent:p');
    await mem().activate(id, 1, 'agent:b');
    const prepared = await mem().preparePromoteScope(id, 1, 'agent:b', 'project:crd');
    await seed(id, 2, 'common', 'candidate', 'agent:z');
    await expect(db.batch(prepared.statements)).rejects.toThrow();
    expect((await lineage(id)).find(row => row.version === 1)?.status).toBe('active');
    expect(await liftedCopies(id, 1)).toBe(0);
  });

  it('CRD-R2 : deux promotions préparées avant le premier commit → une seule copie, perdant refusé', async () => {
    const id = 'crd-promote-race';
    await propose(id, 'participant:agent:q', 'agent:q');
    await mem().activate(id, 1, 'agent:b');
    // Les deux appels lisent la source active avant tout commit (course reproduite pas à pas).
    const first = await mem().preparePromoteScope(id, 1, 'agent:b', 'project:crd-a');
    const second = await mem().preparePromoteScope(id, 1, 'agent:c', 'project:crd-b');
    expect(first.summary.id).not.toBe(second.summary.id);
    await db.batch(first.statements);
    await expect(db.batch(second.statements)).rejects.toThrow();
    expect(await liftedCopies(id, 1)).toBe(1);
    expect(await mem().get(second.summary.id, 1)).toBeNull();
    // Par l'API : le perdant reçoit un refus typé, sans nouvelle copie.
    await expect(mem().promoteScope(id, 1, 'agent:c', 'project:crd-b')).rejects.toMatchObject({ code: 'MEMORY_NOT_ACTIVE' });
    expect(await liftedCopies(id, 1)).toBe(1);
  });
});
