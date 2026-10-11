import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { e2eScenario, toolCode as code, type E2eClient } from './e2e-harness';

// CC-3 CR-F04 (github-mcp#96, contre-revue Codex #79/6096598889) par le vrai chemin
// HTTP : OAuth + /collab/mcp, D1 local. Aucune ligne memory_entries écrite en SQL :
// les SELECT ne servent qu'à prouver l'état. Référence temporelle (décision Kevin) :
// la révision du cycle d'origine de l'hypothèse ; un autre cycle ne la fait jamais expirer.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

type Agent = E2eClient & { pid: string };

async function revision(cycle: string): Promise<number> {
  return (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())?.revision ?? 0;
}

let op = 0;
async function append(agent: Agent, cycle: string, type: string, payload: Record<string, unknown>) {
  return agent.call('collab_append_event', { cycle, expected_rev: await revision(cycle), op_id: `${agent.pid}:${cycle}:crf4-${++op}:1`,
    type, participant_id: agent.pid, payload_json: JSON.stringify(payload) });
}

async function advanceTo(agent: Agent, cycle: string, target: number): Promise<void> {
  while (await revision(cycle) < target) {
    expect((await append(agent, cycle, 'checkpoint', { note: 'checkpoint ' + op })).structuredContent.status).toBe('applied');
  }
}

async function status(id: string, version = 1): Promise<string | undefined> {
  return (await db.prepare('SELECT status FROM memory_entries WHERE id = ?1 AND version = ?2').bind(id, version).first<{ status: string }>())?.status;
}

/** Preuves visibles par l'agent : packet de contexte et export memory-md. */
async function visible(agent: Agent, cycle: string, id: string): Promise<{ context: boolean; export: boolean }> {
  const ctx = await agent.call('collab_get_context', { cycle });
  const exp = await agent.call('collab_export', { cycle, format: 'memory-md' });
  return {
    context: JSON.stringify((ctx.structuredContent.packet as { memory: unknown }).memory).includes(id),
    export: (exp.structuredContent.content as string).includes(id),
  };
}

async function snapshot(cycle: string) {
  const e = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
  const m = await db.prepare('SELECT COUNT(*) AS n FROM memory_entries').first<{ n: number }>();
  return { revision: await revision(cycle), events: e?.n ?? 0, rows: m?.n ?? 0 };
}

const hypothesis = (id: string, scope: string, text: string) =>
  ({ memory: { id, scope, kind: 'observation', text, evidence_refs: ['ev:' + id], confidence: 'hypothesis' } });

describe('CC-3 CR-F04 — expiration des hypothèses par le journal (HTTP)', () => {
  it('proposée/activée → visible ; autre cycle loin devant → toujours visible ; échéance du cycle d’origine → retirée, absente du contexte et de l’export', async () => {
    const { agent, uniq } = e2eScenario(db, 'crf4', 'owner-secret-CRF4-0123456789abcdefghijklm');
    const [alpha, beta] = [await agent('alpha'), await agent('beta')];
    const [a, b] = [uniq('cycle-a'), uniq('cycle-b')];
    const scope = 'common';
    const h = uniq('hyp');

    // A rev 1 : proposition (échéance = 1 + 3 = 4, dans A) ; A rev 2 : revue par un pair.
    expect((await append(alpha, a, 'memory.propose', hypothesis(h, scope, 'hypothèse partagée inter-cycles'))).structuredContent)
      .toMatchObject({ status: 'applied', revision: 1, memory: { id: h, version: 1, status: 'candidate' } });
    expect((await append(beta, a, 'memory.review', { memory: { id: h, version: 1 } })).structuredContent.status).toBe('applied');
    await advanceTo(alpha, b, 1);
    expect(await visible(beta, b, h)).toEqual({ context: true, export: true });

    // Le cycle B (révisions indépendantes) dépasse largement 4 : aucune expiration croisée.
    await advanceTo(alpha, b, 12);
    expect(await status(h)).toBe('active');
    expect(await visible(beta, b, h)).toEqual({ context: true, export: true });

    // A rev 3 : encore active. A rev 4 : l'échéance est atteinte dans la transaction de l'append.
    await advanceTo(alpha, a, 3);
    expect(await status(h)).toBe('active');
    await advanceTo(alpha, a, 4);
    expect(await status(h)).toBe('retired');
    expect(await visible(beta, b, h)).toEqual({ context: false, export: false });
    expect(await visible(alpha, a, h)).toEqual({ context: false, export: false });

    // Plus aucune mutation : consolidation impossible (plus active), revue impossible.
    expect(code(await append(alpha, a, 'memory.consolidate', { memory: { id: h, text: 'trop tard', evidence_refs: ['ev:late'] } })))
      .toBe('MEMORY_NO_ACTIVE');
  });

  it('renouvellement contrôlé : consolider avant l’échéance ouvre une fenêtre depuis le cycle qui consolide ; revue à l’échéance refusée sans écriture', async () => {
    const { agent, uniq } = e2eScenario(db, 'crf4r', 'owner-secret-CRF4R-0123456789abcdefghijk');
    const [alpha, beta] = [await agent('alpha'), await agent('beta')];
    const [a, b] = [uniq('cycle-a'), uniq('cycle-b')];
    const scope = 'common';
    const h = uniq('hyp');
    await append(alpha, a, 'memory.propose', hypothesis(h, scope, 'hypothèse à renouveler'));     // A rev 1 → échéance 4
    await append(beta, a, 'memory.review', { memory: { id: h, version: 1 } });                    // A rev 2
    await advanceTo(alpha, b, 7);

    // Consolidation dans B (rev 8) : v2 candidate, échéance 11 DANS B ; v1 superseded.
    expect((await append(alpha, b, 'memory.consolidate', { memory: { id: h, text: 'hypothèse renouvelée', evidence_refs: ['ev:renew'] } }))
      .structuredContent).toMatchObject({ status: 'applied', revision: 8, memory: { id: h, version: 2, status: 'candidate' } });
    expect(await db.prepare('SELECT expires_rev, expires_cycle FROM memory_entries WHERE id = ?1 AND version = 2').bind(h).first())
      .toEqual({ expires_rev: 11, expires_cycle: b });
    // L'ancienne échéance (A rev 4) ne retire pas la version renouvelée.
    await advanceTo(alpha, a, 6);
    expect(await status(h, 2)).toBe('candidate');

    // B rev 10 : la revue à la révision 11 serait l'échéance → refus typé, rien d'écrit.
    await advanceTo(alpha, b, 10);
    const before = await snapshot(b);
    expect(code(await append(beta, b, 'memory.review', { memory: { id: h, version: 2 } }))).toBe('MEMORY_HYPOTHESIS_EXPIRED');
    expect(await snapshot(b)).toEqual(before);

    // Renouvellement réussi d'une autre hypothèse : revue avant l'échéance → active, visible, puis expire à son tour.
    const k = uniq('hyp2');
    await append(alpha, b, 'memory.propose', hypothesis(k, scope, 'seconde hypothèse'));         // B rev 11 → échéance 14 ; h v2 expire ici
    expect(await status(h, 2)).toBe('retired');
    expect((await append(beta, b, 'memory.review', { memory: { id: k, version: 1 } })).structuredContent.status).toBe('applied'); // B rev 12
    expect(await visible(beta, a, k)).toEqual({ context: true, export: true });
    await advanceTo(alpha, b, 14);
    expect(await status(k)).toBe('retired');
    expect(await visible(beta, a, k)).toEqual({ context: false, export: false });
  });
});
