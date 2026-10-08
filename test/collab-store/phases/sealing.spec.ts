import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { advanceByPolicy, readSealedProposal, sealProposal } from '../../../src/collab-store/phases';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;

describe('CC-3 C3 — P1 sealing', () => {
  it('masque une proposition aux pairs en P1 puis la révèle à l’ouverture suivante', async () => {
    await ensureSchema(db);
    const cycle = 'c3s-' + (++n);
    const id = 'sealed-' + n;
    await db.prepare("INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P1', 1, 'open')").bind(cycle).run();
    await db.prepare([
      'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
      "VALUES (?1, 'P1', '[]', '[]', '[]', 'p1-open')",
    ].join(' ')).bind(cycle).run();
    await sealProposal(db, { id, cycle_id: cycle, phase: 'P1', participant_id: 'sol', content: 'private-plan' });

    const author = await readSealedProposal(db, { id, participant_id: 'sol' });
    expect(author.content).toBe('private-plan');
    expect(author.nonce).toBeTruthy();
    const hidden = await readSealedProposal(db, { id, participant_id: 'vibe' });
    expect(hidden.content).toBeNull();
    expect(hidden.nonce).toBeNull();

    await advanceByPolicy(db, { cycle_id: cycle, expected_revision: 1, policy_id: 'p1-open', next_phase: 'P2' });
    const peer = await readSealedProposal(db, { id, participant_id: 'vibe' });
    expect(peer.revealed).toBe(true);
    expect(peer.content).toBe('private-plan');
    expect(peer.nonce).toBeTruthy();
  });
});
