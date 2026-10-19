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
