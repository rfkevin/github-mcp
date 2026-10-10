import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { CollabStore, type StoredStoreEvent } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { revealProposalPayloads } from '../../../src/collab-store/store/sealed-reveal';
import { createSealedEnvelope } from '../../../src/collab-store/phases/sealed-envelope';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const cycle = 'crf05-bulk';
const otherCycle = 'crf05-other';
const SECRET = 'CRF05-SEALED-SECRET';
const sealId = (n: number) => 'crf05-item-' + n;

/** One SQL statement seeds N fixtures; test setup cost is excluded from read budget. */
async function seed(n: number): Promise<void> {
  const envelope = await createSealedEnvelope(SECRET);
  await db.prepare([
    'WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < ?2 - 1)',
    'INSERT INTO sealed_items (id, cycle_id, phase, participant_id, content_hash, content, revealed_at)',
    "SELECT 'crf05-item-' || n, ?1, 'P1', 'alpha', ?3, ?4, CASE WHEN n % 2 = 0 THEN 1 ELSE NULL END FROM seq",
  ].join(' ')).bind(cycle, n, envelope.content_hash, envelope.serialized).run();
  await db.prepare([
    'WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < ?2 - 1)',
    'INSERT INTO events (cycle_id, at, type, participant_id, payload_json, expected_rev, idempotency_key)',
    "SELECT ?1, 1, 'proposal.submit', 'alpha', json_object('sealed_id', 'crf05-item-' || n, 'content_hash', ?3), n, 'crf05-op-' || n FROM seq",
  ].join(' ')).bind(cycle, n, envelope.content_hash).run();
}
function event(n: number): StoredStoreEvent {
  return {
    seq: n + 1, cycle_id: cycle, at: 1, type: 'proposal.submit',
    participant_id: 'alpha', session_id: '', role: '', payload_json: JSON.stringify({ sealed_id: sealId(n), content_hash: 'hash' }),
    expected_rev: n, idempotency_key: 'f05-key-' + n, evidence_ref: '',
  };
}
function instrument(): { db: D1Database; count: () => number; maxBinds: () => number } {
  let reads = 0;
  let peak = 0;
  const wrapper = {
    prepare(sql: string) {
      reads += 1;
      const original = db.prepare(sql);
      return {
        bind(...values: unknown[]) {
          peak = Math.max(peak, values.length);
          return original.bind(...values);
        },
      };
    },
  } as unknown as D1Database;
  return { db: wrapper, count: () => reads, maxBinds: () => peak };
}

beforeAll(async () => {
  await ensureSchema(db);
  await db.prepare("INSERT INTO cycles (cycle_id) VALUES (?1), (?2)").bind(cycle, otherCycle).run();
  await seed(1000);
});

describe('CC-3 CR-F05 — bounded D1 sealed reveal', () => {
  it('60 sealed proposals use one D1 lookup; 30 hidden remain sealed; no ordering loss', async () => {
    const source = Array.from({ length: 60 }, (_, n) => event(n));
    const measure = instrument();
    const rendered = await revealProposalPayloads(measure.db, cycle, source);
    expect(measure.count()).toBe(1);
    expect(measure.maxBinds()).toBeLessThanOrEqual(100);
    expect(rendered.map(e => e.seq)).toEqual(source.map(e => e.seq));
    for (let i = 0; i < 60; i += 1) {
      const payload = JSON.parse(rendered[i].payload_json) as Record<string, unknown>;
      if (i % 2 === 0) {
        expect(payload).toMatchObject({ content: SECRET, revealed: true });
        expect(typeof payload.nonce).toBe('string');
      } else {
        expect(rendered[i]).toEqual(source[i]);
        expect(rendered[i].payload_json).not.toContain(SECRET);
      }
    }
  });

  it('1000 envelopes use 11 bounded D1 lookups (not N+1), preserving seq and all contents', async () => {
    const input = Array.from({ length: 1000 }, (_, n) => event(n));
    const measure = instrument();
    const out = await revealProposalPayloads(measure.db, cycle, input);
    expect(measure.count()).toBe(11); // ceil(1000 / 99)
    expect(measure.maxBinds()).toBe(100);
    expect(out).toHaveLength(1000);
    expect(out.map(e => e.seq)).toEqual(input.map(e => e.seq));
    expect(JSON.parse(out[998].payload_json).content).toBe(SECRET);
    expect(out[999].payload_json).toBe(input[999].payload_json);
  });

  it('duplicate ids, malformed payload, non-proposal and wrong cycle are not cross-revealed', async () => {
    const first = event(0);
    const bad = { ...event(1), payload_json: '{broken' };
    const wrong = { ...event(0), cycle_id: otherCycle };
    const note = { ...event(0), type: 'checkpoint' };
    const input = [first, first, bad, wrong, note];
    const measure = instrument();
    const rendered = await revealProposalPayloads(measure.db, cycle, input);
    expect(measure.count()).toBe(1); // deduplicated
    expect(JSON.parse(rendered[0].payload_json).content).toBe(SECRET);
    expect(rendered[1].payload_json).toBe(rendered[0].payload_json);
    expect(rendered.slice(2)).toEqual(input.slice(2));
    const missing = await revealProposalPayloads(db, otherCycle, [{ ...first, cycle_id: otherCycle }]);
    expect(missing[0].payload_json).toBe(first.payload_json);
  });

  it('fail-closed on D1 error: no permissive fallback or leaked proposal', async () => {
    const unavailable = {
      prepare() { throw new Error('D1 unavailable'); },
    } as unknown as D1Database;
    await expect(revealProposalPayloads(unavailable, cycle, [event(0)])).rejects.toThrow('D1 unavailable');
  });

  it('public getDelta keeps pagination, seq/cursors, hidden vs revealed, and reader redaction', async () => {
    const store = new CollabStore(db);
    const first = await store.getDelta(cycle, 0, 25, null);
    expect(first.events).toHaveLength(25);
    expect(first.hasMore).toBe(true);
    expect(JSON.parse(first.events[0].payload_json).content).toBe(SECRET);
    expect(first.events[1].payload_json).not.toContain(SECRET);
    const next = await store.getDelta(cycle, first.events[24].seq, 40, null);
    expect(next.events).toHaveLength(40);
    expect(next.hasMore).toBe(true);
    expect(next.events[0].seq).toBeGreaterThan(first.events[24].seq);
    expect(next.events.map(e => e.seq)).toEqual([...next.events].map(e => e.seq).sort((a, b) => a - b));
  });
});
