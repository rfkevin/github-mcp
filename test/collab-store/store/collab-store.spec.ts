import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import schemaSql from '../../../src/collab-store/schema/0001_init.sql?raw';
import { CANONICAL_SCHEMA_SQL, ensureSchema } from '../../../src/collab-store/store/schema';
import { CollabStore, CollabStoreError } from '../../../src/collab-store/store/collab-store';
import { StateContractError } from '../../../src/collab/contracts';

// CC-3 C2 : la base COLLAB_DB_C2 porte le schéma canonique C1 (COLLAB_DB garde
// le schéma proto C0 figé, incompatible). Pas de binding de production.
const bindings = env as unknown as { COLLAB_DB_C2: D1Database };
let counter = 0;
let day = 0;

function uniq(label: string): string {
  counter += 1;
  return ('c2-' + label + '-' + counter).slice(0, 64);
}

/** Un jour distinct par store pour que les compteurs de quota ne fuient pas entre tests. */
function makeStore(dailyWriteLimit = 100_000): CollabStore {
  day += 1;
  const stamp = '2026-10-' + String(day).padStart(2, '0') + 'T10:00:00.000Z';
  return new CollabStore(bindings.COLLAB_DB_C2, { dailyWriteLimit, now: () => new Date(stamp) });
}

function codeOf(error: unknown): string {
  return (error as { code: string }).code;
}

/** F1 A08 : les rôles des tâches doivent être des participants actifs (K6). */
async function seedParticipants(...pids: string[]): Promise<void> {
  await ensureSchema(bindings.COLLAB_DB_C2);
  for (const pid of pids) {
    await bindings.COLLAB_DB_C2.prepare(
      "INSERT INTO participants (participant_id, display_label, status) VALUES (?1, ?1, 'active') ON CONFLICT(participant_id) DO NOTHING"
    ).bind(pid).run();
  }
}

describe('CC-3 C2 — schéma store', () => {
  it('copie le schéma canonique C1 sans dérive (whitespace normalisé)', () => {
    const norm = (value: string) => value.split(/\s+/).filter(Boolean).join(' ');
    expect(norm(CANONICAL_SCHEMA_SQL)).toBe(norm(schemaSql));
  });
});

describe('CC-3 C2 — S1 concurrence (CAS par expected_rev)', () => {
  it('un seul append concurrent passe, le perdant est STALE avec delta', async () => {
    const store = makeStore();
    const cycle = uniq('s1');
    const created = await store.appendEvent({
      cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a',
      expected_rev: 0, payload_json: '{"n":1}', op_id: 't:' + cycle + ':cp:1',
    });
    expect(created.status).toBe('applied');
    const [a, b] = await Promise.all([
      store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 1, payload_json: '{"n":2}', op_id: 't:' + cycle + ':cp:2' }),
      store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:b', expected_rev: 1, payload_json: '{"n":3}', op_id: 't:' + cycle + ':cp:3' }),
    ]);
    const outcomes = [a, b].sort((x, y) => (x.status === 'applied' ? -1 : y.status === 'applied' ? 1 : 0));
    expect(outcomes[0].status).toBe('applied');
    expect((outcomes[0] as { revision: number }).revision).toBe(2);
    const loser = outcomes[1] as { status: string; currentRevision: number; delta: unknown[] };
    expect(loser.status).toBe('stale');
    expect(loser.currentRevision).toBe(2);
    expect(loser.delta).toHaveLength(1);
  });
});

describe('CC-3 C2 — S2 atomicité du batch', () => {
  it('une instruction en échec annule tout le lot, aucun état partiel', async () => {
    await ensureSchema(bindings.COLLAB_DB_C2);
    const store = makeStore();
    const cycle = uniq('s2');
    await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 0, payload_json: '{"n":1}', op_id: 't:' + cycle + ':cp:1' });
    const insert = "INSERT INTO events (cycle_id, at, type, participant_id, payload_json, expected_rev, idempotency_key) VALUES (?1, 1, 'note', 'agent:x', '{}', 1, 'dup-key-s2')";
    await expect(bindings.COLLAB_DB_C2.batch([
      bindings.COLLAB_DB_C2.prepare('INSERT INTO collab_store_guard (ok) SELECT 1'),
      bindings.COLLAB_DB_C2.prepare(insert).bind(cycle),
      bindings.COLLAB_DB_C2.prepare(insert).bind(cycle),
    ])).rejects.toThrow();
    const events = await bindings.COLLAB_DB_C2.prepare('SELECT COUNT(*) AS n FROM events WHERE idempotency_key = ?1').bind('dup-key-s2').first<{ n: number }>();
    expect(events?.n).toBe(0);
    const guard = await bindings.COLLAB_DB_C2.prepare('SELECT COUNT(*) AS n FROM collab_store_guard').first<{ n: number }>();
    expect(guard?.n).toBe(0);
    expect(await store.currentRevision(cycle)).toBe(1);
  });
});

describe('CC-3 C2 — S3 rejeu (le journal est la vérité)', () => {
  it('les tâches matérialisées égalent le rejeu du journal ; revision = nombre d\'événements', async () => {
    const store = makeStore();
    const cycle = uniq('s3');
    await seedParticipants('agent:a', 'agent:b', 'agent:c');
    await store.appendEvent({
      cycle_id: cycle, type: 'task.claim', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ task: { task_id: 'c2task', owner_pid: 'agent:a', reviewer_pid: 'agent:b', tester_pid: 'agent:c', next_action: 'implement' } }),
      op_id: 't:' + cycle + ':claim:1',
    });
    await store.appendEvent({
      cycle_id: cycle, type: 'task.status', participant_id: 'agent:b', expected_rev: 1,
      payload_json: JSON.stringify({ task: { task_id: 'c2task', status: 'review' } }),
      op_id: 't:' + cycle + ':status:2',
    });
    const { results } = await bindings.COLLAB_DB_C2.prepare('SELECT * FROM events WHERE cycle_id = ?1 ORDER BY seq').bind(cycle).all();
    expect(results).toHaveLength(2);
    // Rejeu : la dernière écriture de statut dans le journal l'emporte.
    const replayed: Record<string, unknown> = {};
    for (const event of results as unknown as Array<{ payload_json: string }>) {
      const payload = JSON.parse(event.payload_json) as { task: Record<string, unknown> };
      replayed[payload.task.task_id as string] = payload.task;
    }
    const tasks = await bindings.COLLAB_DB_C2.prepare('SELECT * FROM tasks WHERE cycle_id = ?1').bind(cycle).all<Record<string, unknown>>();
    expect(tasks.results).toHaveLength(1);
    expect(tasks.results[0].status).toBe((replayed.c2task as { status: string }).status);
    expect(tasks.results[0].owner_pid).toBe('agent:a');
    expect(tasks.results[0].revision).toBe(2);
    expect(await store.currentRevision(cycle)).toBe(2);
  });
});

describe('CC-3 C2 — idempotence, quota, stale', () => {
  it('un op_id rejoué renvoie l\'événement original sans seconde écriture', async () => {
    const store = makeStore();
    const cycle = uniq('dup');
    const input = { cycle_id: cycle, type: 'checkpoint' as const, participant_id: 'agent:a', expected_rev: 0, payload_json: '{"n":1}', op_id: 't:' + cycle + ':cp:1' };
    const first = await store.appendEvent(input);
    expect(first.status).toBe('applied');
    const retry = await store.appendEvent(input);
    expect(retry.status).toBe('duplicate');
    expect((retry as { event: { seq: number } }).event.seq).toBe((first as { event: { seq: number } }).event.seq);
    const events = await bindings.COLLAB_DB_C2.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
    expect(events?.n).toBe(1);
  });

  it('quota épuisé : erreur explicite, aucune écriture', async () => {
    const store = makeStore(2);
    const cycle = uniq('quota');
    await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 0, payload_json: '{"n":1}', op_id: 't:' + cycle + ':cp:1' });
    await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 1, payload_json: '{"n":2}', op_id: 't:' + cycle + ':cp:2' });
    const third = await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 2, payload_json: '{"n":3}', op_id: 't:' + cycle + ':cp:3' });
    expect(third.status).toBe('quota_exhausted');
    const events = await bindings.COLLAB_DB_C2.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
    expect(events?.n).toBe(2);
  });

  it('création attendue 0 sur un cycle existant : STALE, jamais last-write-wins', async () => {
    const store = makeStore();
    const cycle = uniq('stale0');
    await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 0, payload_json: '{"n":1}', op_id: 't:' + cycle + ':cp:1' });
    const outcome = await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 0, payload_json: '{"n":2}', op_id: 't:' + cycle + ':cp:2' });
    expect(outcome.status).toBe('stale');
    expect((outcome as { currentRevision: number }).currentRevision).toBe(1);
  });
});

describe('CC-3 C2 — refus contractuels (fail-closed)', () => {
  it('owner.decision est refusé aux agents (I7)', async () => {
    const store = makeStore();
    const cycle = uniq('owner');
    try {
      await store.appendEvent({ cycle_id: cycle, type: 'owner.decision', participant_id: 'agent:a', expected_rev: 0, payload_json: '{"d":1}', op_id: 't:' + cycle + ':own:1' });
      expect.unreachable('owner.decision doit être refusé');
    } catch (error) {
      expect(error).toBeInstanceOf(StateContractError);
      expect(codeOf(error)).toBe('OWNER_DECISION_FORBIDDEN');
    }
  });

  it('task.claim avec rôles identiques viole D12', async () => {
    const store = makeStore();
    const cycle = uniq('d12');
    try {
      await store.appendEvent({
        cycle_id: cycle, type: 'task.claim', participant_id: 'agent:a', expected_rev: 0,
        payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:a', reviewer_pid: 'agent:a', tester_pid: 'agent:b' } }),
        op_id: 't:' + cycle + ':claim:1',
      });
      expect.unreachable('D12 doit être refusé à l\'écriture');
    } catch (error) {
      expect(error).toBeInstanceOf(StateContractError);
      expect(codeOf(error)).toBe('DUPLICATE_TASK_ROLE');
    }
  });

  it('task.status sur une tâche inconnue : TASK_UNKNOWN', async () => {
    const store = makeStore();
    const cycle = uniq('unk');
    try {
      await store.appendEvent({
        cycle_id: cycle, type: 'task.status', participant_id: 'agent:a', expected_rev: 0,
        payload_json: JSON.stringify({ task: { task_id: 'ghost', status: 'review' } }),
        op_id: 't:' + cycle + ':status:1',
      });
      expect.unreachable('tâche inconnue');
    } catch (error) {
      expect(error).toBeInstanceOf(CollabStoreError);
      expect(codeOf(error)).toBe('TASK_UNKNOWN');
    }
  });

  it('statut de tâche non supporté : INVALID_TASK_STATUS', async () => {
    const store = makeStore();
    const cycle = uniq('badst');
    await seedParticipants('agent:a', 'agent:b', 'agent:c');
    await store.appendEvent({
      cycle_id: cycle, type: 'task.claim', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:a', reviewer_pid: 'agent:b', tester_pid: 'agent:c' } }),
      op_id: 't:' + cycle + ':claim:1',
    });
    try {
      await store.appendEvent({
        cycle_id: cycle, type: 'task.status', participant_id: 'agent:a', expected_rev: 1,
        payload_json: JSON.stringify({ task: { task_id: 't1', status: 'vaporized' } }),
        op_id: 't:' + cycle + ':status:2',
      });
      expect.unreachable('statut invalide');
    } catch (error) {
      expect(error).toBeInstanceOf(CollabStoreError);
      expect(codeOf(error)).toBe('INVALID_TASK_STATUS');
    }
  });
});

describe('CC-3 C2 — lectures', () => {
  it('get_delta par curseur seq et get_context filtré par participant', async () => {
    const store = makeStore();
    const cycle = uniq('read');
    await seedParticipants('agent:a', 'agent:b', 'agent:c');
    await store.appendEvent({
      cycle_id: cycle, type: 'task.claim', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ task: { task_id: 'mine', owner_pid: 'agent:a', reviewer_pid: 'agent:b', tester_pid: 'agent:c' } }),
      op_id: 't:' + cycle + ':claim:1',
    });
    await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 1, payload_json: '{"n":2}', op_id: 't:' + cycle + ':cp:2' });
    const delta = await store.getDelta(cycle, 0, 10);
    expect(delta.events).toHaveLength(2);
    expect(delta.hasMore).toBe(false);
    const context = await store.getContext(cycle, 'agent:b');
    expect(context.revision).toBe(2);
    expect(context.tasks.map(task => task.task_id)).toEqual(['mine']);
  });
});

describe('CC-3 F1 — A05 op_id lié à l\'intention et au cycle', () => {
  it('segment cycle de l\'op_id ≠ cycle visé : INVALID_OP_ID', async () => {
    const store = makeStore();
    const cycle = uniq('a05');
    try {
      await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 0,
        payload_json: '{"n":1}', op_id: 't:autre-cycle:cp:1' });
      expect.unreachable('le segment cycle erroné doit être refusé');
    } catch (error) {
      expect(error).toBeInstanceOf(CollabStoreError);
      expect(codeOf(error)).toBe('INVALID_OP_ID');
    }
  });

  it('même op_id, contenu différent : IDEMPOTENCY_CONFLICT, rien de réécrit', async () => {
    const store = makeStore();
    const cycle = uniq('a05c');
    await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 0,
      payload_json: '{"n":1}', op_id: 't:' + cycle + ':cp:1' });
    try {
      await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 1,
        payload_json: '{"n":2}', op_id: 't:' + cycle + ':cp:1' });
      expect.unreachable('une intention différente sous le même op_id doit être refusée');
    } catch (error) {
      expect(error).toBeInstanceOf(CollabStoreError);
      expect(codeOf(error)).toBe('IDEMPOTENCY_CONFLICT');
    }
    const events = await bindings.COLLAB_DB_C2.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
    expect(events?.n).toBe(1);
  });

  it('même op_id, auteur différent : IDEMPOTENCY_CONFLICT', async () => {
    const store = makeStore();
    const cycle = uniq('a05a');
    await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 0,
      payload_json: '{"n":1}', op_id: 't:' + cycle + ':cp:1' });
    await expect(store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:b', expected_rev: 1,
      payload_json: '{"n":1}', op_id: 't:' + cycle + ':cp:1' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejeu d\'une proposition scellée identique : duplicate via l\'empreinte de l\'enveloppe', async () => {
    const store = makeStore();
    const cycle = uniq('a05s');
    const input = { cycle_id: cycle, type: 'proposal.submit' as const, participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ content: 'plan-a' }), op_id: 't:' + cycle + ':prop:1' };
    const first = await store.appendEvent(input);
    expect(first.status).toBe('applied');
    const retry = await store.appendEvent(input);
    expect(retry.status).toBe('duplicate');
    expect((retry as { event: { seq: number } }).event.seq).toBe((first as { event: { seq: number } }).event.seq);
    const events = await bindings.COLLAB_DB_C2.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
    expect(events?.n).toBe(1);
  });

  it('proposition différente sous le même op_id : IDEMPOTENCY_CONFLICT, un seul item scellé', async () => {
    const store = makeStore();
    const cycle = uniq('a05p');
    await store.appendEvent({ cycle_id: cycle, type: 'proposal.submit', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ content: 'plan-a' }), op_id: 't:' + cycle + ':prop:1' });
    try {
      await store.appendEvent({ cycle_id: cycle, type: 'proposal.submit', participant_id: 'agent:a', expected_rev: 1,
        payload_json: JSON.stringify({ content: 'plan-b' }), op_id: 't:' + cycle + ':prop:1' });
      expect.unreachable('une proposition différente sous le même op_id doit être refusée');
    } catch (error) {
      expect(codeOf(error)).toBe('IDEMPOTENCY_CONFLICT');
    }
    const sealed = await bindings.COLLAB_DB_C2.prepare('SELECT COUNT(*) AS n FROM sealed_items WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
    expect(sealed?.n).toBe(1);
  });
});

describe('CC-3 F1 — A01 ids scellés anti-collision', () => {
  it('deux op_id longs de même préfixe : items scellés distincts, pas de collision', async () => {
    const store = makeStore();
    const cycle = uniq('a01');
    const clientA = 'f1' + 'k'.repeat(46) + 'aaa';
    const clientB = 'f1' + 'k'.repeat(46) + 'bbb';
    const first = await store.appendEvent({ cycle_id: cycle, type: 'proposal.submit', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ content: 'un' }), op_id: clientA + ':' + cycle + ':prop:1' });
    const second = await store.appendEvent({ cycle_id: cycle, type: 'proposal.submit', participant_id: 'agent:a', expected_rev: 1,
      payload_json: JSON.stringify({ content: 'deux' }), op_id: clientB + ':' + cycle + ':prop:1' });
    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    const { results } = await bindings.COLLAB_DB_C2.prepare('SELECT id FROM sealed_items WHERE cycle_id = ?1').bind(cycle).all<{ id: string }>();
    expect(results).toHaveLength(2);
    expect(new Set(results.map(row => row.id)).size).toBe(2);
    for (const row of results) expect(row.id).toMatch(/^sealed-[0-9a-f]{64}$/);
  });
});

describe('CC-3 F1 — A08 permissions des tâches', () => {
  it('claim initial par un tiers : TASK_FORBIDDEN, aucune ligne tâche', async () => {
    const store = makeStore();
    const cycle = uniq('a08c');
    await seedParticipants('agent:a', 'agent:b', 'agent:c', 'agent:d');
    try {
      await store.appendEvent({ cycle_id: cycle, type: 'task.claim', participant_id: 'agent:a', expected_rev: 0,
        payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:b', reviewer_pid: 'agent:c', tester_pid: 'agent:d' } }),
        op_id: 't:' + cycle + ':claim:1' });
      expect.unreachable('le claim initial par un tiers doit être refusé');
    } catch (error) {
      expect(error).toBeInstanceOf(CollabStoreError);
      expect(codeOf(error)).toBe('TASK_FORBIDDEN');
    }
    const rows = await bindings.COLLAB_DB_C2.prepare('SELECT COUNT(*) AS n FROM tasks WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('réaffectation : seul l\'owner courant peut re-claimer la tâche', async () => {
    const store = makeStore();
    const cycle = uniq('a08r');
    await seedParticipants('agent:a', 'agent:b', 'agent:c', 'agent:e');
    const first = await store.appendEvent({ cycle_id: cycle, type: 'task.claim', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:a', reviewer_pid: 'agent:b', tester_pid: 'agent:c' } }),
      op_id: 't:' + cycle + ':claim:1' });
    expect(first.status).toBe('applied');
    await expect(store.appendEvent({ cycle_id: cycle, type: 'task.claim', participant_id: 'agent:b', expected_rev: 1,
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:e', reviewer_pid: 'agent:b', tester_pid: 'agent:c' } }),
      op_id: 't:' + cycle + ':claim:2' })).rejects.toMatchObject({ code: 'TASK_FORBIDDEN' });
    const reassign = await store.appendEvent({ cycle_id: cycle, type: 'task.claim', participant_id: 'agent:a', expected_rev: 1,
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:e', reviewer_pid: 'agent:b', tester_pid: 'agent:c', next_action: 'reprise' } }),
      op_id: 't:' + cycle + ':claim:3' });
    expect(reassign.status).toBe('applied');
    const task = await bindings.COLLAB_DB_C2.prepare('SELECT owner_pid FROM tasks WHERE cycle_id = ?1 AND task_id = ?2').bind(cycle, 't1').first<{ owner_pid: string }>();
    expect(task?.owner_pid).toBe('agent:e');
  });

  it('task.status : un tiers est refusé, un reviewer passe', async () => {
    const store = makeStore();
    const cycle = uniq('a08s');
    await seedParticipants('agent:a', 'agent:b', 'agent:c', 'agent:d');
    await store.appendEvent({ cycle_id: cycle, type: 'task.claim', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:a', reviewer_pid: 'agent:b', tester_pid: 'agent:c' } }),
      op_id: 't:' + cycle + ':claim:1' });
    await expect(store.appendEvent({ cycle_id: cycle, type: 'task.status', participant_id: 'agent:d', expected_rev: 1,
      payload_json: JSON.stringify({ task: { task_id: 't1', status: 'review' } }),
      op_id: 't:' + cycle + ':status:1' })).rejects.toMatchObject({ code: 'TASK_FORBIDDEN' });
    const byReviewer = await store.appendEvent({ cycle_id: cycle, type: 'task.status', participant_id: 'agent:b', expected_rev: 1,
      payload_json: JSON.stringify({ task: { task_id: 't1', status: 'review' } }),
      op_id: 't:' + cycle + ':status:2' });
    expect(byReviewer.status).toBe('applied');
  });

  it('task.handoff par un non-owner : TASK_FORBIDDEN, la tâche ne bouge pas', async () => {
    const store = makeStore();
    const cycle = uniq('a08h');
    await seedParticipants('agent:a', 'agent:b', 'agent:c', 'agent:e');
    await store.appendEvent({ cycle_id: cycle, type: 'task.claim', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:a', reviewer_pid: 'agent:b', tester_pid: 'agent:c' } }),
      op_id: 't:' + cycle + ':claim:1' });
    await expect(store.appendEvent({ cycle_id: cycle, type: 'task.handoff', participant_id: 'agent:b', expected_rev: 1,
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:e', next_action: 'suite' } }),
      op_id: 't:' + cycle + ':handoff:1' })).rejects.toMatchObject({ code: 'TASK_FORBIDDEN' });
    const task = await bindings.COLLAB_DB_C2.prepare('SELECT owner_pid FROM tasks WHERE cycle_id = ?1 AND task_id = ?2').bind(cycle, 't1').first<{ owner_pid: string }>();
    expect(task?.owner_pid).toBe('agent:a');
  });

  it('rôles sans participant actif : UNREGISTERED_PARTICIPANT (claim puis handoff), rien d\'écrit', async () => {
    const store = makeStore();
    const cycle = uniq('a08u');
    await seedParticipants('agent:a', 'agent:b', 'agent:c');
    const ghostOwner = uniq('ghost');
    await expect(store.appendEvent({ cycle_id: cycle, type: 'task.claim', participant_id: ghostOwner, expected_rev: 0,
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: ghostOwner, reviewer_pid: 'agent:b', tester_pid: 'agent:c' } }),
      op_id: 't:' + cycle + ':claim:1' })).rejects.toMatchObject({ code: 'UNREGISTERED_PARTICIPANT' });
    const rows = await bindings.COLLAB_DB_C2.prepare('SELECT COUNT(*) AS n FROM tasks WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
    expect(rows?.n).toBe(0);
    const claim = await store.appendEvent({ cycle_id: cycle, type: 'task.claim', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:a', reviewer_pid: 'agent:b', tester_pid: 'agent:c' } }),
      op_id: 't:' + cycle + ':claim:2' });
    expect(claim.status).toBe('applied');
    const ghostNewOwner = uniq('ghost');
    await expect(store.appendEvent({ cycle_id: cycle, type: 'task.handoff', participant_id: 'agent:a', expected_rev: 1,
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: ghostNewOwner, next_action: 'suite' } }),
      op_id: 't:' + cycle + ':handoff:1' })).rejects.toMatchObject({ code: 'UNREGISTERED_PARTICIPANT' });
    const task = await bindings.COLLAB_DB_C2.prepare('SELECT owner_pid FROM tasks WHERE cycle_id = ?1 AND task_id = ?2').bind(cycle, 't1').first<{ owner_pid: string }>();
    expect(task?.owner_pid).toBe('agent:a');
  });
});

describe('CC-3 F1 — rejeux après réponse perdue (review Claude)', () => {
  const expectReplayDuplicate = async (
    cycleTag: string,
    request: { type: string; payload_json: string; opSuffix: string },
  ) => {
    const store = makeStore();
    const cycle = uniq(cycleTag);
    await seedParticipants('agent:a', 'agent:b', 'agent:c', 'agent:e');
    await store.appendEvent({ cycle_id: cycle, type: 'task.claim', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:a', reviewer_pid: 'agent:b', tester_pid: 'agent:c' } }),
      op_id: 't:' + cycle + ':claim:1' });
    const op_id = 't:' + cycle + ':' + request.opSuffix;
    const first = await store.appendEvent({ cycle_id: cycle, type: request.type, participant_id: 'agent:a', expected_rev: 1,
      payload_json: request.payload_json, op_id });
    expect(first.status).toBe('applied');
    // Réponse perdue : le client rejoue la même requête alors que l'owner a changé.
    const replay = await store.appendEvent({ cycle_id: cycle, type: request.type, participant_id: 'agent:a', expected_rev: 1,
      payload_json: request.payload_json, op_id });
    expect(replay.status).toBe('duplicate');
    expect((replay as { event: { seq: number } }).event.seq).toBe((first as { event: { seq: number } }).event.seq);
    const events = await bindings.COLLAB_DB_C2.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
    expect(events?.n).toBe(2);
    const task = await bindings.COLLAB_DB_C2.prepare('SELECT owner_pid FROM tasks WHERE cycle_id = ?1 AND task_id = ?2').bind(cycle, 't1').first<{ owner_pid: string }>();
    expect(task?.owner_pid).toBe('agent:e');
  };

  it('rejeu de task.handoff par le précédent owner : duplicate, aucune seconde écriture', async () => {
    await expectReplayDuplicate('a08j', {
      type: 'task.handoff',
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:e', next_action: 'suite' } }),
      opSuffix: 'handoff:1',
    });
  });

  it('rejeu de réaffectation task.claim par le précédent owner : duplicate, aucune seconde écriture', async () => {
    await expectReplayDuplicate('a08k', {
      type: 'task.claim',
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:e', reviewer_pid: 'agent:b', tester_pid: 'agent:c', next_action: 'reprise' } }),
      opSuffix: 'claim:2',
    });
  });
});
