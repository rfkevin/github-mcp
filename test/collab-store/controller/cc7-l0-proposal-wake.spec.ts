import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { nextActors, readControllerSnapshot, taskProposal } from '../../../src/collab-store/controller';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { snapshot, task } from './fixtures';

// CC-7 L0 — une tâche remise par proposal.submit (conception, sans PR) ne réveille plus son auteur « no-submission ».

describe('CC-7 L0 — règles : proposition déposée', () => {
  it('sans proposition ni soumission → réveil implement (inchangé)', () => {
    expect(nextActors(snapshot([task()])).decisions)
      .toMatchObject([{ kind: 'wake', actor: 'vibe', action: 'implement', rule: 'no-submission' }]);
  });

  it('proposition de l\'auteur sans PR → aucun réveil de l\'auteur', () => {
    expect(nextActors(snapshot([task({ proposal: { seq: 12 } })])).decisions).toEqual([]);
  });

  it('une demande de correction reste prioritaire sur la proposition', () => {
    const { decisions } = nextActors(snapshot([task({ proposal: { seq: 12 }, correction: { seq: 20, items: 1 } })]));
    expect(decisions).toMatchObject([{ actor: 'vibe', action: 'address_correction' }]);
  });

  it('proposition puis PR soumise → la PR prime (relecteur et testeur réveillés)', () => {
    const submission = { head: 'a'.repeat(40), base: 'b'.repeat(40), seq: 30 };
    const { decisions } = nextActors(snapshot([task({ proposal: { seq: 12 }, submission })]));
    expect(decisions.map(d => [d.actor, d.action]).sort()).toEqual([['claude', 'test'], ['grok', 'review']]);
  });
});

describe('CC-7 L0 — faits : taskProposal', () => {
  const event = (seq: number, participant: string, payload: unknown) =>
    ({ seq, participant, payload_json: typeof payload === 'string' ? payload : JSON.stringify(payload) });

  it('ne compte que l\'auteur ET la tâche nommée, et garde la plus récente', () => {
    const events = [
      event(1, 'vibe', { sealed_id: 's1', content_hash: 'h', task: 't1' }),
      event(2, 'grok', { task: 't1', content: 'x' }),
      event(3, 'vibe', { task: 't2', content: 'y' }),
      event(4, 'vibe', { sealed_id: 's2', content_hash: 'h' }),
      event(5, 'vibe', 'not json'),
      event(6, 'vibe', { task: 't1', content: 'z' }),
    ];
    expect(taskProposal('t1', 'vibe', events)).toEqual({ seq: 6 });
    expect(taskProposal('t1', 'grok', events)).toEqual({ seq: 2 });
    expect(taskProposal('t3', 'vibe', events)).toBeNull();
  });

  it('une proposition sans tâche (scellé ancien format) ne compte jamais', () => {
    expect(taskProposal('t1', 'vibe', [event(1, 'vibe', { sealed_id: 's', content_hash: 'h' })])).toBeNull();
  });
});

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

/** Cycle P1 neuf avec deux tâches du même auteur ; renvoie le store et une fonction de dépôt de proposition. */
async function freshCycle(prefix: string) {
  await ensureSchema(db, true);
  const cycle = prefix + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  await db.prepare("INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P1', 1, 'open')").bind(cycle).run();
  await db.prepare([
    'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status) VALUES',
    "('p-sol', ?1, 'sol', 'grok', 'vibe', 'accepted'), ('p-other', ?1, 'sol', 'vibe', 'grok', 'accepted')",
  ].join(' ')).bind(cycle).run();
  const store = new CollabStore(db, { dailyWriteLimit: 100_000, now: () => new Date('2026-10-25T00:00:00Z') });
  const propose = (payload: Record<string, unknown>) => store.appendEvent({
    cycle_id: cycle, type: 'proposal.submit', participant_id: 'sol', role: 'author', expected_rev: 1,
    op_id: 'sol:' + cycle + ':proposal:1', payload_json: JSON.stringify(payload),
  });
  const storedPayload = async (): Promise<Record<string, unknown>> => {
    const row = await db.prepare("SELECT payload_json FROM events WHERE cycle_id = ?1 AND type = 'proposal.submit'")
      .bind(cycle).first<{ payload_json: string }>();
    return JSON.parse(row!.payload_json) as Record<string, unknown>;
  };
  return { cycle, propose, storedPayload };
}

describe('CC-7 L0 — store et instantané : scellé P1 avec tâche', () => {
  it('garde la tâche publique, scelle le contenu, et l\'instantané ne réveille plus l\'auteur', async () => {
    const { cycle, propose, storedPayload } = await freshCycle('cc7-l0');
    const noSubmission = async () => nextActors(await readControllerSnapshot(db, cycle, async () => false)).decisions
      .filter(d => d.rule === 'no-submission').map(d => d.task_id).sort();
    expect(await noSubmission()).toEqual(['p-other', 'p-sol']);

    await propose({ task: 'p-sol', content: 'idée secrète' });
    const stored = await storedPayload();
    expect(JSON.stringify(stored)).not.toContain('idée secrète');
    expect(Object.keys(stored).sort()).toEqual(['content_hash', 'sealed_id', 'task']);
    expect(stored.task).toBe('p-sol');
    // Seule la tâche nommée est remise ; l'autre tâche du même auteur reste à faire.
    expect(await noSubmission()).toEqual(['p-other']);
  });

  it('une tâche invalide n\'est pas recopiée à côté du scellé', async () => {
    const { propose, storedPayload } = await freshCycle('cc7-l0b');
    await propose({ task: 'bad task <x>', content: 'c' });
    expect(Object.keys(await storedPayload()).sort()).toEqual(['content_hash', 'sealed_id']);
  });
});
