import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { allowedNextPhases, assertAllowedTransition, advanceGuarded } from '../../../src/collab-store/phases/gate';
import { CollabStoreError } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;

/** Cycle at P1/rev with optional target defs and auto_advance on P1. */
async function seedCycle(opts: {
  autoAdvance?: string;
  entryP2?: string;
  skipP2?: boolean;
  expectedOutputs?: unknown[];
}): Promise<string> {
  await ensureSchema(db);
  const cycle = 'f5g-' + (++n) + '-' + Date.now().toString(36);
  await db.prepare("INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P1', 1, 'open')").bind(cycle).run();
  const outputs = JSON.stringify(opts.expectedOutputs ?? []);
  await db.prepare([
    'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
    "VALUES (?1, 'P1', '[]', ?2, '[]', ?3)",
  ].join(' ')).bind(cycle, outputs, opts.autoAdvance ?? 'policy-p1').run();
  if (!opts.skipP2) {
    await db.prepare([
      'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
      "VALUES (?1, 'P2', ?2, '[]', '[]', 'none')",
    ].join(' ')).bind(cycle, opts.entryP2 ?? '[]').run();
  }
  return cycle;
}

describe('F5 A07 phase gate — matrice', () => {
  it('autorise P1 -> P2 et refuse P1 -> P6', () => {
    expect(allowedNextPhases('P1')).toContain('P2');
    expect(() => assertAllowedTransition('P1', 'P2')).not.toThrow();
    expect(() => assertAllowedTransition('P1', 'P6')).toThrow(CollabStoreError);
  });

  it('ferme P6', () => {
    expect(allowedNextPhases('P6')).toEqual([]);
    try {
      assertAllowedTransition('P6', 'P1');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CollabStoreError);
      expect((error as CollabStoreError).code).toBe('PHASE_TRANSITION_FORBIDDEN');
    }
  });
});

describe('F5 A07 advanceGuarded — D1 réel (G1–G4)', () => {
  it('G1 — succès puis rejeu (réponse perdue) → duplicate même seq ; autre intention refusée', async () => {
    const cycle = await seedCycle({});
    const first = await advanceGuarded(db, {
      cycle_id: cycle, expected_revision: 1, next_phase: 'P2',
    });
    expect(first.status).toBe('applied');
    expect(first.revision).toBe(2);

    // Retry exacte après réponse perdue : phase déjà P2, mais findReplay avant inspect.
    const replay = await advanceGuarded(db, {
      cycle_id: cycle, expected_revision: 1, next_phase: 'P2',
    });
    expect(replay.status).toBe('duplicate');
    expect(replay.event_seq).toBe(first.event_seq);

    // Même expected_rev, intention différente (P3) : pas de findReplay.
    // Après succès, phase = P2 (auto_advance none) → POLICY_NOT_AUTHORIZED avant STALE.
    await expect(advanceGuarded(db, {
      cycle_id: cycle, expected_revision: 1, next_phase: 'P3' as never,
    })).rejects.toMatchObject({ code: 'POLICY_NOT_AUTHORIZED' });
  });

  it('G2 — auto_advance none : POLICY_NOT_AUTHORIZED (policy client ignorée)', async () => {
    const cycle = await seedCycle({ autoAdvance: 'none' });
    await expect(advanceGuarded(db, {
      cycle_id: cycle, expected_revision: 1, policy_id: 'forged-by-agent', next_phase: 'P2',
    })).rejects.toMatchObject({ code: 'POLICY_NOT_AUTHORIZED' });
  });

  it('G3 — cible absente / entry unmet / transition interdite', async () => {
    const missing = await seedCycle({ skipP2: true });
    await expect(advanceGuarded(db, {
      cycle_id: missing, expected_revision: 1, next_phase: 'P2',
    })).rejects.toMatchObject({ code: 'PHASE_DEFINITION_MISSING' });

    const unmet = await seedCycle({ entryP2: JSON.stringify(['need-review']) });
    await expect(advanceGuarded(db, {
      cycle_id: unmet, expected_revision: 1, next_phase: 'P2',
      conditionsSatisfied: async () => false,
    })).rejects.toMatchObject({ code: 'PHASE_ENTRY_CONDITIONS_UNMET' });

    const forbidden = await seedCycle({});
    await expect(advanceGuarded(db, {
      cycle_id: forbidden, expected_revision: 1, next_phase: 'P6',
    })).rejects.toMatchObject({ code: 'PHASE_TRANSITION_FORBIDDEN' });
  });

  it('G4 — deux appels concurrents même intention : un applied + un duplicate, un seul event', async () => {
    const cycle = await seedCycle({});
    const [a, b] = await Promise.all([
      advanceGuarded(db, { cycle_id: cycle, expected_revision: 1, next_phase: 'P2' }),
      advanceGuarded(db, { cycle_id: cycle, expected_revision: 1, next_phase: 'P2' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['applied', 'duplicate']);
    const applied = a.status === 'applied' ? a : b;
    const dup = a.status === 'duplicate' ? a : b;
    expect(dup.event_seq).toBe(applied.event_seq);
    const count = await db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'phase.advance'",
    ).bind(cycle).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('G5 — mauvais rev sans événement antérieur → STALE', async () => {
    const cycle = await seedCycle({});
    await expect(advanceGuarded(db, {
      cycle_id: cycle, expected_revision: 99, next_phase: 'P2',
    })).rejects.toMatchObject({ code: 'STALE' });
  });

  it('findReplay : tout phase.advance (cycle, expected_rev, to) est reconnu, quel que soit participant_id', async () => {
    // Documente le comportement : une avance policy (ou owner) antérieure avec le même
    // (expected_rev, to) est traitée comme rejeu, indépendamment de participant_id.
    const cycle = await seedCycle({});
    await db.prepare([
      'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
      "VALUES (?1, 1, 'phase.advance', 'policy:other', '', 'policy', ?2, 1, ?3, '')",
    ].join(' ')).bind(
      cycle,
      JSON.stringify({ from: 'P1', to: 'P2', policy_id: 'other' }),
      'manual-replay-' + n,
    ).run();
    const row = await db.prepare("SELECT seq FROM events WHERE cycle_id = ?1 AND type = 'phase.advance'").bind(cycle).first<{ seq: number }>();
    const replay = await advanceGuarded(db, {
      cycle_id: cycle, expected_revision: 1, next_phase: 'P2',
    });
    expect(replay.status).toBe('duplicate');
    expect(replay.event_seq).toBe(row!.seq);
  });
});
