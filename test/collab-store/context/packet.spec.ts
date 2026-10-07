import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildRolePacket, ensureContextSchema, mapIssueToCycle } from '../../../src/collab-store/context';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;

describe('CC-3 C3 — packet budget', () => {
  it('reste sous min(6000, 25% baseline) en supprimant les refs/questions de queue', async () => {
    await ensureContextSchema(db);
    const cycle = 'c3p-' + (++n);
    await db.prepare("INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P5', 1, 'open')").bind(cycle).run();
    await mapIssueToCycle(db, '#24', cycle);
    await db.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
      "VALUES ('c3', ?1, 'sol', 'muse', 'vibe', 'in_progress', '[]', 'ref', 'implement', 1)",
    ].join(' ')).bind(cycle).run();

    const packet = await buildRolePacket(
      db,
      { issue: 'issue 24', participant_id: 'sol' },
      {
        c0BaselineTokens: 12_000,
        refs: Array.from({ length: 100 }, (_, i) => 'https://example.invalid/' + i + '/' + 'x'.repeat(200)),
        openQuestions: Array.from({ length: 50 }, (_, i) => 'q' + i + ':' + 'y'.repeat(120)),
      },
    );
    expect(packet.budget.max_tokens).toBe(3000);
    expect(packet.budget.estimated_tokens).toBeLessThanOrEqual(3000);
    expect(packet.refs.complete).toBe(false);
    expect(packet.task?.task_id).toBe('c3');
  });

  it('utilise le budget approuvé C0 si 25% serait inférieur à 2k', async () => {
    const cycle = 'c3p-' + (++n);
    await ensureContextSchema(db);
    await db.prepare("INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P5', 1, 'open')").bind(cycle).run();
    await mapIssueToCycle(db, '#25', cycle);
    const packet = await buildRolePacket(db, { issue: 'issue 25', participant_id: 'sol' }, {
      c0BaselineTokens: 6600,
      approvedBudgetTokens: 6000,
    });
    expect(packet.budget.max_tokens).toBe(6000);
  });
});
