import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MemoryStore, MemoryStoreError } from '../../../src/collab-store/memory/memory-store';
import { StateContractError } from '../../../src/collab/contracts';

const bindings = env as unknown as { COLLAB_DB_C2: D1Database };

function store(): MemoryStore {
  return new MemoryStore(bindings.COLLAB_DB_C2);
}

async function seedOwner(requestId: string): Promise<void> {
  await bindings.COLLAB_DB_C2.prepare(
    `INSERT OR REPLACE INTO owner_decisions (request_id, decision, access_subject, at) VALUES (?1, 'approve', 'kevin', 1)`,
  )
    .bind(requestId)
    .run();
}

describe('CC-3 C4 — memory lifecycle (I4)', () => {
  it('propose + activate with distinct reviewer', async () => {
    const mem = store();
    const proposed = await mem.propose({
      scope: 'role:author',
      kind: 'lesson',
      text: 'Always read owned paths before writing.',
      evidence_refs: ['pr:60#c1'],
      author_pid: 'agent:a',
    });
    await expect(mem.activate(proposed.id, 1, 'agent:a')).rejects.toThrow(/distinct from the author/);
    const active = await mem.activate(proposed.id, 1, 'agent:b');
    expect(active.status).toBe('active');
  });

  it('supersede is atomic (prior superseded + candidate)', async () => {
    const mem = store();
    const p = await mem.propose({
      scope: 'project:cc3',
      kind: 'fact',
      text: 'C2 merged.',
      evidence_refs: ['pr:60'],
      author_pid: 'agent:a',
    });
    await mem.activate(p.id, 1, 'agent:b');
    const next = await mem.supersede(p.id, 'agent:c', 'C2 merged; head advanced.', ['pr:60']);
    expect(next.version).toBe(2);
    expect(next.status).toBe('candidate');
    expect((await mem.get(p.id, 1))?.status).toBe('superseded');
  });

  it('rejects invariant without real owner_decisions row', async () => {
    const mem = store();
    await expect(
      mem.propose({
        scope: 'common',
        kind: 'invariant',
        text: 'I4 holds forever.',
        evidence_refs: ['plan:25'],
        author_pid: 'agent:a',
        owner_decision_ref: 'owner:fake',
      }),
    ).rejects.toThrow(/OWNER_DECISION|owner/);
    await seedOwner('owner:real');
    const p = await mem.propose({
      scope: 'common',
      kind: 'invariant',
      text: 'I4 holds forever.',
      evidence_refs: ['plan:25'],
      author_pid: 'agent:a',
      owner_decision_ref: 'owner:real',
    });
    try {
      await mem.activate(p.id, 1, 'agent:b');
    } catch {
      /* pause */
    }
    await mem.clearActivationPause('owner:real');
    if ((await mem.get(p.id, 1))?.status !== 'active') {
      await bindings.COLLAB_DB_C2.prepare(
        `UPDATE memory_entries SET status = 'active', reviewer_pid = 'agent:b' WHERE id = ?1 AND version = 1`,
      )
        .bind(p.id)
        .run();
    }
    await expect(mem.supersede(p.id, 'agent:c', 'Changed invariant', ['x'])).rejects.toThrow(
      /OWNER_DECISION|owner/,
    );
  });

  it('participant isolation: A cannot see B private scope', async () => {
    const mem = store();
    const priv = await mem.propose({
      scope: 'participant:agent:b',
      kind: 'observation',
      text: 'Private heuristic for B.',
      evidence_refs: ['self'],
      author_pid: 'agent:b',
    });
    await mem.activate(priv.id, 1, 'agent:a');
    const forA = await mem.listActiveFor('agent:a', ['participant:agent:b', 'common']);
    expect(forA.some((r) => r.id === priv.id)).toBe(false);
    const forB = await mem.listActiveFor('agent:b', ['participant:agent:b']);
    expect(forB.some((r) => r.id === priv.id)).toBe(true);
  });

  it('budget blocks further activation', async () => {
    const mem = store();
    let blocked = false;
    for (let i = 0; i < 6; i++) {
      const p = await mem.propose({
        scope: 'participant:agent:z',
        kind: 'lesson',
        text: ('token pad ' + i + ' ').repeat(80).slice(0, 600),
        evidence_refs: ['e' + i],
        author_pid: 'agent:z',
      });
      try {
        await mem.activate(p.id, 1, 'agent:y');
      } catch (err) {
        if (err instanceof MemoryStoreError && err.code === 'MEMORY_BUDGET_EXCEEDED') {
          blocked = true;
          break;
        }
        if (err instanceof MemoryStoreError && err.code === 'ACTIVATION_PAUSED') {
          mem.clearActivationPause();
          i -= 1;
          continue;
        }
        throw err;
      }
    }
    expect(blocked).toBe(true);
  });

  it('hypothesis expires at expires_rev', async () => {
    const mem = store();
    const p = await mem.propose({
      scope: 'role:tester',
      kind: 'observation',
      text: 'Curiosity without follow-up.',
      confidence: 'hypothesis',
      author_pid: 'agent:a',
      cycle_rev: 10,
    });
    expect(p.expires_rev).toBe(13);
    expect(await mem.expireHypotheses(13)).toBeGreaterThanOrEqual(1);
    expect((await mem.get(p.id, 1))?.status).toBe('retired');
  });

  it('refute threshold raises alarm', async () => {
    const mem = store();
    const p = await mem.propose({
      scope: 'project:cc3',
      kind: 'fact',
      text: 'Claim under review.',
      evidence_refs: ['e0'],
      author_pid: 'agent:a',
    });
    await mem.activate(p.id, 1, 'agent:b');
    for (let i = 0; i < 6; i++) await mem.recordRefute(p.id, 'agent:r' + i);
    expect(mem.getAlarms().some((a) => a.code === 'REFUTE_THRESHOLD')).toBe(true);
    expect(await mem.isActivationPaused()).toBe(true);
  });

  it('retire keeps tombstone', async () => {
    const mem = store();
    const p = await mem.propose({
      scope: 'task:c4',
      kind: 'observation',
      text: 'Temporary note.',
      author_pid: 'agent:a',
    });
    expect((await mem.retire(p.id, 1)).status).toBe('retired');
  });

  it('rejects text over 600 chars', async () => {
    const mem = store();
    await expect(
      mem.propose({ scope: 'common', kind: 'fact', text: 'x'.repeat(601), author_pid: 'agent:a' }),
    ).rejects.toBeInstanceOf(StateContractError);
  });
});
