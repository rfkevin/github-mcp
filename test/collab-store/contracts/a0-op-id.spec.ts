import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStore, CollabStoreError } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { parseOpId, validateOpId } from '../../../src/collab-store/contracts';
import { StateContractError } from '../../../src/collab/contracts';

// CC-4 A0 (point 1, github-mcp#110) — grammaire stricte de l'op_id
// {client}:{cycle}:{op}:{n} : exactement quatre segments, aucun deux-points
// interne. Les ids réels fautifs du cycle cc4-design (seq 103/104 :
// « op:op:vibe:cc4-design:p2-review:1 », « op:vibe:cc4-design:p2-review:1 »)
// étaient acceptés par l'ancienne grammaire relâchée : ils sont maintenant un
// INVALID_OP_ID dur, jugé avant toute écriture (le rejeu reste prioritaire).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let counter = 0;
let day = 0;

function uniq(label: string): string {
  counter += 1;
  return ('a0op-' + label + '-' + counter).slice(0, 64);
}

function makeStore(): CollabStore {
  day += 1;
  return new CollabStore(db, { dailyWriteLimit: 100_000, now: () => new Date('2026-12-' + String(day).padStart(2, '0') + 'T10:00:00.000Z') });
}

function codeOf(error: unknown): string {
  return (error as { code: string }).code;
}

async function eventCount(cycle: string): Promise<number> {
  await ensureSchema(db);
  const row = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1')
    .bind(cycle).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('CC-4 A0 (point 1) — op_id strict {client}:{cycle}:{op}:{n}', () => {
  it('parseOpId : quatre segments exacts, chacun sans deux-points', () => {
    expect(parseOpId('vibe:cc4-design:p2-review:1'))
      .toEqual({ client: 'vibe', cycle: 'cc4-design', op: 'p2-review', n: '1' });
    expect(validateOpId('grok:cc4-design:source-check:12')).toBe('grok:cc4-design:source-check:12');
    for (const bad of [
      'vibe:cc4-design:p2-review',            // 3 segments
      'vibe:cc4-design:p2-review:1:2',        // 5 segments
      'op:op:vibe:cc4-design:p2-review:1',    // 6 segments (seq 103 réel)
      'op:vibe:cc4-design:p2-review:1',       // préfixe op: (seq 104 réel)
      'vibe:cc4-design:rev.iew:1',            // point interdit dans un segment
      ':vibe:cc4-design:review:1',            // segment client vide
      'vibe::review:1',                       // segment cycle vide
    ]) {
      try {
        parseOpId(bad);
        expect.unreachable('op_id invalide accepté : ' + bad);
      } catch (error) {
        expect(error).toBeInstanceOf(StateContractError);
        expect(codeOf(error)).toBe('INVALID_OP_ID');
      }
    }
  });

  it('les ids réels fautifs du cycle cc4-design : INVALID_OP_ID dur, rien écrit', async () => {
    const store = makeStore();
    const cycle = uniq('faulty');
    for (const opId of ['op:op:vibe:cc4-design:p2-review:1', 'op:vibe:cc4-design:p2-review:1']) {
      try {
        await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'vibe',
          expected_rev: 0, payload_json: '{"n":1}', op_id: opId });
        expect.unreachable('op_id fautif accepté : ' + opId);
      } catch (error) {
        expect(error).toBeInstanceOf(StateContractError);
        expect(codeOf(error)).toBe('INVALID_OP_ID');
      }
    }
    expect(await eventCount(cycle)).toBe(0);
  });

  it('segment client = participant serveur (pid sans deux-points) : applied', async () => {
    const store = makeStore();
    const cycle = uniq('client');
    const applied = await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'vibe',
      expected_rev: 0, payload_json: '{"n":1}', op_id: 'vibe:' + cycle + ':cp:1' });
    expect(applied.status).toBe('applied');
  });

  it('segment client ≠ participant sans deux-points : INVALID_OP_ID (CollabStoreError)', async () => {
    const store = makeStore();
    const cycle = uniq('mismatch');
    try {
      await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'grok',
        expected_rev: 0, payload_json: '{"n":1}', op_id: 'vibe:' + cycle + ':cp:1' });
      expect.unreachable('client ≠ participant doit être refusé');
    } catch (error) {
      expect(error).toBeInstanceOf(CollabStoreError);
      expect(codeOf(error)).toBe('INVALID_OP_ID');
    }
    expect(await eventCount(cycle)).toBe(0);
  });

  it('exemption documentée : ids legacy avec deux-points (agent:a, pseudonymes unregistered:)', async () => {
    const store = makeStore();
    const cycle = uniq('legacy');
    const applied = await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a',
      expected_rev: 0, payload_json: '{"n":1}', op_id: 't:' + cycle + ':cp:1' });
    expect(applied.status).toBe('applied');
  });

  it('segment cycle erroné : INVALID_OP_ID même pour un participant exempté (compat A05)', async () => {
    const store = makeStore();
    const cycle = uniq('cycle');
    try {
      await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:a',
        expected_rev: 0, payload_json: '{"n":1}', op_id: 't:autre-cycle:cp:1' });
      expect.unreachable('le segment cycle erroné doit être refusé');
    } catch (error) {
      expect(error).toBeInstanceOf(CollabStoreError);
      expect(codeOf(error)).toBe('INVALID_OP_ID');
    }
    expect(await eventCount(cycle)).toBe(0);
  });

  it('rejeu du même op_id : duplicate, jugé avant les égalités (réponse perdue)', async () => {
    const store = makeStore();
    const cycle = uniq('replay');
    const input = { cycle_id: cycle, type: 'checkpoint' as const, participant_id: 'vibe',
      expected_rev: 0, payload_json: '{"n":1}', op_id: 'vibe:' + cycle + ':cp:1' };
    const first = await store.appendEvent(input);
    expect(first.status).toBe('applied');
    const retry = await store.appendEvent(input);
    expect(retry.status).toBe('duplicate');
    expect((retry as { event: { seq: number } }).event.seq).toBe((first as { event: { seq: number } }).event.seq);
  });
});
