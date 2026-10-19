import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { readDecisions, runController } from '../../../src/collab-store/controller';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

// CC-5 L3 — passage du contrôleur sur un vrai D1 : instantané en un lot,
// journal append-only idempotent, HALT, mode dégradé, familles d'identité.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let counter = 0;
const uniq = (label: string) => 'l3c-' + label + '-' + (++counter);
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const STATE = [
  '# T state', 'schema_version: CC-STATE-1', 'workflow_id: CC-T', 'revision: 2', 'base_revision: 1', 'next_action: test',
  'canonical_ref: main', 'based_on_sha: abc1234', 'phase: P6', 'framing_version: F', 'framing_ref: x', 'plan_version: P',
  'plan_ref: x', 'execution_ref: x', 'contract_ref: x', 'acceptance_ref: x', '',
  '## Owner decisions', '- Kevin, test.', '',
  '## Roles', '| Actor | Scoped acceptance/assignment | Pending evidence |', '| --- | --- | --- |', '| A | author | x |', '',
  '## Tasks', '| id | status | owner | role | reviewer | tester | owned_paths | dependencies | blocker | version | ref | next_action |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| l0 | in_progress | A | author | B | C | none | none | none | 1 | x | x |',
  '| l1 | blocked | B | author | C | A | none | l0 | none | 1 | x | x |', '',
  '## Evidence', '| source | state |', '| --- | --- |', '| x | y |', '',
].join('\n');

async function seed(cycle: string, owner = 'l3-vibe', reviewer = 'l3-grok', tester = 'l3-claude'): Promise<void> {
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: 'l0', cycle, owner, reviewer, tester });
  await insertEventRow(db, { cycle, type: 'owner.decision', participant: 'owner', role: 'owner',
    payload: { action: 'import_state', content: STATE }, key: 'owner-state-import:' + cycle + ':seed' });
}

async function evidence(cycle: string, pid: string, payload: unknown, n: number, ref = ''): Promise<void> {
  await insertEventRow(db, { cycle, type: 'evidence.add', participant: pid, role: 'reviewer', payload, key: cycle + ':ev:' + n });
  if (ref) await db.prepare('UPDATE events SET evidence_ref = ?1 WHERE idempotency_key = ?2').bind(ref, cycle + ':ev:' + n).run();
}

async function setHalt(on: boolean): Promise<void> {
  await ensureSchema(db);
  await db.prepare("INSERT INTO owner_flags (name, value, event_seq, updated_at) VALUES ('halt', ?1, 0, 0) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
    .bind(on ? '1' : '0').run();
}

describe('CC-5 L3 — runController (D1)', () => {
  it('journalise une fois : un second passage sur le même état n\'écrit rien', async () => {
    const cycle = uniq('idem');
    await seed(cycle);
    const first = await runController(db, cycle);
    expect(first).toMatchObject({ mode: 'active', recorded: 1 });
    expect(first.decisions).toMatchObject([{ kind: 'wake', actor: 'l3-vibe', action: 'implement' }]);
    expect(await runController(db, cycle)).toMatchObject({ mode: 'active', recorded: 0 });
    expect(await readDecisions(db, cycle)).toHaveLength(1);
  });

  it('suit la soumission puis les verdicts jusqu\'à merge_ready, chaque étape journalisée', async () => {
    const cycle = uniq('flow');
    await seed(cycle);
    await evidence(cycle, 'l3-vibe', { task: 'l0', state: 'done', review: 'head ' + HEAD + ' base ' + BASE }, 1, 'https://github.com/o/r/pull/9');
    expect((await runController(db, cycle)).decisions.map(d => d.action).sort()).toEqual(['review', 'test']);
    await evidence(cycle, 'l3-grok', { task: 'l0', state: 'AGREE', head: HEAD, base: BASE }, 2);
    await evidence(cycle, 'l3-claude', { task: 'l0', state: 'PASS', head: HEAD, base: BASE }, 3);
    expect((await runController(db, cycle)).decisions).toMatchObject([{ kind: 'merge_ready', actor: 'owner' }]);
    expect((await readDecisions(db, cycle)).map(row => row.kind)).toEqual(['wake', 'wake', 'merge_ready']);
  });

  it('famille d\'identité : un verdict de sol compte pour la tâche relue par gpt6', async () => {
    const cycle = uniq('family');
    await seed(cycle, 'l3-vibe', 'l3-gpt6', 'l3-claude');
    for (const pid of ['l3-gpt6', 'l3-sol']) {
      await db.prepare("INSERT INTO participants (participant_id, display_label, status) VALUES (?1, ?1, 'active') ON CONFLICT(participant_id) DO NOTHING")
        .bind(pid).run();
      await db.prepare("INSERT OR REPLACE INTO participant_identity_families (participant_id, family_id, updated_at) VALUES (?1, 'l3-chatgpt', 0)")
        .bind(pid).run();
    }
    await evidence(cycle, 'l3-vibe', { task: 'l0', review: 'head ' + HEAD + ' base ' + BASE }, 1, 'https://github.com/o/r/pull/9');
    await evidence(cycle, 'l3-sol', { task: 'l0', state: 'AGREE', head: HEAD, base: BASE }, 2);
    const { decisions } = await runController(db, cycle);
    expect(decisions.map(d => d.actor)).toEqual(['l3-claude']);
  });

  it('HALT : aucune décision, rien n\'est journalisé', async () => {
    const cycle = uniq('halt');
    await seed(cycle);
    await setHalt(true);
    try {
      expect(await runController(db, cycle)).toMatchObject({ mode: 'halted', recorded: 0 });
      expect(await readDecisions(db, cycle)).toHaveLength(0);
    } finally {
      await setHalt(false);
    }
  });

  it('mode dégradé : cycle inconnu ou état importé illisible → aucune décision', async () => {
    expect(await runController(db, uniq('missing'))).toMatchObject({ mode: 'degraded', error: 'UNKNOWN_CYCLE', decisions: [] });
    const cycle = uniq('broken');
    await insertCycleRow(db, cycle, 'P6');
    await insertPhaseDefinition(db, cycle, 'P6', []);
    await insertEventRow(db, { cycle, type: 'owner.decision', participant: 'owner', role: 'owner',
      payload: { content: 'pas un état' }, key: 'owner-state-import:' + cycle + ':bad' });
    expect(await runController(db, cycle)).toMatchObject({ mode: 'degraded', decisions: [], recorded: 0 });
  });

  it('journal append-only : modification et suppression refusées', async () => {
    const cycle = uniq('append');
    await seed(cycle);
    await runController(db, cycle);
    await expect(db.prepare("UPDATE controller_decisions SET reason = 'x' WHERE cycle_id = ?1").bind(cycle).run()).rejects.toThrow();
    await expect(db.prepare('DELETE FROM controller_decisions WHERE cycle_id = ?1').bind(cycle).run()).rejects.toThrow();
  });
});
