import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { e2eScenario, toolCode as code, type E2eClient } from './e2e-harness';

// CC-3 CR-D (github-mcp#89, constat GPT6-02) par le vrai chemin HTTP : OAuth + /collab/mcp,
// /owner (secret) pour l'enregistrement, D1 local. Matrice D01–D07 du coordinateur
// (#89/6088007904). Aucune ligne memory_entries n'est écrite en SQL : toute la mémoire
// passe par collab_append_event ; les SELECT ne servent qu'à prouver l'état.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

type Agent = E2eClient & { pid: string };
type Row = { version: number; scope: string; status: string };

/** Ajoute un événement au cycle à sa révision courante (lue en base, jamais devinée). */
async function append(agent: Agent, cycle: string, op: string, type: string, memory: Record<string, unknown>) {
  const rev = await revision(cycle);
  return agent.call('collab_append_event', { cycle, expected_rev: rev, op_id: `${agent.pid}:${cycle}:${op}:1`, type,
    participant_id: agent.pid, payload_json: JSON.stringify({ memory }) });
}

async function revision(cycle: string): Promise<number> {
  return (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())?.revision ?? 0;
}

async function rows(id: string): Promise<Row[]> {
  return (await db.prepare('SELECT version, scope, status FROM memory_entries WHERE id = ?1 ORDER BY version')
    .bind(id).all<Row>()).results;
}

/** État observable d'un refus : révision, événements, quota du jour, lignes mémoire de l'id. */
async function snapshot(cycle: string, id: string) {
  const events = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
  const quota = await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1')
    .bind(new Date().toISOString().slice(0, 10)).first<{ writes: number }>();
  return { revision: await revision(cycle), events: events?.n ?? 0, quota: quota?.writes ?? 0, rows: await rows(id) };
}

const fact = (id: string, scope: string, text: string) =>
  ({ id, scope, kind: 'fact', text, evidence_refs: ['ev:crd-' + text.length], confidence: 'observed' });

describe('CC-3 CR-D — scope immuable d’un id mémoire (HTTP, D01–D07)', () => {
  it('D01–D05 : lignée privée, id réclamé par un autre scope, réutilisation après retrait', async () => {
    const { agent, uniq } = e2eScenario(db, 'crd', 'owner-secret-CRD-0123456789abcdefghijklmn');
    const [alpha, beta, gamma, delta] = [await agent('alpha'), await agent('beta'), await agent('gamma'), await agent('delta')];
    const cycle = uniq('cycle');
    const id = uniq('mem');
    const privateScope = `participant:${alpha.pid}`;

    // D01 — parcours légitime : alpha propose v1 privée, gamma (pair) l'active.
    expect((await append(alpha, cycle, 'p1', 'memory.propose', fact(id, privateScope, 'v1 privee alpha'))).structuredContent)
      .toMatchObject({ status: 'applied', memory: { id, version: 1, status: 'candidate' } });
    expect((await append(gamma, cycle, 'r1', 'memory.review', { id, version: 1 })).structuredContent)
      .toMatchObject({ status: 'applied', memory: { id, version: 1, status: 'active' } });

    // D02 — alpha consolide (v2 candidate, v1 superseded) ; beta propose le même id en common :
    // MEMORY_SCOPE_MISMATCH avant tout effet (ni événement, ni révision, ni quota, ni ligne).
    expect((await append(alpha, cycle, 'c2', 'memory.consolidate', { id, text: 'v2 privee alpha', evidence_refs: ['ev:crd-2'] }))
      .structuredContent).toMatchObject({ status: 'applied', memory: { id, version: 2, status: 'candidate' } });
    const beforeD02 = await snapshot(cycle, id);
    expect(code(await append(beta, cycle, 'p3', 'memory.propose', fact(id, 'common', 'v3 commune beta')))).toBe('MEMORY_SCOPE_MISMATCH');
    expect(await snapshot(cycle, id)).toEqual(beforeD02);
    expect(beforeD02.rows).toEqual([
      { version: 1, scope: privateScope, status: 'superseded' },
      { version: 2, scope: privateScope, status: 'candidate' },
    ]);

    // D03 — gamma active v2 ; aucune v3 hors scope n'existe : delta ne peut ni l'activer
    // (MEMORY_NOT_FOUND, pas de faux applied) ni réclamer l'id actif dans un autre scope.
    expect((await append(gamma, cycle, 'r2', 'memory.review', { id, version: 2 })).structuredContent)
      .toMatchObject({ status: 'applied', memory: { id, version: 2, status: 'active' } });
    const beforeD03 = await snapshot(cycle, id);
    expect(code(await append(delta, cycle, 'r3', 'memory.review', { id, version: 3 }))).toBe('MEMORY_NOT_FOUND');
    expect(code(await append(delta, cycle, 'p3', 'memory.propose', fact(id, 'common', 'v3 commune delta')))).toBe('MEMORY_SCOPE_MISMATCH');
    expect(await snapshot(cycle, id)).toEqual(beforeD03);
    expect(beforeD03.rows.find(row => row.version === 2)?.status).toBe('active');

    // D04 — alpha retire sa dernière version ; beta tente de recycler l'id retiré dans project:shared.
    expect((await append(alpha, cycle, 'x2', 'memory.retire', { id })).structuredContent)
      .toMatchObject({ status: 'applied', memory: { id, version: 2, status: 'retired' } });
    const beforeD04 = await snapshot(cycle, id);
    expect(code(await append(beta, cycle, 'p4', 'memory.propose', fact(id, 'project:shared', 'recyclage beta')))).toBe('MEMORY_SCOPE_MISMATCH');
    expect(await snapshot(cycle, id)).toEqual(beforeD04);

    // D05 — après retrait, alpha re-propose le même id DANS LE MÊME scope : version suivante (contrat existant).
    expect((await append(alpha, cycle, 'p5', 'memory.propose', fact(id, privateScope, 'v3 privee alpha'))).structuredContent)
      .toMatchObject({ status: 'applied', memory: { id, version: 3, status: 'candidate' } });
    expect(await rows(id)).toEqual([
      { version: 1, scope: privateScope, status: 'superseded' },
      { version: 2, scope: privateScope, status: 'retired' },
      { version: 3, scope: privateScope, status: 'candidate' },
    ]);
  });

  it('D06 : propositions concurrentes même id / scopes distincts, rejeu op_id, revues concurrentes', async () => {
    const { agent, uniq } = e2eScenario(db, 'crd6', 'owner-secret-CRD6-0123456789abcdefghijkl');
    const [alpha, beta, gamma, delta] = [await agent('alpha'), await agent('beta'), await agent('gamma'), await agent('delta')];
    // Deux cycles distincts : le CAS de révision du journal ne les sérialise pas ;
    // seule l'identité (id, scope) de la mémoire peut départager. Scopes project dédiés :
    // l'alarme de croissance C4 de `common` reste propre à D07.
    const [cycleA, cycleB] = [uniq('cycle-a'), uniq('cycle-b')];
    const id = uniq('race');
    const [first, second] = await Promise.all([
      append(alpha, cycleA, 'race', 'memory.propose', fact(id, 'project:crd6-a', 'course a')),
      append(beta, cycleB, 'race', 'memory.propose', fact(id, 'project:crd6-b', 'course b')),
    ]);
    const outcomes = [first, second].map(result => result.structuredContent.status ?? code(result)).sort();
    expect(outcomes).toEqual(['MEMORY_SCOPE_MISMATCH', 'applied']);
    const stored = await rows(id);
    expect(stored).toHaveLength(1);
    const winner = first.structuredContent.status === 'applied' ? { agent: alpha, cycle: cycleA } : { agent: beta, cycle: cycleB };
    const loser = winner.agent === alpha ? { agent: beta, cycle: cycleB, scope: 'project:crd6-b', text: 'course b' }
      : { agent: alpha, cycle: cycleA, scope: 'project:crd6-a', text: 'course a' };
    // Le perdant n'a rien écrit dans son cycle (ni événement ni révision).
    expect(await revision(loser.cycle)).toBe(0);

    // Rejeu : même op_id du gagnant → duplicate sans nouvel effet ; même op_id du perdant → toujours refusé.
    // Revue GPT-6 (#91) : duplicate strict (A05 : expected_rev hors empreinte), état et quota inchangés.
    const winnerScope = stored[0].scope;
    const beforeReplay = await snapshot(winner.cycle, id);
    const replayWinner = await append(winner.agent, winner.cycle, 'race', 'memory.propose',
      fact(id, winnerScope, winnerScope === 'project:crd6-a' ? 'course a' : 'course b'));
    expect(replayWinner.structuredContent.status).toBe('duplicate');
    expect(await snapshot(winner.cycle, id)).toEqual(beforeReplay);
    const beforeRetry = await snapshot(loser.cycle, id);
    expect(code(await append(loser.agent, loser.cycle, 'race', 'memory.propose', fact(id, loser.scope, loser.text))))
      .toBe('MEMORY_SCOPE_MISMATCH');
    expect(await snapshot(loser.cycle, id)).toEqual(beforeRetry);
    expect(await rows(id)).toEqual(stored);

    // Revues concurrentes de la même candidate depuis deux cycles : une seule activation.
    const reviews = await Promise.all([
      append(gamma, uniq('cycle-c'), 'review', 'memory.review', { id, version: 1 }),
      append(delta, uniq('cycle-d'), 'review', 'memory.review', { id, version: 1 }),
    ]);
    expect(reviews.filter(result => result.structuredContent.status === 'applied')).toHaveLength(1);
    expect(reviews.map(result => code(result)).filter(Boolean)).toEqual([expect.stringMatching(/^(MEMORY_NOT_CANDIDATE|ACTIVATION_RACE)$/)]);
    expect((await rows(id)).filter(row => row.status === 'active')).toHaveLength(1);
  });

  it('D07 : lifecycle d’un id common inchangé (propose→review→consolidate→review→retire), un effet par événement', async () => {
    const { agent, uniq } = e2eScenario(db, 'crd7', 'owner-secret-CRD7-0123456789abcdefghijkl');
    const [alpha, beta, gamma] = [await agent('alpha'), await agent('beta'), await agent('gamma')];
    const cycle = uniq('cycle');
    const id = uniq('common');
    const quotaStart = (await snapshot(cycle, id)).quota;
    expect((await append(beta, cycle, 'p1', 'memory.propose', fact(id, 'common', 'commune v1'))).structuredContent.status).toBe('applied');
    expect((await append(gamma, cycle, 'r1', 'memory.review', { id, version: 1 })).structuredContent.status).toBe('applied');
    // Scope partagé : un autre participant consolide (collaboratif, CRB-R1 inchangé).
    expect((await append(alpha, cycle, 'c2', 'memory.consolidate', { id, text: 'commune v2', evidence_refs: ['ev:crd7'] }))
      .structuredContent).toMatchObject({ status: 'applied', memory: { id, version: 2 } });
    expect((await append(beta, cycle, 'r2', 'memory.review', { id, version: 2 })).structuredContent.status).toBe('applied');
    expect((await append(gamma, cycle, 'x2', 'memory.retire', { id, version: 2 })).structuredContent.status).toBe('applied');
    const end = await snapshot(cycle, id);
    expect(end.rows).toEqual([
      { version: 1, scope: 'common', status: 'superseded' },
      { version: 2, scope: 'common', status: 'retired' },
    ]);
    expect(end.revision).toBe(5);
    expect(end.events).toBe(5);
    expect(end.quota - quotaStart).toBe(5);
    // Kinds protégés : la décision owner reste exigée, même sur un id neuf et cohérent.
    expect(code(await append(beta, cycle, 'inv', 'memory.propose',
      { id: uniq('inv').slice(0, 40).toLowerCase(), scope: 'common', kind: 'invariant', text: 'regle', evidence_refs: ['ev:inv'], confidence: 'verified' })))
      .toBe('PROTECTED_KIND_OWNER_REQUIRED');
  });
});
