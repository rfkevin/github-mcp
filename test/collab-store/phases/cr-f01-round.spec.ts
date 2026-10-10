import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { advanceByPolicy, inspectPhase } from '../../../src/collab-store/phases';
import { advanceGuarded } from '../../../src/collab-store/phases/gate';
import { sealProposal, readSealedProposal } from '../../../src/collab-store/phases/sealing';
import { CollabStoreError } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;

/** Two authors (alpha, beta) as task owners; P1 needs 2 proposal.submit; P2 can return to P1. */
async function seedRoundCycle(): Promise<string> {
  await ensureSchema(db);
  const cycle = 'crf01-' + (++n) + '-' + Date.now().toString(36);
  await db.prepare("INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P1', 1, 'open')").bind(cycle).run();
  await db.prepare([
    'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
    "VALUES (?1, 'P1', '[]', ?2, '[]', 'policy-p1')",
  ].join(' ')).bind(cycle, JSON.stringify([{ role: 'author', kind: 'proposal.submit', count: 2 }])).run();
  await db.prepare([
    'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
    "VALUES (?1, 'P2', '[]', '[]', '[]', 'policy-p2')",
  ].join(' ')).bind(cycle).run();
  await db.prepare([
    'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
    "VALUES ('t-a', ?1, 'alpha', 'rev-a', 'tst-a', 'in_progress', '[]', '', '', 1)",
  ].join(' ')).bind(cycle).run();
  await db.prepare([
    'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
    "VALUES ('t-b', ?1, 'beta', 'rev-b', 'tst-b', 'in_progress', '[]', '', '', 1)",
  ].join(' ')).bind(cycle).run();
  return cycle;
}

async function propose(cycle: string, pid: string, key: string, content: string): Promise<string> {
  const sealed = await sealProposal(db, {
    id: 'seal-' + key, cycle_id: cycle, phase: 'P1', participant_id: pid, content,
  });
  await db.prepare([
    'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
    "VALUES (?1, 1, 'proposal.submit', ?2, '', 'author', ?3, 0, ?4, '')",
  ].join(' ')).bind(
    cycle, pid,
    JSON.stringify({ sealed_id: sealed.id, content_hash: sealed.content_hash }),
    key,
  ).run();
  return sealed.id;
}

describe('CC-3 CR-F01 — isolation des sorties par ronde P1',
  () => {
    it('première ronde : 2 auteurs requis, 1 seul → PHASE_OUTPUTS_INCOMPLETE',
      async () => {
        const cycle = await seedRoundCycle();
        await propose(cycle, 'alpha', 'r1-alpha-' + n, 'alpha-r1');
        expect((await inspectPhase(db, cycle)).outputsSatisfied).toBe(false);
        await expect(advanceByPolicy(db, {
          cycle_id: cycle, expected_revision: 1, policy_id: 'policy-p1', next_phase: 'P2',
        })).rejects.toMatchObject({ code: 'PHASE_OUTPUTS_INCOMPLETE' });
        await propose(cycle, 'beta', 'r1-beta-' + n, 'beta-r1');
        expect((await inspectPhase(db, cycle)).outputsSatisfied).toBe(true);
        const adv = await advanceByPolicy(db, {
          cycle_id: cycle, expected_revision: 1, policy_id: 'policy-p1', next_phase: 'P2',
        });
        expect(adv.status).toBe('applied');
      });

    it('P1→P2→P1 : contributions de la 1re ronde ne comptent plus ; seul alpha en ronde 2 → INCOMPLETE',
      async () => {
        const cycle = await seedRoundCycle();
        const sealA1 = await propose(cycle, 'alpha', 'r1a-' + n, 'alpha-round-1');
        const sealB1 = await propose(cycle, 'beta', 'r1b-' + n, 'beta-round-1');
        const toP2 = await advanceGuarded(db, {
          cycle_id: cycle, expected_revision: 1, next_phase: 'P2',
        });
        expect(toP2.status).toBe('applied');

        // Round-1 seals revealed on leave P1
        const a1 = await readSealedProposal(db, { id: sealA1, participant_id: 'beta' });
        expect(a1.revealed).toBe(true);
        expect(a1.content).toBe('alpha-round-1');
        const b1 = await readSealedProposal(db, { id: sealB1, participant_id: 'alpha' });
        expect(b1.revealed).toBe(true);

        // Return to P1 (P2 auto_advance policy-p2)
        const back = await advanceGuarded(db, {
          cycle_id: cycle, expected_revision: 2, next_phase: 'P1',
        });
        expect(back.status).toBe('applied');
        expect((await inspectPhase(db, cycle)).phase).toBe('P1');

        // Old contributions must NOT satisfy the new round
        expect((await inspectPhase(db, cycle)).outputsSatisfied).toBe(false);

        // Only alpha contributes in round 2
        const sealA2 = await propose(cycle, 'alpha', 'r2a-' + n, 'alpha-round-2-secret');
        expect((await inspectPhase(db, cycle)).outputsSatisfied).toBe(false);
        await expect(advanceGuarded(db, {
          cycle_id: cycle, expected_revision: 3, next_phase: 'P2',
        })).rejects.toMatchObject({ code: 'PHASE_OUTPUTS_INCOMPLETE' });

        // New-round seal still hidden from beta until legitimate advance
        const hidden = await readSealedProposal(db, { id: sealA2, participant_id: 'beta' });
        expect(hidden.revealed).toBe(false);
        expect(hidden.content).toBeNull();

        // Beta completes round 2 → advance + reveal
        await propose(cycle, 'beta', 'r2b-' + n, 'beta-round-2');
        expect((await inspectPhase(db, cycle)).outputsSatisfied).toBe(true);
        const toP2again = await advanceGuarded(db, {
          cycle_id: cycle, expected_revision: 3, next_phase: 'P2',
        });
        expect(toP2again.status).toBe('applied');
        const revealed = await readSealedProposal(db, { id: sealA2, participant_id: 'beta' });
        expect(revealed.revealed).toBe(true);
        expect(revealed.content).toBe('alpha-round-2-secret');
      });

    it('réentrée P1 : zéro contribution de la ronde courante → INCOMPLETE même si l’historique est riche',
      async () => {
        const cycle = await seedRoundCycle();
        await propose(cycle, 'alpha', 'hist-a-' + n, 'old-a');
        await propose(cycle, 'beta', 'hist-b-' + n, 'old-b');
        await advanceGuarded(db, { cycle_id: cycle, expected_revision: 1, next_phase: 'P2' });
        await advanceGuarded(db, { cycle_id: cycle, expected_revision: 2, next_phase: 'P1' });
        const facts = await inspectPhase(db, cycle);
        expect(facts.outputsSatisfied).toBe(false);
        try {
          await advanceByPolicy(db, {
            cycle_id: cycle, expected_revision: 3, policy_id: 'policy-p1', next_phase: 'P2',
          });
          throw new Error('expected PHASE_OUTPUTS_INCOMPLETE');
        } catch (error) {
          expect(error).toBeInstanceOf(CollabStoreError);
          expect((error as CollabStoreError).code).toBe('PHASE_OUTPUTS_INCOMPLETE');
        }
      });
  });
