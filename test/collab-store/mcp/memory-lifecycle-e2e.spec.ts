import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { e2eScenario, toolCode as code } from './e2e-harness';

// CC-3 CR-B (contre-revue Codex github-mcp#79, CR-02), par le vrai chemin HTTP :
// OAuth + /collab/mcp pour les agents, /owner (secret) pour Kevin, D1 local.
// Le parcours public complet du lifecycle memoire passe par collab_append_event
// (propose, review, consolidate, review v2, retire), collab_get_context et
// collab_export. Aucun INSERT SQL de memory_entries : le journal est la seule
// porte d'entree, les SELECT ne servent qu'a lire l'etat.
// Harnais HTTP partage avec les autres specs E2E : e2e-harness.ts (meme dossier).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

describe('CC-3 CR-B (CR-02) — lifecycle memoire C4 par le journal public (HTTP)', () => {
  it('propose, review, get_context/export, consolidate, review v2, retire ; isolation ; stranger refuse', async () => {
    const { client, agent, uniq } = e2eScenario(db, 'crb', 'owner-secret-CRB-0123456789abcdefghijklmn');
    const alpha = await agent('alpha');
    const beta = await agent('beta');
    const gamma = await agent('gamma');
    const stranger = await client();
    const cycle = uniq('cycle');
    const scope = 'participant:' + alpha.pid;
    const mid = uniq('mem');
    const text = 'le store sert la memoire C4 via le journal';
    const text2 = 'consolide : le lifecycle memoire suit le journal';
    const proposeJson = JSON.stringify({ memory: { id: mid, scope, kind: 'fact', text, evidence_refs: ['ev:crb-1'], confidence: 'observed' } });

    // 1. Ouverture du cycle par checkpoint (rev 0 -> 1).
    expect((await alpha.call('collab_append_event', { cycle, expected_rev: 0, op_id: 'alpha:' + cycle + ':open:1',
      type: 'checkpoint', participant_id: alpha.pid, payload_json: '{"note":"ouverture du cycle CR-B"}' })).structuredContent.status).toBe('applied');

    // 2. alpha propose (rev 1 -> 2) : l'applied porte son effet memoire.
    const propose = await alpha.call('collab_append_event', { cycle, expected_rev: 1, op_id: 'alpha:' + cycle + ':propose:1',
      type: 'memory.propose', participant_id: alpha.pid, payload_json: proposeJson });
    expect(propose.structuredContent).toMatchObject({ status: 'applied', revision: 2, memory: { id: mid, version: 1, status: 'candidate' } });

    // 3. Rejeu du meme op_id : duplicate, une seule ligne memoire, pas de champ memory.
    const replay = await alpha.call('collab_append_event', { cycle, expected_rev: 1, op_id: 'alpha:' + cycle + ':propose:1',
      type: 'memory.propose', participant_id: alpha.pid, payload_json: proposeJson });
    expect(replay.structuredContent.status).toBe('duplicate');
    expect('memory' in replay.structuredContent).toBe(false);

    // 4. Auto-revue refusee : reviewer distinct de l'auteur, revision inchangee.
    expect(code(await alpha.call('collab_append_event', { cycle, expected_rev: 2, op_id: 'alpha:' + cycle + ':review:1',
      type: 'memory.review', participant_id: alpha.pid, payload_json: JSON.stringify({ memory: { id: mid, version: 1 } }) })))
      .toBe('MEMORY_SELF_ACTIVATION');

    // 5. beta (pair distinct) active la memoire (rev 2 -> 3).
    const review = await beta.call('collab_append_event', { cycle, expected_rev: 2, op_id: 'beta:' + cycle + ':review:1',
      type: 'memory.review', participant_id: beta.pid, payload_json: JSON.stringify({ memory: { id: mid, version: 1 } }) });
    expect(review.structuredContent).toMatchObject({ status: 'applied', revision: 3, memory: { id: mid, version: 1, status: 'active' } });

    // 6. get_context : la memoire active est dans le packet d'alpha, pas dans celui de beta (isolation C5).
    const ctxAlpha = await alpha.call('collab_get_context', { cycle });
    expect((ctxAlpha.structuredContent.packet as { memory: Array<Record<string, unknown>> }).memory)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: mid, version: 1, scope })]));
    const ctxBeta = await beta.call('collab_get_context', { cycle });
    expect(JSON.stringify((ctxBeta.structuredContent.packet as { memory: unknown }).memory)).not.toContain(mid);

    // 7. collab_export memory-md : alpha voit son scope participant, beta non.
    const expAlpha = await alpha.call('collab_export', { cycle, format: 'memory-md' });
    expect(expAlpha.structuredContent.content as string).toContain(mid);
    expect(expAlpha.structuredContent.content as string).toContain(text);
    const expBeta = await beta.call('collab_export', { cycle, format: 'memory-md' });
    expect(expBeta.structuredContent.content as string).not.toContain(mid);

    // 8. beta consolide (rev 3 -> 4) : v1 superseded, v2 candidate.
    const consolidate = await beta.call('collab_append_event', { cycle, expected_rev: 3, op_id: 'beta:' + cycle + ':consolidate:1',
      type: 'memory.consolidate', participant_id: beta.pid,
      payload_json: JSON.stringify({ memory: { id: mid, text: text2, evidence_refs: ['ev:crb-2'] } }) });
    expect(consolidate.structuredContent).toMatchObject({ status: 'applied', revision: 4, memory: { id: mid, version: 2, status: 'candidate' } });

    // 9. Consolidation sans evidence_refs : payload invalide, rien ecrit.
    expect(code(await beta.call('collab_append_event', { cycle, expected_rev: 4, op_id: 'beta:' + cycle + ':consolidate:2',
      type: 'memory.consolidate', participant_id: beta.pid,
      payload_json: JSON.stringify({ memory: { id: mid, text: 'sans preuve' } }) }))).toBe('INVALID_MEMORY_PAYLOAD');

    // 10. alpha (auteur initial, different du consolidateur) reve v2 (rev 4 -> 5).
    const review2 = await alpha.call('collab_append_event', { cycle, expected_rev: 4, op_id: 'alpha:' + cycle + ':review:2',
      type: 'memory.review', participant_id: alpha.pid, payload_json: JSON.stringify({ memory: { id: mid, version: 2 } }) });
    expect(review2.structuredContent).toMatchObject({ status: 'applied', revision: 5, memory: { id: mid, version: 2, status: 'active' } });

    // 11. gamma retire (rev 5 -> 6) : tombstone durable, l'export ne contient plus la memoire.
    const retire = await gamma.call('collab_append_event', { cycle, expected_rev: 5, op_id: 'gamma:' + cycle + ':retire:1',
      type: 'memory.retire', participant_id: gamma.pid, payload_json: JSON.stringify({ memory: { id: mid } }) });
    expect(retire.structuredContent).toMatchObject({ status: 'applied', revision: 6, memory: { id: mid, version: 2, status: 'retired' } });
    const expAfter = await alpha.call('collab_export', { cycle, format: 'memory-md' });
    expect(expAfter.structuredContent.content as string).not.toContain(mid);

    // 12. Etat durable (lectures SQL uniquement) : lifecycle complet au couple journal/memoire.
    await ensureSchema(db);
    const rows = await db.prepare('SELECT version, status, supersedes FROM memory_entries WHERE id = ?1 ORDER BY version')
      .bind(mid).all<{ version: number; status: string; supersedes: string | null }>();
    expect(rows.results.map((r) => ({ v: r.version, s: r.status }))).toEqual([{ v: 1, s: 'superseded' }, { v: 2, s: 'retired' }]);
    expect(rows.results[1].supersedes).toBe(mid + '@1');
    const cycleRow = await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>();
    expect(cycleRow?.revision).toBe(6);

    // 13. Client non enregistre : memory.propose refuse avant tout effet (UNREGISTERED_CLIENT).
    const strangerId = uniq('memstranger');
    expect(code(await stranger.call('collab_append_event', { cycle, expected_rev: 6, op_id: 'stranger:' + cycle + ':propose:1',
      type: 'memory.propose', participant_id: stranger.pseudonym,
      payload_json: JSON.stringify({ memory: { id: strangerId, scope: 'common', kind: 'fact', text: 'insertion interdite', evidence_refs: ['ev:x'] } }) })))
      .toBe('UNREGISTERED_CLIENT');
    const ghost = await db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE id = ?1').bind(strangerId).first<{ n: number }>();
    expect(ghost?.n).toBe(0);
  });
});
