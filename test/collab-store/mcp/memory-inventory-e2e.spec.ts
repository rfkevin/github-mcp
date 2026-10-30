import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { e2eScenario, toolCode as code, type E2eClient } from './e2e-harness';

// CC-7 M1b (correctif revue GPT-6, PR #236) par le vrai chemin HTTP :
// collab_memory_inventory lit le D1 — coûts PERSISTÉS dès la proposition
// (migration 0003), CR-C (ni contenu ni agrégat des scopes privés tiers),
// pagination keyset, pauses reliées aux événements correctifs — et
// collab_memory_growth_simulate est un calcul pur (zéro lecture du store).
// Les deux outils sont en lecture seule : aucun append mémoire ne vient d'eux ;
// les SELECT directs ne servent qu'à prouver l'état.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const ALARM_CYCLE = 'memory-alarms';

type Agent = E2eClient & { pid: string };

async function revision(cycle: string): Promise<number> {
  return (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())?.revision ?? 0;
}

async function append(agent: Agent, cycle: string, op: string, type: string, memory: Record<string, unknown>) {
  return agent.call('collab_append_event', { cycle, expected_rev: await revision(cycle),
    op_id: agent.pid + ':' + cycle + ':' + op + ':1', type, participant_id: agent.pid,
    payload_json: JSON.stringify({ memory }) });
}

const fact = (id: string, scope: string, text: string) =>
  ({ id, scope, kind: 'fact', text, evidence_refs: ['ev:m1b-' + text.length], confidence: 'observed' });

interface InventoryEntry { id: string; version: number; scope: string; status: string; token_cost: number; supersedes: string | null }
interface InventoryPause { occurrence: number; reason: string; request_id: string; opened_seq: number; opened_at: number;
  decision: string | null; decided_at: number | null; open: boolean;
  corrective_events: Array<{ seq: number; at: number; type: string; cycle_id: string; id: string }>; corrective_truncated: boolean }
interface InventoryScope { scope: string; tokens_active: number;
  counts: { candidate: number; active: number; superseded: number; retired: number };
  baseline: number; occurrences: number; paused: boolean; pauses: InventoryPause[] }
interface Inventory { entries: InventoryEntry[]; has_more: boolean; next_cursor?: string; scopes: InventoryScope[] }

const inventory = (client: E2eClient, args: Record<string, unknown>): Promise<Inventory> =>
  client.call('collab_memory_inventory', args).then(result => result.structuredContent as unknown as Inventory);

const simulate = (client: E2eClient, args: Record<string, unknown>) =>
  client.call('collab_memory_growth_simulate', args).then(result => result.structuredContent as unknown as {
    rule: { growth_alarm_percent: number };
    growth: Array<{ k: number; pauses: number[] }>;
    budget?: { accepted: number; refused: number; tokens_after: number };
  });

describe('CC-7 M1b — inventaire mémoire ré-exécutable et simulation des seuils (HTTP)', () => {
  it('CR-C : ni contenu ni agrégat des scopes privés tiers ; anonyme = partagés seulement', async () => {
    const { agent, client, uniq } = e2eScenario(db, 'm1ba', 'owner-secret-M1BA-0123456789abcdefghij');
    const [alpha, beta] = [await agent('alpha'), await agent('beta')];
    const cycle = uniq('cycle');
    const privateScope = 'participant:' + alpha.pid;
    const id = uniq('mem');
    // Mémoire privée d'alpha (X2) : proposition puis auto-revue bornée du propriétaire.
    expect((await append(alpha, cycle, 'p1', 'memory.propose',
      { id, scope: privateScope, kind: 'observation', text: 'privee alpha', evidence_refs: ['ev:m1ba-1'], confidence: 'observed' }))
      .structuredContent.status).toBe('applied');
    expect((await append(alpha, cycle, 'r1', 'memory.review', { id, version: 1 })).structuredContent.status).toBe('applied');
    // Un tiers demande le scope privé d'alpha : refus typé, aucun contenu révélé.
    expect(code(await beta.call('collab_memory_inventory', { scopes: [privateScope] }))).toBe('MEMORY_SCOPE_FORBIDDEN');
    // Sans filtre : l'inventaire de beta ne contient ni entrée ni rollup de scope participant.
    const seen = await inventory(beta, {});
    expect(seen.entries.every(entry => !entry.scope.startsWith('participant:'))).toBe(true);
    expect(seen.scopes.every(scope => !scope.scope.startsWith('participant:'))).toBe(true);
    // Le propriétaire voit son scope privé : contenu, coût persisté et agrégat.
    const own = await inventory(alpha, { scopes: [privateScope] });
    expect(own.entries).toHaveLength(1);
    expect(own.entries[0]).toMatchObject({ id, version: 1, status: 'active', scope: privateScope });
    expect(own.entries[0].token_cost).toBe((await db.prepare('SELECT token_cost FROM memory_entries WHERE id = ?1 AND version = 1')
      .bind(id).first<{ token_cost: number }>())!.token_cost);
    expect(own.scopes).toHaveLength(1);
    expect(own.scopes[0]).toMatchObject({ scope: privateScope, paused: false, occurrences: 0, baseline: 1 });
    expect(own.scopes[0].counts).toEqual({ candidate: 0, active: 1, superseded: 0, retired: 0 });
    // Client non enregistré : aucun scope participant ne lui est accessible.
    const anon = await client();
    expect(code(await anon.call('collab_memory_inventory', { scopes: [privateScope] }))).toBe('MEMORY_SCOPE_FORBIDDEN');
    const anonAll = await inventory(anon, {});
    expect(anonAll.entries.every(entry => !entry.scope.startsWith('participant:'))).toBe(true);
    expect(anonAll.scopes.every(scope => !scope.scope.startsWith('participant:'))).toBe(true);
  }, 30_000);

  it('pagination keyset : 6 entrées, limit 2 → 3 pages ; token_cost persisté dès la proposition ; curseur illisible refusé', async () => {
    const { agent, uniq } = e2eScenario(db, 'm1bp', 'owner-secret-M1BP-0123456789abcdefghij');
    const [alpha, beta] = [await agent('alpha'), await agent('beta')];
    const cycle = uniq('cycle');
    const scope = 'project:' + uniq('page');
    const ids = [0, 1, 2, 3, 4, 5].map(n => uniq('mem' + String(n).padStart(2, '0')));
    const texts = ids.map((_, n) => 'fait partage numero ' + n + ' pour la pagination m1bp');
    for (const [n, id] of ids.entries()) {
      expect((await append(alpha, cycle, 'p' + n, 'memory.propose', fact(id, scope, texts[n]))).structuredContent.status).toBe('applied');
    }
    // Le coût lu par l'outil EST le token_cost persisté (0003), égal au recalcul canonique.
    const all = await inventory(beta, { scopes: [scope], limit: 200 });
    expect(all.entries).toHaveLength(6);
    for (const [n, id] of ids.entries()) {
      const entry = all.entries.find(item => item.id === id)!;
      expect(entry.token_cost).toBe(Math.ceil(texts[n].length / 4));
      expect(entry.token_cost).toBe((await db.prepare('SELECT token_cost FROM memory_entries WHERE id = ?1 AND version = 1')
        .bind(id).first<{ token_cost: number }>())!.token_cost);
    }
    // 3 pages de 2 : curseur keyset transmis tel quel, ordre (scope, id, version) stable.
    const pages: InventoryEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const result = await inventory(beta, { scopes: [scope], limit: 2, ...(cursor ? { cursor } : {}) });
      expect(result.entries).toHaveLength(2);
      pages.push(...result.entries);
      expect(result.has_more).toBe(page < 2);
      cursor = result.next_cursor;
      if (page < 2) expect(cursor).toBeTruthy();
    }
    expect(cursor).toBeUndefined();
    expect(pages.map(entry => entry.id)).toEqual([...pages.map(entry => entry.id)].sort());
    expect(new Set(pages.map(entry => entry.id)).size).toBe(6);
    // Sémantique documentée du curseur : une POSITION dans l'ordre global
    // (scope, id, version) — les filtres s'appliquent à chaque appel, indépendamment
    // de la position ; le scope du curseur reste soumis à CR-C.
    const pageA = await inventory(beta, { scopes: [scope], limit: 2 });
    const position = pageA.next_cursor!;
    const filtered = await inventory(beta, { scopes: [scope], limit: 2, cursor: position, status: 'candidate' });
    expect(filtered.entries).toHaveLength(2);
    expect(filtered.entries.every(entry => entry.status === 'candidate')).toBe(true);
    expect(filtered.entries[0].id > pageA.entries[1].id).toBe(true);
    // Rollup du scope projet : 6 candidates, aucun token actif, budget famille project.
    expect(all.scopes[0]).toMatchObject({ scope, budget: 2000, tokens_active: 0 });
    expect(all.scopes[0].counts).toEqual({ candidate: 6, active: 0, superseded: 0, retired: 0 });
    // Curseur illisible : refus typé MEMORY_CURSOR_INVALID, jamais une page devinée.
    expect(code(await beta.call('collab_memory_inventory', { scopes: [scope], cursor: '###pas-du-base64###' }))).toBe('MEMORY_CURSOR_INVALID');
    expect(code(await beta.call('collab_memory_inventory', { scopes: [scope], cursor: btoa('[]') }))).toBe('MEMORY_CURSOR_INVALID');
  }, 30_000);

  it('lifecycle multi-versions : v1 superseded, v2 retirée, filtre par statut, supersedes id@1', async () => {
    const { agent, uniq } = e2eScenario(db, 'm1bv', 'owner-secret-M1BV-0123456789abcdefghij');
    const [alpha, beta, gamma] = [await agent('alpha'), await agent('beta'), await agent('gamma')];
    const cycle = uniq('cycle');
    const scope = 'role:' + uniq('life');
    const id = uniq('mem');
    expect((await append(alpha, cycle, 'p1', 'memory.propose', fact(id, scope, 'vie v1'))).structuredContent.status).toBe('applied');
    expect((await append(beta, cycle, 'r1', 'memory.review', { id, version: 1 })).structuredContent.status).toBe('applied');
    expect((await append(gamma, cycle, 'c2', 'memory.consolidate', { id, text: 'vie v2', evidence_refs: ['ev:m1bv-2'] })).structuredContent.status).toBe('applied');
    expect((await append(alpha, cycle, 'r2', 'memory.review', { id, version: 2 })).structuredContent.status).toBe('applied');
    expect((await append(beta, cycle, 'x2', 'memory.retire', { id })).structuredContent.status).toBe('applied');
    const all = await inventory(gamma, { scopes: [scope] });
    expect(all.entries).toEqual([
      expect.objectContaining({ id, version: 1, status: 'superseded', supersedes: null }),
      expect.objectContaining({ id, version: 2, status: 'retired', supersedes: id + '@1' }),
    ]);
    expect(all.scopes[0]).toMatchObject({ scope, tokens_active: 0 });
    expect(all.scopes[0].counts).toEqual({ candidate: 0, active: 0, superseded: 1, retired: 1 });
    // Filtre par statut : la page ne montre que les retirées ; le rollup reste multi-statuts.
    const retired = await inventory(gamma, { scopes: [scope], status: 'retired' });
    expect(retired.entries).toEqual([expect.objectContaining({ id, version: 2, status: 'retired' })]);
    expect(retired.scopes[0].counts).toEqual({ candidate: 0, active: 0, superseded: 1, retired: 1 });
  }, 30_000);

  it('pause → consolidation corrective → approbation owner → rechute : occurrences et fenêtres correctives', async () => {
    const { owner, agent, uniq } = e2eScenario(db, 'm1bc', 'owner-secret-M1BC-0123456789abcdefghij');
    const [alpha, beta] = [await agent('alpha'), await agent('beta')];
    const cycle = uniq('cycle');
    const scope = 'role:' + uniq('corr');
    const ids = [0, 1, 2, 3].map(n => uniq('mem' + n));
    for (const [n, id] of ids.entries()) {
      expect((await append(alpha, cycle, 'p' + n, 'memory.propose', fact(id, scope, 'fait partage numero ' + n)))
        .structuredContent.status).toBe('applied');
    }
    const review = (n: number) => append(beta, cycle, 'r' + n, 'memory.review', { id: ids[n], version: 1 });
    const counted = async (key: string): Promise<number> =>
      (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(key).first<{ writes: number }>())?.writes ?? 0;
    const actives = async (): Promise<number> =>
      (await db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE scope = ?1 AND status = 'active'")
        .bind(scope).first<{ n: number }>())?.n ?? 0;
    expect((await review(0)).structuredContent.status).toBe('applied');
    // Sonde SQL après la 1re activation : chaque entrée de la règle de croissance
    // (100 * actives > 125 * baseline) est prouvée en SQL avant la 2e revue —
    // isole le défaut vu aux CI 41064884335 et 41066919021 (pause restée à 0).
    expect(await actives()).toBe(1);
    expect(await counted('mem:base:' + scope)).toBe(1);
    expect(await counted('mem:occ:' + scope)).toBe(0);
    expect(await counted('mem:pause:' + scope)).toBe(0);
    // 2e activation : +100 % > 25 % → pause posée dans le batch, occurrence 1.
    expect((await review(1)).structuredContent.status).toBe('applied');
    // Preuve SQL (canon memory-pause-resume-e2e) : la pause, l’occurrence et la
    // base de croissance sont posées par le batch d’activation lui-même. Cette
    // preuve précède toute lecture par l’outil inventaire : elle isole « alarme
    // posée par le store » de « rollup rendu par l’outil ».
    expect(await actives()).toBe(2);
    expect(await counted('mem:pause:' + scope)).toBe(1);
    expect(await counted('mem:occ:' + scope)).toBe(1);
    expect(await counted('mem:base:' + scope)).toBe(1);
    // Pendant la pause : une consolidation corrective sur la première active.
    expect((await append(alpha, cycle, 'ccorr', 'memory.consolidate',
      { id: ids[0], text: 'consolidation corrective pendant la pause', evidence_refs: ['ev:m1bc-c'] })).structuredContent.status).toBe('applied');
    const before = await inventory(alpha, { scopes: [scope] });
    expect(before.scopes[0]).toMatchObject({ scope, paused: true, occurrences: 1, baseline: 1 });
    expect(before.scopes[0].pauses).toHaveLength(1);
    const pause1 = before.scopes[0].pauses[0];
    expect(pause1).toMatchObject({ occurrence: 1, reason: 'growth', open: true, decision: null, decided_at: null });
    // L'occurrence ouverte porte SA consolidation corrective, résolue id → scope (CR-D).
    expect(pause1!.corrective_events).toHaveLength(1);
    expect(pause1!.corrective_events[0]).toMatchObject({ type: 'memory.consolidate', id: ids[0], cycle_id: cycle });
    expect(pause1!.corrective_truncated).toBe(false);
    // Approbation owner exacte (request_seq = opened_seq, cycle memory-alarms) : reprise.
    const approved = await owner({ action: 'decide', request_id: pause1!.request_id, decision: 'approve',
      request_seq: String(pause1!.opened_seq), cycle_id: ALARM_CYCLE });
    expect(approved.status).toBe(200);
    // Rechute : la 3e activation rouvre l'occurrence 2 — sa fenêtre ne contient pas la
    // consolidation d'avant son ouverture (borne d'ouverture par seq : l'horloge
    // à la seconde ne départage pas deux événements de la même seconde).
    expect((await review(2)).structuredContent.status).toBe('applied');
    const after = await inventory(alpha, { scopes: [scope] });
    expect(after.scopes[0]).toMatchObject({ scope, paused: true, occurrences: 2, baseline: 1 });
    const pauses = after.scopes[0].pauses;
    expect(pauses.map(pause => pause.occurrence)).toEqual([2, 1]);
    expect(pauses[0]).toMatchObject({ occurrence: 2, open: true, decision: null });
    expect(pauses[0]!.corrective_events).toEqual([]);
    // L'occurrence 1 approuvée : fermée, décision enregistrée, fenêtre close sur la consolidation.
    expect(pauses[1]).toMatchObject({ occurrence: 1, open: false, decision: 'approve' });
    expect(pauses[1]!.decided_at).not.toBeNull();
    expect(pauses[1]!.decided_at).toBeGreaterThanOrEqual(pauses[1]!.opened_at);
    expect(pauses[1]!.corrective_events.map(event => event.type)).toEqual(['memory.consolidate']);
    // L'inventaire reste lecture seule même sur un scope en pause (aucun refus).
    expect(code(await beta.call('collab_memory_inventory', { scopes: [scope] }))).toBeUndefined();
  }, 60_000);

  it('collab_memory_growth_simulate : calcul pur S1/S2/S3 du rapport, défauts, aucune lecture du store', async () => {
    const { agent } = e2eScenario(db, 'm1bs', 'owner-secret-M1BS-0123456789abcdefghij');
    const alpha = await agent('alpha');
    // S1 — relevé initial (base 2, 7 activations) : positions par marge candidate k.
    const s1 = await simulate(alpha, { base: 2, activations: 7, k_values: [0, 3, 5, 8, 10] });
    expect(s1.rule.growth_alarm_percent).toBe(25);
    expect(s1.growth).toEqual([
      { k: 0, pauses: [3, 4, 6, 8] },
      { k: 3, pauses: [6] },
      { k: 5, pauses: [8] },
      { k: 8, pauses: [] },
      { k: 10, pauses: [] },
    ]);
    // S3 — même base, 38 activations : cascades de reprise simulée (base ← n).
    const s3 = await simulate(alpha, { base: 2, activations: 38, k_values: [0, 10] });
    expect(s3.growth).toEqual([
      { k: 0, pauses: [3, 4, 6, 8, 11, 14, 18, 23, 29, 37] },
      { k: 10, pauses: [13, 24, 35] },
    ]);
    // S2 — projection budget à coût moyen 124,6 : 10 acceptées, la 11e refusée, 1398/1500.
    const s2 = await simulate(alpha, { base: 2, activations: 10, k_values: [0],
      budget: { tokens_used: 152, avg_cost: 124.6, budget: 1500 } });
    expect(s2.budget).toMatchObject({ accepted: 10, refused: 11, tokens_after: 1398 });
    // avg_cost = 0 : aucun refus prévisible — refus typé fail-closed, jamais une
    // boucle infinie (tokens_used <= budget comme tokens_used > budget).
    expect(code(await alpha.call('collab_memory_growth_simulate', { base: 2, activations: 10, k_values: [0],
      budget: { tokens_used: 152, avg_cost: 0, budget: 1500 } }))).toBe('MEMORY_SIMULATION_INVALID');
    expect(code(await alpha.call('collab_memory_growth_simulate', { base: 2, activations: 10, k_values: [0],
      budget: { tokens_used: 1501, avg_cost: 0, budget: 1500 } }))).toBe('MEMORY_SIMULATION_INVALID');
    // Défauts : base 2, activations 40, k 0/3/5/8/10, sans projection budget.
    const defaults = await simulate(alpha, {});
    expect(defaults.growth.map(item => item.k)).toEqual([0, 3, 5, 8, 10]);
    expect(defaults.budget).toBeUndefined();
    expect(defaults.growth.find(item => item.k === 0)!.pauses).toEqual([3, 4, 6, 8, 11, 14, 18, 23, 29, 37]);
  }, 30_000);
});
