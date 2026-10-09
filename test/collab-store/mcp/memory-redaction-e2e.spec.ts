import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { e2eScenario, toolCode as code, type E2eClient } from './e2e-harness';

// CC-3 CR-C (github-mcp#88, constat GPT6-01) par le vrai chemin HTTP : OAuth + /collab/mcp,
// /owner (secret) pour l'enregistrement, D1 local. Aucune ligne memory_entries écrite en SQL :
// toute la mémoire passe par collab_append_event. Matrice C01–C07 du coordinateur (#88/6088001839).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

const PRIVATE_TEXT = 'SENTINELLE-PRIVEE-ALPHA-C01';
const PRIVATE_REF = 'SENTINELLE-REF-C01';
const CONSOLIDATED_TEXT = 'SENTINELLE-PRIVEE-ALPHA-C06';
const CONSOLIDATED_REF = 'SENTINELLE-REF-C06';
const PRIVATE_SESSION = 'SENTINELLE-SESSION-C01';
const SENTINELS = [PRIVATE_TEXT, PRIVATE_REF, CONSOLIDATED_TEXT, CONSOLIDATED_REF, PRIVATE_SESSION];

/** Aucune sentinelle dans la réponse complète (structuredContent, texte, erreur). */
function expectNoSentinel(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of SENTINELS) expect(serialized, sentinel).not.toContain(sentinel);
}

type Event = { seq: number; type: string; participant_id: string; payload_json: string; idempotency_key: string; evidence_ref: string; session_id: string };
const events = (result: { structuredContent: Record<string, unknown> }) => (result.structuredContent.events as Event[]);

async function append(agent: E2eClient & { pid: string }, cycle: string, rev: number, op: string, type: string, payload: unknown,
  extra: Record<string, unknown> = {}) {
  return agent.call('collab_append_event', { cycle, expected_rev: rev, op_id: `${agent.pid}:${cycle}:${op}:1`, type,
    participant_id: agent.pid, payload_json: JSON.stringify(payload), ...extra });
}

describe('CC-3 CR-C — mémoire privée absente des lectures du journal (HTTP)', () => {
  it('C01–C07 : delta, contexte, STALE, client non enregistré, rejeu, lifecycle complet, événements publics', async () => {
    const { client, agent, uniq } = e2eScenario(db, 'crc', 'owner-secret-CRC-0123456789abcdefghijklmn');
    const [alpha, beta, gamma] = [await agent('alpha'), await agent('beta'), await agent('gamma')];
    const stranger = await client();
    const cycle = uniq('cycle');
    const memId = uniq('mem').slice(0, 40).toLowerCase();
    let rev = 0;

    // Ouverture du cycle (P1 par défaut) et proposition scellée P1 de beta (C07).
    expect((await append(alpha, cycle, rev, 'open', 'checkpoint', { note: 'ouverture' })).structuredContent.status).toBe('applied');
    rev += 1;
    expect((await append(beta, cycle, rev, 'prop', 'proposal.submit', { content: 'PROPOSITION-SCELLEE-C07' })).structuredContent.status)
      .toBe('applied');
    rev += 1;

    // C01 — alpha propose dans son scope privé (texte, preuve et session sentinelles).
    const proposed = await append(alpha, cycle, rev, 'mem', 'memory.propose', { memory: { id: memId, scope: `participant:${alpha.pid}`,
      kind: 'fact', text: PRIVATE_TEXT, evidence_refs: [PRIVATE_REF], confidence: 'observed' } },
    { session_id: PRIVATE_SESSION, evidence_ref: PRIVATE_REF });
    expect(proposed.structuredContent).toMatchObject({ status: 'applied', memory: { id: memId, version: 1, status: 'candidate' } });
    rev += 1;
    const proposeSeq = (proposed.structuredContent.event as Event).seq;

    // C07 — un événement common légitime reste lisible par tous.
    const common = await append(beta, cycle, rev, 'common', 'memory.propose', { memory: { scope: 'common', kind: 'fact',
      text: 'texte-commun-C07', evidence_refs: ['ref-commune-C07'], confidence: 'observed' } });
    expect(common.structuredContent.status).toBe('applied');
    rev += 1;

    // C01 — beta lit le delta depuis 0 : aucune sentinelle, séquence et curseur conservés.
    const betaDelta = await beta.call('collab_get_delta', { cycle, since_seq: 0 });
    expectNoSentinel(betaDelta);
    const betaEvents = events(betaDelta);
    expect(betaEvents.map(event => event.type)).toEqual(['checkpoint', 'proposal.submit', 'memory.propose', 'memory.propose']);
    const masked = betaEvents.find(event => event.seq === proposeSeq)!;
    expect(masked).toMatchObject({ participant_id: alpha.pid, session_id: '', evidence_ref: '', role: '' });
    expect(JSON.parse(masked.payload_json)).toEqual({ memory: { id: memId }, redacted: 'private_scope' });
    expect(masked.idempotency_key).toBe((proposed.structuredContent.event as Event).idempotency_key);
    // Reprise par curseur : les seq sont ceux du journal, sans trou.
    const resumed = await beta.call('collab_get_delta', { cycle, since_seq: proposeSeq - 1, limit: 1 });
    expect(events(resumed).map(event => event.seq)).toEqual([proposeSeq]);
    expect(resumed.structuredContent.hasMore).toBe(true);
    expectNoSentinel(resumed);
    // C07 — common lisible ; proposition P1 toujours scellée (jamais le contenu).
    expect(JSON.stringify(betaEvents)).toContain('texte-commun-C07');
    for (const reader of [alpha, gamma]) expect(JSON.stringify(await reader.call('collab_get_delta', { cycle, since_seq: 0 })))
      .not.toContain('PROPOSITION-SCELLEE-C07');

    // C02 — contexte avec delta et packet de beta.
    const betaContext = await beta.call('collab_get_context', { cycle, include_delta: true });
    expect(betaContext.isError).toBeFalsy();
    expectNoSentinel(betaContext);
    expect((betaContext.structuredContent.delta as { events: Event[] }).events).toHaveLength(4);

    // C03 — STALE provoqué par beta (checkpoint autorisé, expected_rev périmé) : delta d'erreur sans sentinelle.
    const stale = await append(beta, cycle, 1, 'stale', 'checkpoint', { note: 'périmé' });
    expect(code(stale)).toBe('STALE');
    expect(stale.structuredContent.currentRevision).toBe(rev);
    expectNoSentinel(stale);
    expect((stale.structuredContent.delta as Event[]).map(event => event.seq)).toContain(proposeSeq);
    // Aucun effet de l'appel refusé.
    expect(events(await beta.call('collab_get_delta', { cycle, since_seq: 0 }))).toHaveLength(4);

    // C04 — client OAuth non enregistré : aucune sentinelle, sans fournir de participant_id.
    expectNoSentinel(await stranger.call('collab_get_delta', { cycle, since_seq: 0 }));
    expectNoSentinel(await stranger.call('collab_get_context', { cycle, include_delta: true }));

    // C05 — alpha relit son propre historique tel qu'écrit ; rejeu = duplicate ; conflit neutre.
    const own = await alpha.call('collab_get_delta', { cycle, since_seq: 0 });
    expect(JSON.stringify(own)).toContain(PRIVATE_TEXT);
    const replay = await append(alpha, cycle, rev, 'mem', 'memory.propose', { memory: { id: memId, scope: `participant:${alpha.pid}`,
      kind: 'fact', text: PRIVATE_TEXT, evidence_refs: [PRIVATE_REF], confidence: 'observed' } },
    { session_id: PRIVATE_SESSION, evidence_ref: PRIVATE_REF });
    expect(replay.structuredContent).toMatchObject({ status: 'duplicate', event: { seq: proposeSeq } });
    const conflict = await append(alpha, cycle, rev, 'mem', 'memory.propose', { memory: { id: memId, scope: `participant:${alpha.pid}`,
      kind: 'fact', text: 'autre intention', confidence: 'observed' } });
    expect(code(conflict)).toBe('IDEMPOTENCY_CONFLICT');
    expectNoSentinel(conflict);
    // Beta qui rejoue l'op_id d'alpha sous sa propre identité : PARTICIPANT_MISMATCH, rien de privé.
    const hijack = await beta.call('collab_append_event', { cycle, expected_rev: rev, op_id: `${alpha.pid}:${cycle}:mem:1`,
      type: 'memory.propose', participant_id: alpha.pid, payload_json: '{"memory":{}}' });
    expect(code(hijack)).toBe('PARTICIPANT_MISMATCH');
    expectNoSentinel(hijack);

    // C06 — revue par un pair, consolidation (nouvelle sentinelle), revue v2, retrait ; beta relit tout.
    expect((await append(gamma, cycle, rev, 'rev1', 'memory.review', { memory: { id: memId, version: 1 } }))
      .structuredContent.status).toBe('applied');
    rev += 1;
    expect((await append(alpha, cycle, rev, 'cons', 'memory.consolidate', { memory: { id: memId, text: CONSOLIDATED_TEXT,
      evidence_refs: [CONSOLIDATED_REF] } })).structuredContent).toMatchObject({ status: 'applied', memory: { version: 2 } });
    rev += 1;
    expect((await append(gamma, cycle, rev, 'rev2', 'memory.review', { memory: { id: memId, version: 2 } }))
      .structuredContent.status).toBe('applied');
    rev += 1;
    expect((await append(alpha, cycle, rev, 'retire', 'memory.retire', { memory: { id: memId, version: 2 } }))
      .structuredContent.status).toBe('applied');
    rev += 1;
    const lifecycle = await beta.call('collab_get_delta', { cycle, since_seq: 0 });
    expectNoSentinel(lifecycle);
    const privateEvents = events(lifecycle).filter(event => event.participant_id !== beta.pid && event.type.startsWith('memory.'));
    expect(privateEvents.map(event => event.type)).toEqual(['memory.propose', 'memory.review', 'memory.consolidate', 'memory.review',
      'memory.retire']);
    for (const event of privateEvents) expect(JSON.parse(event.payload_json).redacted).toBe('private_scope');
    // Versions et tombstone visibles comme métadonnées.
    expect(privateEvents.map(event => JSON.parse(event.payload_json).memory)).toEqual([
      { id: memId }, { id: memId, version: 1 }, { id: memId }, { id: memId, version: 2 }, { id: memId, version: 2 }]);
    // Le reviewer gamma voit ses propres revues telles qu'écrites, pas le texte d'alpha.
    const gammaView = await gamma.call('collab_get_delta', { cycle, since_seq: 0 });
    expectNoSentinel(gammaView);
    expect(events(gammaView).filter(event => event.participant_id === gamma.pid).map(event => JSON.parse(event.payload_json)))
      .toEqual([{ memory: { id: memId, version: 1 } }, { memory: { id: memId, version: 2 } }]);
    expectNoSentinel(await stranger.call('collab_get_delta', { cycle, since_seq: 0 }));
    // Alpha garde la lecture complète de son historique.
    const alphaView = JSON.stringify(await alpha.call('collab_get_delta', { cycle, since_seq: 0 }));
    for (const sentinel of [PRIVATE_TEXT, PRIVATE_REF, CONSOLIDATED_TEXT, CONSOLIDATED_REF]) expect(alphaView).toContain(sentinel);
  });
});
