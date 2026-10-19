import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { cycleArchiveSummary } from '../../../src/collab-store/research/archive';

const db = (env as unknown as { COLLAB_DB_C6_RESTORE: D1Database }).COLLAB_DB_C6_RESTORE;
let n = 0;
const unique = (tag: string) => 'l5-arch-' + tag + '-' + ++n;

describe('L5 per-cycle archive summary (D3-b)', () => {
  it('summarizes a cycle journal range and hashes the summary', async () => {
    await ensureSchema(db, true);
    const cycle = unique('cycle');
    await db.prepare('INSERT INTO cycles (cycle_id) VALUES (?1)').bind(cycle).run();
    for (let i = 1; i <= 2; i++) {
      await db
        .prepare("INSERT INTO events (cycle_id, at, type, participant_id, payload_json, idempotency_key) VALUES (?1, ?2, 'l5.test', 'l5-author', '{}', ?3)")
        .bind(cycle, 1000 + i, unique('ev'))
        .run();
    }
    const summary = await cycleArchiveSummary(db, cycle);
    expect(summary.cycle_id).toBe(cycle);
    expect(summary.events).toBe(2);
    expect(summary.seq_from).not.toBeNull();
    expect(summary.seq_to).not.toBeNull();
    expect(summary.seq_to! - summary.seq_from!).toBe(1);
    expect(summary.archive_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.notice).toContain('authority');
    expect(summary.origin_memory_entries).toBe(0);
  });

  it('fails closed on an unknown cycle', async () => {
    await ensureSchema(db, true);
    await expect(cycleArchiveSummary(db, unique('missing'))).rejects.toMatchObject({ code: 'UNKNOWN_CYCLE' });
  });
});
