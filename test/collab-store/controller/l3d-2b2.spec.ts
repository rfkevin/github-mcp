import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { readDecisions, relayLines, relayMessage, runController, type Decision } from '../../../src/collab-store/controller';
import { dashboardPage, type DashboardData } from '../../../src/collab-store/owner/page';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

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
    const section = html.slice(html.indexOf('<h2>À relayer'), html.indexOf('<h2>', html.indexOf('<h2>À relayer') + 4));
    expect(section).toContain('<h2>À relayer (1)</h2>');
    expect(section).toContain('&#60;b&#62;X&#60;/b&#62;');
    expect(section).toContain('faire &#60;script&#62;');
    expect(section).toContain('2023-11-14 22:13 UTC');
    expect(section).not.toMatch(/<form|<script|<input/);
    expect(dashboardPage({ mode: 'secret', secret: 'fixture-secret-0123456789abcdefghijkl' }, data([]))).toContain('Rien à relayer.');
  });
});
