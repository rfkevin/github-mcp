import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { loadOpenQuestions } from '../../../src/collab-store/context';

// CC-5 L2 (X13, review Claude R2) : adressage des questions ouvertes —
// seul l'auteur ou le destinataire d'une question adressée peut la fermer ;
// les pré-checks sont lecture seule : un refus ne consomme ni révision ni
// quota et n'écrit rien du tout.
const bindings = env as unknown as { COLLAB_DB_C2: D1Database };
let counter = 0;
let day = 0;

function makeStore(): CollabStore {
  counter += 1;
  day += 1;
  const stamp = '2026-12-' + String(day).padStart(2, '0') + 'T10:00:00.000Z';
  return new CollabStore(bindings.COLLAB_DB_C2, { now: () => new Date(stamp) });
}

function uniq(label: string): string {
  return ('c5l2-cl-' + label + '-' + counter).slice(0, 64);
}

async function seedTask(cycleId: string, taskId: string): Promise<void> {
  await bindings.COLLAB_DB_C2.prepare([
    'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
    "VALUES (?1, ?2, 'agent:own', 'agent:rev', 'agent:tst', 'in_progress', '[]', '', '', 1)",
  ].join(' ')).bind(taskId, cycleId).run();
}

describe('CC-5 L2 (X13) — adressage des questions ouvertes', () => {
  it('un tiers ne ferme pas une question adressée (CLARIFY_ANSWER_FORBIDDEN), le destinataire la ferme', async () => {
    await ensureSchema(bindings.COLLAB_DB_C2);
    const store = makeStore();
    const cycleId = uniq('to-part');
    const ask = await store.appendEvent({
      cycle_id: cycleId, type: 'clarify.ask', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ question: 'Q adressée ?', to: 'agent:b' }), op_id: 'agent.a:' + cycleId + ':ask:1',
    });
    if (ask.status !== 'applied') throw new Error('clarify.ask non appliqué');
    const askSeq = ask.event.seq;
    await expect(store.appendEvent({
      cycle_id: cycleId, type: 'clarify.answer', participant_id: 'agent:c', expected_rev: 1,
      payload_json: JSON.stringify({ ask_seq: askSeq, answer: 'tiers' }), op_id: 'agent.c:' + cycleId + ':ans:1',
    })).rejects.toMatchObject({ code: 'CLARIFY_ANSWER_FORBIDDEN' });
    // le refus n'a rien fermé ni consommé
    expect(await loadOpenQuestions(bindings.COLLAB_DB_C2, cycleId)).toHaveLength(1);
    const closed = await store.appendEvent({
      cycle_id: cycleId, type: 'clarify.answer', participant_id: 'agent:b', expected_rev: 1,
      payload_json: JSON.stringify({ ask_seq: askSeq, answer: 'voici' }), op_id: 'agent.b:' + cycleId + ':ans:1',
    });
    expect(closed.status).toBe('applied');
    expect(await loadOpenQuestions(bindings.COLLAB_DB_C2, cycleId)).toHaveLength(0);
  });

  it('l’auteur ferme sa propre question adressée', async () => {
    const store = makeStore();
    const cycleId = uniq('author');
    const ask = await store.appendEvent({
      cycle_id: cycleId, type: 'clarify.ask', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ question: 'Q ?', to: 'agent:b' }), op_id: 'agent.a:' + cycleId + ':ask:1',
    });
    if (ask.status !== 'applied') throw new Error('clarify.ask non appliqué');
    const closed = await store.appendEvent({
      cycle_id: cycleId, type: 'clarify.answer', participant_id: 'agent:a', expected_rev: 1,
      payload_json: JSON.stringify({ ask_seq: ask.event.seq, answer: 'fermée par l’auteur' }), op_id: 'agent.a:' + cycleId + ':ans:1',
    });
    expect(closed.status).toBe('applied');
    expect(await loadOpenQuestions(bindings.COLLAB_DB_C2, cycleId)).toHaveLength(0);
  });

  it('un rôle vise le titulaire du rôle sur la tâche citée : reviewer oui, owner non', async () => {
    const store = makeStore();
    const cycleId = uniq('to-role');
    await store.appendEvent({
      cycle_id: cycleId, type: 'checkpoint', participant_id: 'agent:a', expected_rev: 0,
      payload_json: '{"n":1}', op_id: 'agent.a:' + cycleId + ':cp:1',
    });
    await seedTask(cycleId, 't1');
    const ask = await store.appendEvent({
      cycle_id: cycleId, type: 'clarify.ask', participant_id: 'agent:a', expected_rev: 1,
      payload_json: JSON.stringify({ question: 'Q rôle ?', to: 'reviewer', task: 't1' }), op_id: 'agent.a:' + cycleId + ':ask:1',
    });
    if (ask.status !== 'applied') throw new Error('clarify.ask non appliqué');
    const askSeq = ask.event.seq;
    await expect(store.appendEvent({
      cycle_id: cycleId, type: 'clarify.answer', participant_id: 'agent:own', expected_rev: 2,
      payload_json: JSON.stringify({ ask_seq: askSeq, answer: 'owner' }), op_id: 'agent.own:' + cycleId + ':ans:1',
    })).rejects.toMatchObject({ code: 'CLARIFY_ANSWER_FORBIDDEN' });
    const closed = await store.appendEvent({
      cycle_id: cycleId, type: 'clarify.answer', participant_id: 'agent:rev', expected_rev: 2,
      payload_json: JSON.stringify({ ask_seq: askSeq, answer: 'réponse du reviewer' }), op_id: 'agent.rev:' + cycleId + ':ans:1',
    });
    expect(closed.status).toBe('applied');
  });

  it('clarify.ask : rôle sans task → CLARIFY_TO_REQUIRES_TASK, tâche inconnue → TASK_UNKNOWN, to mal formé → CLARIFY_TO_INVALID', async () => {
    const store = makeStore();
    const cycleId = uniq('guards');
    await expect(store.appendEvent({
      cycle_id: cycleId, type: 'clarify.ask', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ question: 'Q ?', to: 'reviewer' }), op_id: 'agent.a:' + cycleId + ':ask:1',
    })).rejects.toMatchObject({ code: 'CLARIFY_TO_REQUIRES_TASK' });
    await expect(store.appendEvent({
      cycle_id: cycleId, type: 'clarify.ask', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ question: 'Q ?', to: 'reviewer', task: 'ghost' }), op_id: 'agent.a:' + cycleId + ':ask:2',
    })).rejects.toMatchObject({ code: 'TASK_UNKNOWN' });
    await expect(store.appendEvent({
      cycle_id: cycleId, type: 'clarify.ask', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ question: 'Q ?', to: 42 }), op_id: 'agent.a:' + cycleId + ':ask:3',
    })).rejects.toMatchObject({ code: 'CLARIFY_TO_INVALID' });
    // aucun refus n'a créé le cycle ni consommé de révision
    expect(await store.currentRevision(cycleId)).toBe(0);
  });

  it('question publique : un tiers répond (comportement inchangé) ; réponse orpheline acceptée, ne ferme rien', async () => {
    const store = makeStore();
    const cycleId = uniq('public');
    const ask = await store.appendEvent({
      cycle_id: cycleId, type: 'clarify.ask', participant_id: 'agent:a', expected_rev: 0,
      payload_json: JSON.stringify({ question: 'Q publique ?' }), op_id: 'agent.a:' + cycleId + ':ask:1',
    });
    if (ask.status !== 'applied') throw new Error('clarify.ask non appliqué');
    const third = await store.appendEvent({
      cycle_id: cycleId, type: 'clarify.answer', participant_id: 'agent:c', expected_rev: 1,
      payload_json: JSON.stringify({ ask_seq: ask.event.seq, answer: 'tiers' }), op_id: 'agent.c:' + cycleId + ':ans:1',
    });
    expect(third.status).toBe('applied');
    expect(await loadOpenQuestions(bindings.COLLAB_DB_C2, cycleId)).toHaveLength(0);
    const orphan = await store.appendEvent({
      cycle_id: cycleId, type: 'clarify.answer', participant_id: 'agent:c', expected_rev: 2,
      payload_json: JSON.stringify({ ask_seq: 999999, answer: 'orpheline' }), op_id: 'agent.c:' + cycleId + ':ans:2',
    });
    expect(orphan.status).toBe('applied');
  });

  it('adressage par rôle non résolvable (ligne héritée) : seul l’auteur ferme', async () => {
    await ensureSchema(bindings.COLLAB_DB_C2);
    const store = makeStore();
    const cycleId = uniq('legacy');
    const key = 'c5l2-legacy-ask-' + counter;
    await bindings.COLLAB_DB_C2.prepare(
      "INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P1', 1, 'open')"
    ).bind(cycleId).run();
    await bindings.COLLAB_DB_C2.prepare([
      'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
      "VALUES (?1, 1, 'clarify.ask', 'agent:a', '', '', ?2, 0, ?3, '')",
    ].join(' ')).bind(cycleId, JSON.stringify({ question: 'Q héritée ?', to: 'reviewer' }), key).run();
    const row = await bindings.COLLAB_DB_C2.prepare('SELECT seq FROM events WHERE idempotency_key = ?1')
      .bind(key).first<{ seq: number }>();
    if (!row) throw new Error('question héritée perdue');
    await expect(store.appendEvent({
      cycle_id: cycleId, type: 'clarify.answer', participant_id: 'agent:rev', expected_rev: 1,
      payload_json: JSON.stringify({ ask_seq: row.seq, answer: 'reviewer' }), op_id: 'agent.rev:' + cycleId + ':ans:1',
    })).rejects.toMatchObject({ code: 'CLARIFY_ANSWER_FORBIDDEN' });
    const closed = await store.appendEvent({
      cycle_id: cycleId, type: 'clarify.answer', participant_id: 'agent:a', expected_rev: 1,
      payload_json: JSON.stringify({ ask_seq: row.seq, answer: 'fermée par l’auteur' }), op_id: 'agent.a:' + cycleId + ':ans:1',
    });
    expect(closed.status).toBe('applied');
  });
});
