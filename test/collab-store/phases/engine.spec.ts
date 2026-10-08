import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { advanceByPolicy, inspectPhase } from '../../../src/collab-store/phases';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;

describe('CC-3 C3 — phase policies', () => {
  it('avance uniquement via la policy autorisée et signe l’événement par policy id', async () => {
    await ensureSchema(db);
    const cycle = 'c3e-' + (++n);
    await db.prepare("INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P1', 1, 'open')").bind(cycle).run();
    await db.prepare([
      'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
      "VALUES (?1, 'P1', '[]', ?2, '[]', 'policy-p1')",
    ].join(' ')).bind(cycle, JSON.stringify([{ role: 'author', kind: 'proposal.submit', count: 1 }])).run();
    await db.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
      "VALUES ('c3', ?1, 'sol', 'muse', 'vibe', 'in_progress', '[]', '', '', 1)",
    ].join(' ')).bind(cycle).run();
    await db.prepare([
      'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
      "VALUES (?1, 1, 'proposal.submit', 'intrus', '', 'author', '{}', 0, ?2, '')",
    ].join(' ')).bind(cycle, 'seed-intrus-' + n).run();
    expect((await inspectPhase(db, cycle)).outputsSatisfied).toBe(false);
    await db.prepare([
      'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
      "VALUES (?1, 1, 'proposal.submit', 'sol', '', 'reviewer', '{}', 0, ?2, '')",
    ].join(' ')).bind(cycle, 'seed-sol-' + n).run();
    expect((await inspectPhase(db, cycle)).outputsSatisfied).toBe(true);

    await expect(advanceByPolicy(db, {
      cycle_id: cycle, expected_revision: 1, policy_id: 'wrong', next_phase: 'P2',
    })).rejects.toMatchObject({ code: 'POLICY_NOT_AUTHORIZED' });

    const result = await advanceByPolicy(db, {
      cycle_id: cycle, expected_revision: 1, policy_id: 'policy-p1', next_phase: 'P2',
    });
    expect(result).toMatchObject({ status: 'applied', revision: 2 });
    const event = await db.prepare('SELECT type, participant_id, role, evidence_ref FROM events WHERE seq = ?1')
      .bind(result.event_seq).first<{ type: string; participant_id: string; role: string; evidence_ref: string }>();
    expect(event).toEqual({
      type: 'phase.advance',
      participant_id: 'policy:policy-p1',
      role: 'policy',
      evidence_ref: 'policy:policy-p1',
    });
  });

  it('un agent ne peut pas écrire phase.advance', async () => {
    const store = new CollabStore(db);
    const cycle = 'c3e-' + (++n);
    await expect(store.appendEvent({
      cycle_id: cycle,
      type: 'phase.advance' as never,
      participant_id: 'sol',
      expected_rev: 0,
      op_id: 'sol:' + cycle + ':advance:1',
      payload_json: '{}',
    })).rejects.toMatchObject({ code: 'UNKNOWN_EVENT_TYPE' });
  });
});
