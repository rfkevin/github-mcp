import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { e2eScenario, toolCode as code, type E2eClient } from './e2e-harness';

// CC-3 CR-F03 (github-mcp#95, contre-revue Codex #79/6096598889) par le vrai chemin
// HTTP : OAuth + /collab/mcp pour les agents, D1 local. Toute HAUSSE de confiance
// d'une consolidation exige une preuve NOUVELLE du registre evidence_ledger,
// produite par un pair distinct de l'auteur : aucun recyclage, aucune
// auto-validation. La nouveauté se juge sur la lignée ENTIÈRE de l’id
// (revue Claude PR #100/6098002656) : une consolidation qui retire la preuve
// ne la « blanchit » pas. Aucune ligne memory_entries, journal, quota ou décision n'est
// écrite en SQL par le test : les SELECT ne servent qu'à prouver l'état. Le
// registre evidence_ledger n'a pas encore de canal d'écriture HTTP (I11) : les
// lignes d'évaluation du pair y sont semées directement, comme dans les tests
// unitaires du store.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

type Agent = E2eClient & { pid: string };

async function revision(cycle: string): Promise<number> {
  return (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())?.revision ?? 0;
}

async function eventsIn(cycle: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>())?.n ?? 0;
}

interface MemoryRow { version: number; status: string; confidence: string; evidence_refs: string }

async function rowsOf(id: string): Promise<MemoryRow[]> {
  const { results } = await db.prepare(
    'SELECT version, status, confidence, evidence_refs FROM memory_entries WHERE id = ?1 ORDER BY version',
  ).bind(id).all<MemoryRow>();
  return results ?? [];
}

async function dayWrites(): Promise<number> {
  const row = await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1')
    .bind(new Date().toISOString().slice(0, 10)).first<{ writes: number }>();
  return row?.writes ?? 0;
}

/** Ligne d'évaluation d'un pair dans le registre (I11) : kind 'evaluation', payload vide. */
async function seedLedgerRow(producer: string, evidenceRef: string): Promise<void> {
  await db.prepare(
    `INSERT INTO evidence_ledger (subject_pid, producer, kind, payload_json, evidence_ref, at)
     VALUES (?1, ?2, 'evaluation', '{}', ?3, 1)`,
  ).bind('subject:crf3', producer, evidenceRef).run();
}

describe("CC-3 CR-F03 — hausse de confiance d'une consolidation par preuve pair (HTTP)", () => {
  it('sans preuve, preuve recyclée ou preuve de l’auteur → refus sans journal/quota/révision ; preuve nouvelle → v2 candidate puis active', async () => {
    const { agent, uniq } = e2eScenario(db, 'crf3', 'owner-secret-CRF3-0123456789abcdefghijklm');
    const [alpha, beta] = [await agent('alpha'), await agent('beta')];
    const cycle = uniq('cycle');
    const scope = 'role:' + uniq('raise');
    const id = uniq('mem');
    const append = async (who: Agent, op: string, type: string, payload: Record<string, unknown>) =>
      who.call('collab_append_event', {
        cycle,
        expected_rev: await revision(cycle),
        op_id: `${who.pid}:${cycle}:${op}:1`,
        type,
        participant_id: who.pid,
        payload_json: JSON.stringify(payload),
      });

    // v1 : proposition observée par alpha, revue par le pair distinct beta → active.
    expect((await append(alpha, 'p1', 'memory.propose', {
      memory: { id, scope, kind: 'fact', text: 'fait observe, preuve initiale', evidence_refs: ['ev:crf3-v1'], confidence: 'observed' },
    })).structuredContent.status).toBe('applied');
    expect((await append(beta, 'r1', 'memory.review', { memory: { id, version: 1 } })).structuredContent.status).toBe('applied');

    // Refus pré-batch = aucune écriture : ni journal, ni révision, ni quota, ni mémoire.
    const snapshot = async () => ({
      rev: await revision(cycle),
      events: await eventsIn(cycle),
      quota: await dayWrites(),
      rows: await rowsOf(id),
    });
    const before = await snapshot();
    const raise = (op: string, extra: Record<string, unknown>) =>
      append(alpha, op, 'memory.consolidate', {
        memory: { id, text: 'fait renforce par preuve pair', evidence_refs: ['ev:crf3-v1'], confidence: 'verified', ...extra },
      });

    // Hausse SANS peer_evidence_ref → PEER_EVIDENCE_REQUIRED, rien n'est écrit.
    expect(code(await raise('c1', {}))).toBe('PEER_EVIDENCE_REQUIRED');
    expect(await snapshot()).toEqual(before);
    // Preuve introuvable au registre → PEER_EVIDENCE_NOT_FOUND, rien n'est écrit.
    expect(code(await raise('c2', { peer_evidence_ref: 'ev:crf3-unknown' }))).toBe('PEER_EVIDENCE_NOT_FOUND');
    expect(await snapshot()).toEqual(before);
    // Preuve produite par l'AUTEUR lui-même → PEER_EVIDENCE_SELF, rien n'est écrit.
    await seedLedgerRow(alpha.pid, 'ev:crf3-self');
    expect(code(await raise('c3', { peer_evidence_ref: 'ev:crf3-self' }))).toBe('PEER_EVIDENCE_SELF');
    expect(await snapshot()).toEqual(before);
    // Recyclage : la ligne existe (produite par un pair) mais son ref soutient DÉJÀ
    // la version active → PEER_EVIDENCE_REQUIRED, rien n'est écrit.
    await seedLedgerRow(beta.pid, 'ev:crf3-v1');
    expect(code(await raise('c4', { peer_evidence_ref: 'ev:crf3-v1' }))).toBe('PEER_EVIDENCE_REQUIRED');
    expect(await snapshot()).toEqual(before);

    // Preuve NOUVELLE d'un pair distinct → applied : v2 candidate avec le ref du
    // registre dans evidence_refs, v1 superseded, journal et révision avancés.
    await seedLedgerRow(beta.pid, 'ev:crf3-new-1');
    const ok = await raise('c5', { peer_evidence_ref: 'ev:crf3-new-1' });
    expect(ok.structuredContent.status).toBe('applied');
    expect(ok.structuredContent.memory).toMatchObject({ id, version: 2, status: 'candidate' });
    const after = await rowsOf(id);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ version: 1, status: 'superseded' });
    expect(after[1]).toMatchObject({ version: 2, status: 'candidate', confidence: 'verified' });
    expect(JSON.parse(after[1].evidence_refs)).toEqual(expect.arrayContaining(['ev:crf3-new-1']));

    // La revue par le pair distinct active v2.
    expect((await append(beta, 'r2', 'memory.review', { memory: { id, version: 2 } })).structuredContent.status).toBe('applied');
    expect((await rowsOf(id))[1]).toMatchObject({ version: 2, status: 'active' });

    // À confiance inchangée, la consolidation reste libre de toute preuve pair.
    expect((await append(alpha, 'c6', 'memory.consolidate', {
      memory: { id, text: 'fait reformule, confiance inchangee', evidence_refs: ['ev:crf3-v1'] },
    })).structuredContent.status).toBe('applied');
    expect((await rowsOf(id))[2]).toMatchObject({ version: 3, status: 'candidate', confidence: 'verified' });
  });

  it('revue Claude #100 (P1) : une preuve retirée par une consolidation intermédiaire n’est pas « blanchie » — le recyclage reste refusé (HTTP)', async () => {
    const { agent, uniq } = e2eScenario(db, 'crf3b', 'owner-secret-CRF3B-0123456789abcdefghijklm');
    const [alpha, beta] = [await agent('alpha'), await agent('beta')];
    const cycle = uniq('cycle');
    const scope = 'role:' + uniq('wash');
    const id = uniq('mem');
    const append = async (who: Agent, op: string, type: string, payload: Record<string, unknown>) =>
      who.call('collab_append_event', {
        cycle,
        expected_rev: await revision(cycle),
        op_id: `${who.pid}:${cycle}:${op}:1`,
        type,
        participant_id: who.pid,
        payload_json: JSON.stringify(payload),
      });

    // v1 : observed, revue par le pair distinct beta → active.
    expect((await append(alpha, 'p1', 'memory.propose', {
      memory: { id, scope, kind: 'fact', text: 'fait observe, lavage de preuve', evidence_refs: ['ev:crf3b-a'], confidence: 'observed' },
    })).structuredContent.status).toBe('applied');
    expect((await append(beta, 'r1', 'memory.review', { memory: { id, version: 1 } })).structuredContent.status).toBe('applied');

    // v2 : hausse verified avec la preuve NOUVELLE L1 du pair beta → active.
    await seedLedgerRow(beta.pid, 'ev:crf3b-l1');
    expect((await append(alpha, 'c1', 'memory.consolidate', {
      memory: { id, text: 'fait renforce par la preuve L1', evidence_refs: ['ev:crf3b-a'], confidence: 'verified', peer_evidence_ref: 'ev:crf3b-l1' },
    })).structuredContent.status).toBe('applied');
    expect((await append(beta, 'r2', 'memory.review', { memory: { id, version: 2 } })).structuredContent.status).toBe('applied');

    // v3 : consolidation à confiance inchangée qui RETIRE L1 des refs (permise)
    // — c’est le « lavage de preuve » que la garde doit couvrir.
    expect((await append(alpha, 'c2', 'memory.consolidate', {
      memory: { id, text: 'fait reformule sans L1', evidence_refs: ['ev:crf3b-a'] },
    })).structuredContent.status).toBe('applied');
    expect((await append(beta, 'r3', 'memory.review', { memory: { id, version: 3 } })).structuredContent.status).toBe('applied');

    // Recyclage de L1 — elle ne soutient plus que la v2 SUPERSEDED — : refus
    // pré-batch, aucune écriture (ni journal, ni révision, ni quota, ni mémoire).
    const snapshot = async () => ({
      rev: await revision(cycle),
      events: await eventsIn(cycle),
      quota: await dayWrites(),
      rows: await rowsOf(id),
    });
    const before = await snapshot();
    expect(code(await append(alpha, 'c3', 'memory.consolidate', {
      memory: { id, text: 'fait re-hausse en recyclant L1', evidence_refs: ['ev:crf3b-a'], confidence: 'owner_validated', peer_evidence_ref: 'ev:crf3b-l1' },
    }))).toBe('PEER_EVIDENCE_REQUIRED');
    expect(await snapshot()).toEqual(before);
    // La lignée est intacte : v1 et v2 superseded, v3 active (verified).
    expect((await rowsOf(id)).map((row) => row.status)).toEqual(['superseded', 'superseded', 'active']);
  });
});
