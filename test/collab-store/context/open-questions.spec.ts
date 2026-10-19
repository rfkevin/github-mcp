import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildRolePacket, ensureContextSchema, loadOpenQuestions, OPEN_QUESTIONS_BUDGET } from '../../../src/collab-store/context';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;

async function seedCycle(): Promise<string> {
  await ensureSchema(db);
  await ensureContextSchema(db);
  const cycleId = 'c5l2-oq-' + (++n);
  await db.prepare(
    "INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P1', 1, 'open')"
  ).bind(cycleId).run();
  return cycleId;
}

async function seedEvent(cycleId: string, type: 'clarify.ask' | 'clarify.answer', pid: string, payload: string): Promise<number> {
  const key = 'c5l2-oq-e-' + (++n);
  await db.prepare([
    'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
    "VALUES (?1, 1, ?2, ?3, '', '', ?4, 0, ?5, '')",
  ].join(' ')).bind(cycleId, type, pid, payload, key).run();
  const row = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number }>();
  if (!row) throw new Error('seedEvent lost: ' + key);
  return row.seq;
}

function estimateTokensLikePacket(value: unknown): number {
  return Math.ceil(new TextEncoder().encode(JSON.stringify(value)).byteLength / 4);
}

describe('CC-5 L2 — questions ouvertes du journal (clarify.ask/answer)', () => {
  it('ne rend que les clarify.ask sans clarify.answer lié, au format #<seq> (<participant>) <question>', async () => {
    const cycleId = await seedCycle();
    const askA = await seedEvent(cycleId, 'clarify.ask', 'agent:a', JSON.stringify({ question: 'Question A ?', subject: 'l2' }));
    const askB = await seedEvent(cycleId, 'clarify.ask', 'agent:b', JSON.stringify({ question: 'Question B ?' }));
    // payload illisible : le seq et le participant portent toujours la question.
    const askC = await seedEvent(cycleId, 'clarify.ask', 'agent:c', '{"question": casse');
    await seedEvent(cycleId, 'clarify.answer', 'agent:a', JSON.stringify({ ask_seq: askA, answer: 'réponse A' }));
    const open = await loadOpenQuestions(db, cycleId);
    expect(open).toEqual([
      '#' + askB + ' (agent:b) Question B ?',
      '#' + askC + ' (agent:c) ',
    ]);
  });

  it('une réponse orpheline (ask_seq inconnu) ne ferme aucune question', async () => {
    const cycleId = await seedCycle();
    const ask = await seedEvent(cycleId, 'clarify.ask', 'agent:a', JSON.stringify({ question: 'Question ouverte ?' }));
    await seedEvent(cycleId, 'clarify.answer', 'agent:b', JSON.stringify({ ask_seq: 999999, answer: 'orpheline' }));
    expect(await loadOpenQuestions(db, cycleId)).toEqual(['#' + ask + ' (agent:a) Question ouverte ?']);
  });

  it('borne à 50 questions lues et au budget du packet, la plus petite seq en tête', async () => {
    const cycleId = await seedCycle();
    const seqs: number[] = [];
    for (let i = 0; i < 60; i++) {
      seqs.push(await seedEvent(cycleId, 'clarify.ask', 'agent:a', JSON.stringify({ question: 'Question ' + i + ' — quel est le prochain lot ?' })));
    }
    const open = await loadOpenQuestions(db, cycleId);
    expect(open).toHaveLength(50);
    expect(open[0]).toContain('#' + seqs[0] + ' (agent:a)');
    const packet = await buildRolePacket(db, { cycle: cycleId, participant_id: 'agent:a' }, { c0BaselineTokens: 100, approvedBudgetTokens: 6000 });
    expect(packet.open_questions.length).toBeGreaterThan(0);
    expect(packet.open_questions.every(q => q.startsWith('#'))).toBe(true);
    expect(estimateTokensLikePacket(packet.open_questions)).toBeLessThanOrEqual(OPEN_QUESTIONS_BUDGET);
    expect(packet.open_questions[0]).toContain('#' + seqs[0] + ' ');
  });
});

describe('CC-5 L2 (X13, review Claude R2) — visibilité des questions adressées', () => {
  async function seedTask(cycleId: string, taskId: string): Promise<void> {
    await db.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
      "VALUES (?1, ?2, 'agent:own', 'agent:rev', 'agent:tst', 'in_progress', '[]', '', '', 1)",
    ].join(' ')).bind(taskId, cycleId).run();
  }

  it('une question adressée à un participant n’est rendue qu’à son auteur et à son destinataire', async () => {
    const cycleId = await seedCycle();
    await seedEvent(cycleId, 'clarify.ask', 'agent:a', JSON.stringify({ question: 'Q adressée ?', to: 'agent:b' }));
    expect(await loadOpenQuestions(db, cycleId, { participantIds: new Set(['agent:a']) })).toHaveLength(1); // auteur
    expect(await loadOpenQuestions(db, cycleId, { participantIds: new Set(['agent:b']) })).toHaveLength(1); // destinataire
    expect(await loadOpenQuestions(db, cycleId, { participantIds: new Set(['agent:c']) })).toHaveLength(0); // tiers
  });

  it('une question adressée à un rôle n’est rendue qu’au titulaire du rôle sur la tâche citée', async () => {
    const cycleId = await seedCycle();
    await seedTask(cycleId, 't1');
    await seedEvent(cycleId, 'clarify.ask', 'agent:a', JSON.stringify({ question: 'Q rôle ?', to: 'reviewer', task: 't1' }));
    expect(await loadOpenQuestions(db, cycleId, { participantIds: new Set(['agent:rev']) })).toHaveLength(1);
    expect(await loadOpenQuestions(db, cycleId, { participantIds: new Set(['agent:own']) })).toHaveLength(0);
    expect(await loadOpenQuestions(db, cycleId, { participantIds: new Set(['agent:a']) })).toHaveLength(1); // auteur
  });

  it('un adressage par rôle sans tâche résolvable reste visible à l’auteur seul ; sans viewer, tout est rendu', async () => {
    const cycleId = await seedCycle();
    await seedEvent(cycleId, 'clarify.ask', 'agent:a', JSON.stringify({ question: 'Q ?', to: 'reviewer' }));
    expect(await loadOpenQuestions(db, cycleId, { participantIds: new Set(['agent:a']) })).toHaveLength(1);
    expect(await loadOpenQuestions(db, cycleId, { participantIds: new Set(['agent:rev']) })).toHaveLength(0);
    expect(await loadOpenQuestions(db, cycleId)).toHaveLength(1); // API interne sans viewer : pas de filtrage
  });

  it('buildRolePacket ne rend une question adressée qu’à son auteur et à son destinataire', async () => {
    const cycleId = await seedCycle();
    await seedEvent(cycleId, 'clarify.ask', 'agent:a', JSON.stringify({ question: 'Q packet ?', to: 'agent:b' }));
    const packet = await buildRolePacket(db, { cycle: cycleId, participant_id: 'agent:b' }, { c0BaselineTokens: 100, approvedBudgetTokens: 6000 });
    expect(packet.open_questions).toHaveLength(1);
    const third = await buildRolePacket(db, { cycle: cycleId, participant_id: 'agent:c' }, { c0BaselineTokens: 100, approvedBudgetTokens: 6000 });
    expect(third.open_questions).toHaveLength(0);
  });
});

describe('CC-5 L2 (test GPT-6) — fenêtre visible et trim du paquet', () => {
  it('le filtrage de visibilité précède la limite : 50 adressages aux tiers ne masquent pas une question visible', async () => {
    const cycleId = await seedCycle();
    for (let i = 0; i < 50; i++) {
      await seedEvent(cycleId, 'clarify.ask', 'agent:b', JSON.stringify({ question: 'Q aux tiers ' + i + ' ?', to: 'agent:z' }));
    }
    const visible = await seedEvent(cycleId, 'clarify.ask', 'agent:b', JSON.stringify({ question: 'Q visible au-delà de la fenêtre ?' }));
    const open = await loadOpenQuestions(db, cycleId, { participantIds: new Set(['agent:a']) });
    expect(open).toEqual(['#' + visible + ' (agent:b) Q visible au-delà de la fenêtre ?']);
  });

  it('buildRolePacket rend la question visible adressée au-delà de la fenêtre d’adressages aux tiers', async () => {
    const cycleId = await seedCycle();
    for (let i = 0; i < 50; i++) {
      await seedEvent(cycleId, 'clarify.ask', 'agent:b', JSON.stringify({ question: 'Q aux tiers ' + i + ' ?', to: 'agent:z' }));
    }
    const visible = await seedEvent(cycleId, 'clarify.ask', 'agent:b', JSON.stringify({ question: 'Q packet visible ?', to: 'agent:a' }));
    const packet = await buildRolePacket(db, { cycle: cycleId, participant_id: 'agent:a' }, { c0BaselineTokens: 100, approvedBudgetTokens: 6000 });
    expect(packet.open_questions).toEqual(['#' + visible + ' (agent:b) Q packet visible ?']);
  });

  it('trim global : aucune question du journal retenue n’est perdue — refs, questions de l’appelant puis mémoire cèdent d’abord', async () => {
    const cycleId = await seedCycle();
    const seqs: number[] = [];
    for (let i = 0; i < 6; i++) {
      seqs.push(await seedEvent(cycleId, 'clarify.ask', 'agent:b', JSON.stringify({ question: 'Q prioritaire ' + i + ' ?' })));
    }
    const packet = await buildRolePacket(db, { cycle: cycleId, participant_id: 'agent:a' }, {
      c0BaselineTokens: 100,
      approvedBudgetTokens: 400,
      refs: Array.from({ length: 40 }, (_, i) => 'https://example.invalid/' + i + '/' + 'x'.repeat(120)),
      openQuestions: Array.from({ length: 10 }, (_, i) => 'question de l’appelant ' + i + ' ' + 'y'.repeat(80)),
      memoryOverride: Array.from({ length: 5 }, (_, i) => ({
        id: 'mem-gpt6-' + i, version: 1, scope: 'common', kind: 'fact',
        text: 'entrée mémoire ' + i + ' ' + 'z'.repeat(80), confidence: 'observed',
      })),
    });
    expect(packet.open_questions).toHaveLength(6);
    for (let i = 0; i < seqs.length; i++) {
      expect(packet.open_questions[i]).toContain('#' + seqs[i] + ' ');
    }
    expect(packet.budget.estimated_tokens).toBeLessThanOrEqual(packet.budget.max_tokens);
  });

  it('budget trop faible pour les questions du journal retenues : PACKET_BUDGET_TOO_SMALL explicite, jamais de perte silencieuse', async () => {
    const cycleId = await seedCycle();
    for (let i = 0; i < 3; i++) {
      await seedEvent(cycleId, 'clarify.ask', 'agent:b', JSON.stringify({ question: 'Q longue prioritaire ' + i + ' ? ' + 'w'.repeat(300) }));
    }
    await expect(buildRolePacket(db, { cycle: cycleId, participant_id: 'agent:a' }, {
      c0BaselineTokens: 100,
      approvedBudgetTokens: 150,
      refs: ['https://example.invalid/r/1'],
      openQuestions: ['question de l’appelant'],
    })).rejects.toMatchObject({ code: 'PACKET_BUDGET_TOO_SMALL' });
  });
});
