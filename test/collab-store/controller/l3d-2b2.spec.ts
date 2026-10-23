import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { readDecisions, relayLines, relayMessage, runController, type Decision } from '../../../src/collab-store/controller';
import { dashboardPage, type DashboardData } from '../../../src/collab-store/owner/page';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

// CC-5 L3d (incrément 2b-2a) — lignes « à relayer » sur /owner, en lecture seule.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let counter = 0;
const uniq = (label: string) => '0000-relay-' + label + '-' + (++counter);
const T0 = Date.UTC(2031, 5, 1, 8, 0, 0);

async function seed(cycle: string, owner: string): Promise<void> {
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: 'l0', cycle, owner, reviewer: owner + '-rev', tester: owner + '-test' });
}

async function setHalt(on: boolean): Promise<void> {
  await ensureSchema(db);
  await db.prepare("INSERT INTO owner_flags (name, value, event_seq, updated_at) VALUES ('halt', ?1, 0, 0) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
    .bind(on ? '1' : '0').run();
}

const linesOf = async (cycle: string) => (await relayLines(db)).filter(line => line.cycle_id === cycle);

describe('CC-5 L3d 2b-2a — message à relayer (pur)', () => {
  const base: Decision = { kind: 'wake', actor: 'vibe', task_id: 'l4', action: 'test', rule: 'awaiting-test',
    subject: 'a'.repeat(40) + '..' + 'b'.repeat(40), episode: 'e', reason: 'Soumission sans verdict du testeur.' };

  it('libellé, action, tâche, couple head/base abrégé, cycle et motif', () => {
    expect(relayMessage('cc5', 'Vibe GLM', base)).toBe(
      'Vibe GLM — tester (verdict D12) l4 au couple head/base aaaaaaa/bbbbbbb (cycle cc5) : Soumission sans verdict du testeur.');
  });

  it('sans couple SHA (sujet libre ou « none ») : pas de mention de couple', () => {
    const message = relayMessage('cc5', 'Claude', { ...base, action: 'implement', subject: 'none' });
    expect(message).toBe('Claude — implémenter la tâche l4 (cycle cc5) : Soumission sans verdict du testeur.');
    expect(relayMessage('cc5', 'Kevin', { ...base, task_id: null, action: 'answer_question', subject: 'q:5' })).not.toContain('couple');
  });
});

describe('CC-5 L3d 2b-2a — relayLines (D1, lecture seule)', () => {
  it('rend la décision courante avec le libellé du participant ; « depuis » vide avant journalisation puis égal à la 1re écriture', async () => {
    const cycle = uniq('label');
    await ensureSchema(db);
    await db.prepare("INSERT OR IGNORE INTO participants (participant_id, display_label, status) VALUES ('relay-vibe', 'Vibe Relay', 'active')").run();
    await seed(cycle, 'relay-vibe');
    const before = await linesOf(cycle);
    expect(before).toEqual([expect.objectContaining({ actor: 'relay-vibe', label: 'Vibe Relay', task_id: 'l0', action: 'implement', since: null })]);
    expect(before[0].message).toContain('Vibe Relay — implémenter la tâche l0');
    await runController(db, cycle, { now: () => new Date(T0) });
    expect((await linesOf(cycle))[0].since).toBe(Math.floor(T0 / 1000));
  });

  it('participant sans libellé enregistré : identifiant serveur affiché', async () => {
    const cycle = uniq('nolabel');
    await seed(cycle, 'relay-unknown');
    expect((await linesOf(cycle))[0]).toMatchObject({ actor: 'relay-unknown', label: 'relay-unknown' });
  });

  it('n\'écrit rien : ni journal du contrôleur ni révision du cycle', async () => {
    const cycle = uniq('readonly');
    await seed(cycle, 'relay-ro');
    const revision = async () => (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())!.revision;
    const rev0 = await revision();
    await relayLines(db);
    await relayLines(db);
    expect(await readDecisions(db, cycle)).toHaveLength(0);
    expect(await revision()).toBe(rev0);
  });

  it('HALT : aucun message pour le cycle', async () => {
    const cycle = uniq('halt');
    await seed(cycle, 'relay-halt');
    await setHalt(true);
    try {
      expect(await linesOf(cycle)).toEqual([]);
    } finally {
      await setHalt(false);
    }
    expect(await linesOf(cycle)).toHaveLength(1);
  });

  it('cycle fermé ignoré', async () => {
    const cycle = uniq('closed');
    await insertCycleRow(db, cycle, 'P6', 'closed');
    await insertPhaseDefinition(db, cycle, 'P6', []);
    await insertTaskRow(db, { taskId: 'l0', cycle, owner: 'relay-closed', reviewer: 'relay-closed-rev', tester: 'relay-closed-test' });
    expect(await linesOf(cycle)).toEqual([]);
  });
});

describe('CC-5 L3d 2b-2a — section « À relayer » de /owner', () => {
  const data = (relay: DashboardData['relay']): DashboardData => ({
    pending: { items: [], total: 0, next_before: null }, participants: [], clients: [], relay,
  });

  it('table échappée, sans formulaire ni script ; état vide explicite', () => {
    const html = dashboardPage({ mode: 'secret', secret: 'fixture-secret-0123456789abcdefghijkl' }, data([
      { cycle_id: 'c', actor: 'x', label: '<b>X</b>', task_id: 'l0', action: 'implement', message: 'faire <script>alert(1)</script>', since: 1700000000 },
    ]));
    const relayStart = html.indexOf('<h2 id="relay">');
    const section = html.slice(relayStart, html.indexOf('<h2', relayStart + 4));
    expect(section).toContain('<h2 id="relay">À relayer (1)</h2>');
    expect(section).toContain('&#60;b&#62;X&#60;/b&#62;');
    expect(section).toContain('faire &#60;script&#62;');
    expect(section).toContain('2023-11-14 22:13 UTC');
    expect(section).not.toMatch(/<form|<script|<input/);
    expect(dashboardPage({ mode: 'secret', secret: 'fixture-secret-0123456789abcdefghijkl' }, data([]))).toContain('Rien à relayer.');
  });
});

// --- Corrections revue GPT-6 / test Vibe (#174) ---

const STATE = [
  '# T state', 'schema_version: CC-STATE-1', 'workflow_id: CC-T', 'revision: 2', 'base_revision: 1', 'next_action: test',
  'canonical_ref: main', 'based_on_sha: abc1234', 'phase: P6', 'framing_version: F', 'framing_ref: x', 'plan_version: P',
  'plan_ref: x', 'execution_ref: x', 'contract_ref: x', 'acceptance_ref: x', '',
  '## Owner decisions', '- Kevin, test.', '',
  '## Roles', '| Actor | Scoped acceptance/assignment | Pending evidence |', '| --- | --- | --- |', '| A | author | x |', '',
  '## Tasks', '| id | status | owner | role | reviewer | tester | owned_paths | dependencies | blocker | version | ref | next_action |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| l0 | done | A | author | B | C | none | none | none | 1 | x | x |',
  '| l1 | blocked | B | author | C | A | none | l0 | none | 1 | x | x |', '',
  '## Evidence', '| source | state |', '| --- | --- |', '| x | y |', '',
].join('\n');

/** Cycle dont la tâche l1 est débloquable : décision « unblock » adressée au coordinateur. */
async function seedUnblock(cycle: string): Promise<void> {
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: 'l0', cycle, owner: 'u-a', reviewer: 'u-b', tester: 'u-c' });
  await insertTaskRow(db, { taskId: 'l1', cycle, owner: 'u-b', reviewer: 'u-c', tester: 'u-a' });
  await db.prepare("UPDATE tasks SET status = 'done' WHERE cycle_id = ?1 AND task_id = 'l0'").bind(cycle).run();
  await db.prepare("UPDATE tasks SET status = 'blocked' WHERE cycle_id = ?1 AND task_id = 'l1'").bind(cycle).run();
  await insertEventRow(db, { cycle, type: 'owner.decision', participant: 'owner', role: 'owner',
    payload: { action: 'import_state', content: STATE }, key: 'owner-state-import:' + cycle + ':seed' });
}

const MANDATES = 'CREATE TABLE IF NOT EXISTS delegated_mandates (cycle_id TEXT PRIMARY KEY, participant_id TEXT, family_id TEXT, epoch INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)';
const coordinatorLines = async (cycle: string, target: D1Database = db) =>
  (await relayLines(target)).filter(line => line.cycle_id === cycle && line.action === 'open_task');

describe('CC-5 L3d 2b-2a — décisions du coordinateur (revue #174)', () => {
  it('mandat présent : la ligne vise le titulaire, libellé « (coordinateur) »', async () => {
    const cycle = uniq('coord-held');
    await seedUnblock(cycle);
    await ensureSchema(db);
    await db.prepare("INSERT OR IGNORE INTO participants (participant_id, display_label, status) VALUES ('relay-coord', 'Coord Relay', 'active')").run();
    await db.prepare(MANDATES).run();
    await db.prepare("INSERT INTO delegated_mandates (cycle_id, participant_id, family_id, epoch, updated_at) VALUES (?1, 'relay-coord', 'relay-coord', 1, 0)").bind(cycle).run();
    expect(await coordinatorLines(cycle)).toEqual([expect.objectContaining({ actor: 'relay-coord', label: 'Coord Relay (coordinateur)', task_id: 'l1' })]);
  });

  it('poste vacant : la ligne revient à Kevin, libellé explicite', async () => {
    const cycle = uniq('coord-vacant');
    await seedUnblock(cycle);
    await db.prepare(MANDATES).run();
    expect(await coordinatorLines(cycle)).toEqual([expect.objectContaining({ actor: 'owner', label: 'Kevin (poste de coordinateur vacant)', task_id: 'l1' })]);
  });

  it('mandat illisible : aucune ligne coordinateur (jamais attribuée à tort), les autres lignes restent', async () => {
    const cycle = uniq('coord-broken');
    await seedUnblock(cycle);
    await db.prepare(MANDATES).run();
    const broken = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (/FROM delegated_mandates/.test(sql)) throw new Error('boom');
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await ensureSchema(broken);
    expect(await coordinatorLines(cycle, broken)).toEqual([]);
    expect(await coordinatorLines(cycle)).toHaveLength(1);
  });
});

describe('CC-5 L3d 2b-2a — lecture seule stricte (revue #174)', () => {
  it('schéma amorcé : relayLines n\'émet que des SELECT (aucun INSERT/UPDATE/DELETE/DDL)', async () => {
    const cycle = uniq('strict');
    await seedUnblock(cycle);
    await db.prepare(MANDATES).run();
    const statements: string[] = [];
    let recording = false;
    const spy = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (recording) statements.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await ensureSchema(spy); // amorçage fait avant, comme sur /owner
    recording = true;
    const lines = await relayLines(spy);
    recording = false;
    expect(lines.some(line => line.cycle_id === cycle)).toBe(true);
    expect(statements.length).toBeGreaterThan(0);
    const writes = statements.filter(sql => !/^\s*SELECT\b/i.test(sql));
    expect(writes).toEqual([]);
  });
});

describe('CC-5 L3d 2b-2a — /owner inchangé hors section (revue #174)', () => {
  it('mêmes sections et mêmes formulaires avec ou sans lignes à relayer', () => {
    const config = { mode: 'secret' as const, secret: 'fixture-secret-0123456789abcdefghijkl' };
    const base: DashboardData = { pending: { items: [], total: 0, next_before: null }, participants: [], clients: [] };
    const without = dashboardPage(config, base);
    const withRelay = dashboardPage(config, { ...base, relay: [
      { cycle_id: 'c', actor: 'x', label: 'X', task_id: 'l0', action: 'implement', message: 'm', since: null },
    ] });
    const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
    expect(count(withRelay, /<form\b/g)).toBe(count(without, /<form\b/g));
    expect(count(withRelay, /<h2>/g)).toBe(count(without, /<h2>/g));
    for (const heading of ['Demandes en attente', 'Automatisation', 'Mandat coordinateur par cycle (CC-5)']) {
      expect(withRelay).toContain(heading);
    }
    expect(withRelay.replace(/<h2 id="relay">À relayer[\s\S]*?(?=<h2)/, '')).toBe(without.replace(/<h2 id="relay">À relayer[\s\S]*?(?=<h2)/, ''));
  });
});
