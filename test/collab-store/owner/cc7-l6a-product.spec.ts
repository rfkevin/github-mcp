import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createOAuthFixture } from '../../oauth/helpers';
import { createProduct, planProduct, productCreateEnabled, proposalTaskId, PRODUCT_TEMPLATE_VERSION } from '../../../src/collab-store/owner/product';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { setAutomationHalt } from '../../../src/collab-store/owner/automation';
import { loadImportedState } from '../../../src/collab-store/export/state-export';
import { nextActors, readControllerSnapshot } from '../../../src/collab-store/controller';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { advanceGuarded } from '../../../src/collab-store/phases';
import { OWNER_PROOF, uniqueIds } from '../coordinator-helpers';

// CC-7 L6a — « Nouveau produit » en un prompt : un acte owner crée cycle, phases, tâches et matrice D12.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const uid = uniqueIds('l6a');
const GOAL = 'Construire un petit outil de notes.\n## Section piégée\n| a | b |\nkey: valeur';

async function team(count = 3): Promise<string[]> {
  await ensureSchema(db);
  const pids = Array.from({ length: count }, (_, index) => uid('p' + index));
  for (const pid of pids) {
    await registerParticipant(db, { participant_id: pid, display_label: 'Label ' + pid, proof: OWNER_PROOF, op: 'reg-' + pid });
  }
  return pids;
}

const count = async (sql: string, ...binds: unknown[]) =>
  (await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;

describe('CC-7 L6a — gabarit CC-PRODUCT-1 (fonction pure)', () => {
  it('rotation D12 : auteur i, relecteur i+1, testeur i+2 ; synthèse au premier participant', () => {
    const plan = planProduct({ cycle_id: 'prod-x', goal: GOAL, participants: ['a1', 'b2', 'c3', 'd4'] });
    expect(plan.tasks.map(t => [t.task_id, t.owner, t.reviewer, t.tester])).toEqual([
      ['p-a1', 'a1', 'b2', 'c3'], ['p-b2', 'b2', 'c3', 'd4'], ['p-c3', 'c3', 'd4', 'a1'], ['p-d4', 'd4', 'a1', 'b2'],
      ['synthesis', 'a1', 'b2', 'c3'],
    ]);
    expect(plan.tasks.at(-1)).toMatchObject({ status: 'blocked', dependencies: ['p-a1', 'p-b2', 'p-c3', 'p-d4'] });
    expect(plan.coordinator).toBe('a1');
    expect(plan.definitions.map(d => [d.phase, d.auto_advance])).toEqual([
      ['P1', 'product-p1'], ['P2', 'product-p2'], ['P3', 'product-p3'], ['P4', 'none'], ['P5', 'none'], ['P6', 'none']]);
    expect(plan.definitions[0].expected_outputs).toEqual([{ role: 'author', kind: 'proposal.submit', count: 4 }]);
    expect(plan.definitions[1].expected_outputs).toEqual([{ role: 'reviewer', kind: 'evidence.add', count: 4 }]);
    expect(plan.definitions[2].expected_outputs).toEqual([{ role: 'author', kind: 'proposal.submit', count: 1, task_id: 'synthesis' }]);
  });

  it('objectif cité : aucune ligne ne devient section, tableau ou en-tête de l’état', () => {
    const { markdown } = planProduct({ cycle_id: 'prod-x', goal: GOAL, participants: ['a1', 'b2', 'c3'] });
    expect(markdown).toContain('> ## Section piégée');
    expect(markdown).toContain('> | a | b |');
    expect(markdown).not.toMatch(/^## Section piégée$/m);
    expect(markdown).not.toMatch(/^key: valeur$/m);
  });

  it('refus : participants hors bornes, doublon, tâche en collision, objectif vide ou trop long, cycle ou dépôt invalide', () => {
    const base = { cycle_id: 'prod-x', goal: 'g', participants: ['a1', 'b2', 'c3'] };
    const code = (input: Partial<typeof base> & { repository?: string }) => {
      try { planProduct({ ...base, ...input }); return 'ok'; } catch (error) { return (error as { code: string }).code; }
    };
    expect(code({})).toBe('ok');
    expect(code({ participants: ['a1', 'b2'] })).toBe('PRODUCT_PARTICIPANTS');
    expect(code({ participants: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).toBe('PRODUCT_PARTICIPANTS');
    expect(code({ participants: ['a1', 'a1', 'c3'] })).toBe('PRODUCT_PARTICIPANTS');
    expect(code({ participants: ['agent:x', 'agent.x', 'c3'] })).toBe('PRODUCT_PARTICIPANTS');
    expect(code({ goal: '   ' })).toBe('PRODUCT_INVALID');
    expect(code({ goal: 'x'.repeat(4001) })).toBe('PRODUCT_INVALID');
    expect(code({ cycle_id: 'Bad Cycle' })).toBe('PRODUCT_INVALID');
    expect(code({ repository: 'pas un dépôt' })).toBe('PRODUCT_INVALID');
    expect(proposalTaskId('agent:Grok')).toBe('p-agent-grok');
  });

  it('porte : « true » exact seulement', () => {
    expect(productCreateEnabled(undefined)).toBe(false);
    expect(productCreateEnabled({ PRODUCT_CREATE_ENABLED: 'TRUE' })).toBe(false);
    expect(productCreateEnabled({ PRODUCT_CREATE_ENABLED: 'true' })).toBe(true);
  });
});

describe('CC-7 L6a — createProduct (un seul lot CAS)', () => {
  it('porte éteinte ou preuve déléguée : refus, rien n’est écrit', async () => {
    const pids = await team();
    const cycle = uid('c');
    await expect(createProduct(db, { enabled: false, cycle_id: cycle, goal: 'g', participants: pids, proof: OWNER_PROOF }))
      .rejects.toMatchObject({ code: 'PRODUCT_CREATE_DISABLED' });
    const delegated = { kind: 'delegated', subject: 's', cycle_id: cycle, epoch: 1, request_id: 'r', reviewer_pid: 'x',
      reviewer_family: 'f', expires_at: 0, params_hash: 'h', max_cost_cents: 0 } as const;
    await expect(createProduct(db, { enabled: true, cycle_id: cycle, goal: 'g', participants: pids, proof: delegated }))
      .rejects.toMatchObject({ code: 'DELEGATED_FORBIDDEN' });
    expect(await count('SELECT COUNT(*) AS n FROM cycles WHERE cycle_id = ?1', cycle)).toBe(0);
  });

  it('crée cycle, phases, tâches et base d’état ; le contrôleur réveille chaque auteur de P1 ; rejeu = duplicate', async () => {
    const pids = await team();
    const cycle = uid('c');
    const input = { enabled: true, cycle_id: cycle, goal: GOAL, participants: pids, repository: 'rfkevin/demo', proof: OWNER_PROOF };
    const result = await createProduct(db, input);
    expect(result).toMatchObject({ status: 'applied', cycle_id: cycle, template_version: PRODUCT_TEMPLATE_VERSION });
    expect(result.tasks.sort()).toEqual([...pids.map(proposalTaskId), 'synthesis'].sort());

    expect(await db.prepare('SELECT phase, project, status, revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first())
      .toEqual({ phase: 'P1', project: 'rfkevin/demo', status: 'open', revision: 1 });
    expect(await count('SELECT COUNT(*) AS n FROM phase_definitions WHERE cycle_id = ?1', cycle)).toBe(6);
    const tasks = await db.prepare('SELECT task_id, owner_pid, reviewer_pid, tester_pid, status FROM tasks WHERE cycle_id = ?1 ORDER BY task_id')
      .bind(cycle).all<Record<string, string>>();
    expect(tasks.results.find(t => t.task_id === 'synthesis')).toMatchObject({ owner_pid: pids[0], reviewer_pid: pids[1], tester_pid: pids[2], status: 'blocked' });
    for (const task of tasks.results) expect(new Set([task.owner_pid, task.reviewer_pid, task.tester_pid]).size).toBe(3);

    const event = JSON.parse(result.event.payload_json) as Record<string, unknown>;
    expect(event).toMatchObject({ action: 'create_product', goal: GOAL.trim(), participants: pids, coordinator: pids[0], proof_kind: 'secret' });
    const base = await loadImportedState(db, cycle);
    expect(base?.content).toContain('> Construire un petit outil de notes.');
    expect(base?.event_seq).toBe(result.event.seq);

    const snapshot = await readControllerSnapshot(db, cycle, async () => false);
    const woken = nextActors(snapshot).decisions.filter(d => d.rule === 'no-submission').map(d => d.task_id).sort();
    expect(woken).toEqual(pids.map(proposalTaskId).sort());

    const again = await createProduct(db, input);
    expect(again.status).toBe('duplicate');
    expect(again.event.seq).toBe(result.event.seq);
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'owner.decision'", cycle)).toBe(1);
  });

  it('P1 → P2 par la policy du gabarit, seulement quand chaque participant a scellé sa proposition', async () => {
    const pids = await team();
    const cycle = uid('c');
    await createProduct(db, { enabled: true, cycle_id: cycle, goal: 'g', participants: pids, proof: OWNER_PROOF });
    const store = new CollabStore(db, { dailyWriteLimit: 100_000 });
    const revision = async () => (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())!.revision;
    const propose = async (pid: string) => store.appendEvent({ cycle_id: cycle, type: 'proposal.submit', participant_id: pid, role: 'author',
      expected_rev: await revision(), op_id: pid.replace(/:/g, '.') + ':' + cycle + ':proposal:1',
      payload_json: JSON.stringify({ task: proposalTaskId(pid), content: 'idée de ' + pid }) });
    await propose(pids[0]);
    await propose(pids[1]);
    await expect(advanceGuarded(db, { cycle_id: cycle, expected_revision: await revision(), next_phase: 'P2' })).rejects.toBeTruthy();
    await propose(pids[2]);
    const advanced = await advanceGuarded(db, { cycle_id: cycle, expected_revision: await revision(), next_phase: 'P2' });
    expect(advanced.status).toBe('applied');
    expect(await db.prepare('SELECT phase FROM cycles WHERE cycle_id = ?1').bind(cycle).first()).toEqual({ phase: 'P2' });
  });

  it('cycle existant : PRODUCT_CYCLE_EXISTS, rien n’est modifié', async () => {
    const pids = await team();
    const cycle = uid('c');
    await db.prepare("INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P4', 7, 'open')").bind(cycle).run();
    await expect(createProduct(db, { enabled: true, cycle_id: cycle, goal: 'g', participants: pids, proof: OWNER_PROOF }))
      .rejects.toMatchObject({ code: 'PRODUCT_CYCLE_EXISTS' });
    expect(await db.prepare('SELECT phase, revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first()).toEqual({ phase: 'P4', revision: 7 });
    expect(await count('SELECT COUNT(*) AS n FROM tasks WHERE cycle_id = ?1', cycle)).toBe(0);
  });

  it('participant non enregistré ou familles confondues (#126) : refus avant toute écriture', async () => {
    const pids = await team();
    const cycle = uid('c');
    await expect(createProduct(db, { enabled: true, cycle_id: cycle, goal: 'g', participants: [...pids.slice(0, 2), uid('ghost')], proof: OWNER_PROOF }))
      .rejects.toMatchObject({ code: 'PRODUCT_PARTICIPANTS' });
    const family = uid('fam');
    await db.prepare('INSERT INTO participant_identity_families (participant_id, family_id, updated_at) VALUES (?1, ?3, 1), (?2, ?3, 1)')
      .bind(pids[0], pids[1], family).run();
    try {
      await expect(createProduct(db, { enabled: true, cycle_id: cycle, goal: 'g', participants: pids, proof: OWNER_PROOF }))
        .rejects.toMatchObject({ code: 'PRODUCT_FAMILIES' });
    } finally {
      await db.prepare('DELETE FROM participant_identity_families WHERE family_id = ?1').bind(family).run();
    }
    expect(await count('SELECT COUNT(*) AS n FROM cycles WHERE cycle_id = ?1', cycle)).toBe(0);
  });

  it('arrêt d’urgence posé : AUTOMATION_HALTED, rien n’est écrit', async () => {
    const pids = await team();
    const cycle = uid('c');
    await setAutomationHalt(db, { halted: true, proof: OWNER_PROOF, op: uid('halt') });
    try {
      await expect(createProduct(db, { enabled: true, cycle_id: cycle, goal: 'g', participants: pids, proof: OWNER_PROOF }))
        .rejects.toMatchObject({ code: 'AUTOMATION_HALTED' });
    } finally {
      await setAutomationHalt(db, { halted: false, proof: OWNER_PROOF, op: uid('resume') });
    }
    expect(await count('SELECT COUNT(*) AS n FROM cycles WHERE cycle_id = ?1', cycle)).toBe(0);
  });
});

describe('CC-7 L6a — formulaire /owner', () => {
  const SECRET = 'owner-secret-L6A-0123456789abcdefghijklmn';
  const fixture = (enabled: boolean) => createOAuthFixture({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true', OWNER_AUTH_MODE: 'secret',
    OWNER_SECRET: SECRET, ...(enabled ? { PRODUCT_CREATE_ENABLED: 'true' } : {}) });
  const post = (f: ReturnType<typeof createOAuthFixture>, fields: Record<string, string>) =>
    f.send('/owner', { method: 'POST', headers: { Origin: f.ORIGIN }, body: new URLSearchParams({ owner_secret: SECRET, ...fields }) });

  it('éteint : formulaire affiché avec la mention, création refusée (409) ; allumé : cycle créé', async () => {
    const pids = await team();
    const off = fixture(false);
    const view = await (await post(off, { action: 'view' })).text();
    expect(view).toContain('value="create_product"');
    expect(view).toContain('PRODUCT_CREATE_ENABLED n’est pas « true »');
    const cycle = uid('c');
    const fields = { action: 'create_product', cycle_id: cycle, participants: pids.join(', '), goal: 'Objectif', repository: '' };
    const refused = await post(off, fields);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('PRODUCT_CREATE_DISABLED');
    const created = await post(fixture(true), fields);
    expect(created.status).toBe(200);
    expect(await created.text()).toContain('Produit créé : ' + cycle);
    expect(await count('SELECT COUNT(*) AS n FROM tasks WHERE cycle_id = ?1', cycle)).toBe(4);
  });
});
