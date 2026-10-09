import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildRolePacket, ensureContextSchema, mapIssueToCycle, toProjectScopeKey } from '../../../src/collab-store/context';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;

describe('CC-3 C3 — packet budget', () => {
  it('reste sous min(6000, 25% baseline) en supprimant les refs/questions de queue', async () => {
    await ensureContextSchema(db);
    const cycle = 'c3p-' + (++n);
    await db.prepare("INSERT INTO cycles (cycle_id, project, phase, revision, status) VALUES (?1, 'rfkevin/project-mcp-collab', 'P5', 1, 'open')").bind(cycle).run();
    await mapIssueToCycle(db, '#124', cycle);
    await db.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
      "VALUES ('c3', ?1, 'sol', 'muse', 'vibe', 'in_progress', '[]', 'ref', 'implement', 1)",
    ].join(' ')).bind(cycle).run();

    const packet = await buildRolePacket(
      db,
      { issue: 'issue 124', participant_id: 'sol' },
      {
        c0BaselineTokens: 12_000,
        refs: Array.from({ length: 100 }, (_, i) => 'https://example.invalid/' + i + '/' + 'x'.repeat(200)),
        openQuestions: Array.from({ length: 50 }, (_, i) => 'q' + i + ':' + 'y'.repeat(120)),
      },
    );
    expect(packet.budget.max_tokens).toBe(3000);
    expect(packet.budget.estimated_tokens).toBeLessThanOrEqual(3000);
    expect(Math.ceil(new TextEncoder().encode(JSON.stringify(packet.open_questions)).byteLength / 4)).toBeLessThanOrEqual(300);
    expect(packet.refs.complete).toBe(false);
    expect(packet.task?.task_id).toBe('c3');
  });

  it('utilise le budget approuvé C0 si 25% serait inférieur à 2k', async () => {
    const cycle = 'c3p-' + (++n);
    await ensureContextSchema(db);
    await db.prepare("INSERT INTO cycles (cycle_id, project, phase, revision, status) VALUES (?1, 'rfkevin/project-mcp-collab', 'P5', 1, 'open')").bind(cycle).run();
    await mapIssueToCycle(db, '#25', cycle);
    const packet = await buildRolePacket(db, { issue: 'issue 25', participant_id: 'sol' }, {
      c0BaselineTokens: 6600,
      approvedBudgetTokens: 6000,
    });
    expect(packet.budget.max_tokens).toBe(6000);
  });
});

describe('CC-3 F5 — I6 clé projet collision-safe', () => {
  async function seedProjectMemory(id: string, scope: string, text: string): Promise<void> {
    await db.prepare(
      "INSERT INTO memory_entries (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid, supersedes, uses, last_used_rev, expires_rev) " +
      "VALUES (?1, 1, ?2, 'fact', ?3, ?4, 'observed', 'active', 'sol', 'muse', NULL, 0, NULL, NULL)",
    ).bind(id, scope, text, '["ev-i6"]').run();
  }

  it('a/b-c et a-b/c → clés distinctes et conformes C4, aucune fuite inter-projets', async () => {
    await ensureSchema(db);
    await ensureContextSchema(db);
    const keyA = toProjectScopeKey('a/b-c');
    const keyB = toProjectScopeKey('a-b/c');
    if (keyA === null || keyB === null) throw new Error('I6 : clé projet nulle');
    expect(keyA).not.toBe(keyB);
    expect(keyA).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(keyB).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    const issueA = 801;
    const issueB = 802;
    const cycleA = 'f5i6a-' + (++n);
    const cycleB = 'f5i6b-' + (++n);
    await db.prepare(
      "INSERT INTO cycles (cycle_id, project, phase, revision, status) VALUES (?1, 'a/b-c', 'P1', 1, 'open')",
    ).bind(cycleA).run();
    await db.prepare(
      "INSERT INTO cycles (cycle_id, project, phase, revision, status) VALUES (?1, 'a-b/c', 'P1', 1, 'open')",
    ).bind(cycleB).run();
    await mapIssueToCycle(db, '#' + issueA, cycleA);
    await mapIssueToCycle(db, '#' + issueB, cycleB);

    const memA = ('i6-ma-' + (++n)).slice(0, 40);
    const memB = ('i6-mb-' + (++n)).slice(0, 40);
    const memLegacy = ('i6-lg-' + (++n)).slice(0, 40);
    await seedProjectMemory(memA, 'project:' + keyA, 'mémoire projet a/b-c uniquement');
    await seedProjectMemory(memB, 'project:' + keyB, 'mémoire projet a-b/c uniquement');
    await seedProjectMemory(memLegacy, 'project:a-b-c', 'slug legacy ne doit jamais fuiter');

    const packetA = await buildRolePacket(db, { issue: 'issue ' + issueA, participant_id: 'sol' }, { c0BaselineTokens: 12_000 });
    const idsA = packetA.memory.map(m => m.id);
    expect(idsA).toContain(memA);
    expect(idsA).not.toContain(memB);
    expect(idsA).not.toContain(memLegacy);

    const packetB = await buildRolePacket(db, { issue: 'issue ' + issueB, participant_id: 'sol' }, { c0BaselineTokens: 12_000 });
    const idsB = packetB.memory.map(m => m.id);
    expect(idsB).toContain(memB);
    expect(idsB).not.toContain(memA);
    expect(idsB).not.toContain(memLegacy);
  });
});
