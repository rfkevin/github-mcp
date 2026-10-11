import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStore, CollabStoreError } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-4 A0 (point 5, github-mcp#110) — une seule sortie par participant et par
// phase : le 2e proposal.submit du même participant dans la MÊME ronde (depuis
// la dernière (re)entrée dans cette phase, CR-F01) est refusé
// PROPOSAL_ALREADY_SUBMITTED, réponse perdue ou pas (cas réel GPT-6, seq 95/96
// du cycle cc4-design). La garde a deux étages : pré-check en lecture seule
// puis clause NOT EXISTS dans le batch CAS (fail-closed sous concurrence).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let counter = 0;
let day = 0;

function uniq(label: string): string {
  counter += 1;
  return ('a0pg-' + label + '-' + counter).slice(0, 64);
}

function makeStore(): CollabStore {
  day += 1;
  return new CollabStore(db, { dailyWriteLimit: 100_000, now: () => new Date('2026-12-' + String(day).padStart(2, '0') + 'T10:00:00.000Z') });
}

function codeOf(error: unknown): string {
  return (error as { code: string }).code;
}

function propose(cycle: string, pid: string, expectedRev: number, opN: number, content: string) {
  return { cycle_id: cycle, type: 'proposal.submit' as const, participant_id: pid,
    expected_rev: expectedRev, payload_json: JSON.stringify({ content }),
    op_id: pid + ':' + cycle + ':prop:' + opN };
}

async function countEvents(cycle: string): Promise<number> {
  await ensureSchema(db);
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'proposal.submit'"
  ).bind(cycle).first<{ n: number }>();
  return row?.n ?? 0;
}

async function countSealed(cycle: string): Promise<number> {
  await ensureSchema(db);
  const row = await db.prepare('SELECT COUNT(*) AS n FROM sealed_items WHERE cycle_id = ?1')
    .bind(cycle).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('CC-4 A0 (point 5) — une seule proposition par participant et par ronde', () => {
  it('2e proposal.submit du même participant : PROPOSAL_ALREADY_SUBMITTED, rien écrit', async () => {
    const store = makeStore();
    const cycle = uniq('round');
    await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'vibe',
      expected_rev: 0, payload_json: '{"n":1}', op_id: 'vibe:' + cycle + ':cp:1' });
    const first = await store.appendEvent(propose(cycle, 'vibe', 1, 1, 'plan-a'));
    expect(first.status).toBe('applied');
    try {
      await store.appendEvent(propose(cycle, 'vibe', 2, 2, 'plan-b'));
      expect.unreachable('le second proposal.submit du même participant doit être refusé');
    } catch (error) {
      expect(error).toBeInstanceOf(CollabStoreError);
      expect(codeOf(error)).toBe('PROPOSAL_ALREADY_SUBMITTED');
    }
    expect(await countEvents(cycle)).toBe(1);
    expect(await countSealed(cycle)).toBe(1);
  });

  it('rejeu du même op_id : duplicate, la garde ne masque jamais un rejeu', async () => {
    const store = makeStore();
    const cycle = uniq('replay');
    await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'vibe',
      expected_rev: 0, payload_json: '{"n":1}', op_id: 'vibe:' + cycle + ':cp:1' });
    const first = await store.appendEvent(propose(cycle, 'vibe', 1, 1, 'plan-a'));
    expect(first.status).toBe('applied');
    const retry = await store.appendEvent(propose(cycle, 'vibe', 1, 1, 'plan-a'));
    expect(retry.status).toBe('duplicate');
    expect((retry as { event: { seq: number } }).event.seq).toBe((first as { event: { seq: number } }).event.seq);
    expect(await countEvents(cycle)).toBe(1);
  });

  it('un autre participant peut proposer dans la même ronde', async () => {
    const store = makeStore();
    const cycle = uniq('other');
    await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'vibe',
      expected_rev: 0, payload_json: '{"n":1}', op_id: 'vibe:' + cycle + ':cp:1' });
    expect((await store.appendEvent(propose(cycle, 'vibe', 1, 1, 'plan-a'))).status).toBe('applied');
    const second = await store.appendEvent(propose(cycle, 'grok', 2, 1, 'plan-g'));
    expect(second.status).toBe('applied');
    expect(await countSealed(cycle)).toBe(2);
  });

  it('ronde suivante : après une (re)entrée dans la phase, le même participant peut proposer à nouveau', async () => {
    const store = makeStore();
    const cycle = uniq('nextround');
    await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'vibe',
      expected_rev: 0, payload_json: '{"n":1}', op_id: 'vibe:' + cycle + ':cp:1' });
    expect((await store.appendEvent(propose(cycle, 'vibe', 1, 1, 'plan-a'))).status).toBe('applied');
    // (Re)entrée dans P1 (CR-F01) : phase.advance inséré hors du chemin agent.
    await ensureSchema(db);
    await db.prepare([
      'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
      "VALUES (?1, 1, 'phase.advance', 'policy:a0-policy', '', 'policy', ?2, 2, ?3, '')",
    ].join(' ')).bind(cycle, JSON.stringify({ to: 'P1' }), 'seed-advance-' + cycle).run();
    const again = await store.appendEvent(propose(cycle, 'vibe', 2, 2, 'plan-a2'));
    expect(again.status).toBe('applied');
    expect(await countSealed(cycle)).toBe(2);
  });
});
