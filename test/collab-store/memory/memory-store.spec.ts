import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MemoryStore, MemoryStoreError } from '../../../src/collab-store/memory/memory-store';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { recordOwnerDecision } from '../../../src/collab-store/owner/decisions';
import { StateContractError } from '../../../src/collab/contracts';

const bindings = env as unknown as { COLLAB_DB_C2: D1Database };

function store(): MemoryStore {
  return new MemoryStore(bindings.COLLAB_DB_C2);
}

let ownerRequestN = 0;
async function approveOwnerSubject(subject: string): Promise<string> {
  const n = ++ownerRequestN;
  const requestId = `c4owner${n}`;
  const cycleId = `c4-owner-${n}`;
  const collab = new CollabStore(bindings.COLLAB_DB_C2);
  const filed = await collab.appendEvent({
    cycle_id: cycleId,
    type: 'owner.request',
    participant_id: 'agent:c4',
    expected_rev: 0,
    op_id: crypto.randomUUID(),
    payload_json: JSON.stringify({ request_id: requestId, subject, summary: `C4 owner approval for ${subject}` }),
  });
  expect(filed.status).toBe('applied');
  const approved = await recordOwnerDecision(bindings.COLLAB_DB_C2, {
    request_id: requestId,
    decision: 'approve',
    proof: { kind: 'secret', subject: 'c4-test-owner' },
  });
  expect(approved.decision).toBe('approve');
  return requestId;
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
    const invariantId = 'mem-invariant-setup';
    const proposeDecision = await approveOwnerSubject(`memory:${invariantId}:propose`);
    const p = await mem.propose({
      id: invariantId,
      scope: 'common',
      kind: 'invariant',
      text: 'I4 holds forever.',
      evidence_refs: ['plan:25'],
      author_pid: 'agent:a',
      owner_decision_ref: proposeDecision,
    });
    try {
      await mem.activate(p.id, 1, 'agent:b');
    } catch {
      /* pause on common */
    }
    const pauseDecision = await approveOwnerSubject('memory-pause:common');
    await mem.clearActivationPause(pauseDecision, 'common');
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
          const decision = await approveOwnerSubject('memory-pause:participant:agent:z');
          await mem.clearActivationPause(decision, 'participant:agent:z');
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
      scope: 'project:refute-only',
      kind: 'fact',
      text: 'Claim under review.',
      evidence_refs: ['e0'],
      author_pid: 'agent:a',
    });
    await mem.activate(p.id, 1, 'agent:b');
    for (let i = 0; i < 6; i++) await mem.recordRefute(p.id, 'agent:r' + i);
    expect(mem.getAlarms().some((a) => a.code === 'REFUTE_THRESHOLD')).toBe(true);
    expect(await mem.isActivationPaused('project:refute-only')).toBe(true);
  });

  async function seedLedger(producer: string, evidenceRef: string): Promise<void> {
    await bindings.COLLAB_DB_C2.prepare(
      `INSERT INTO evidence_ledger (subject_pid, producer, kind, payload_json, evidence_ref, at)
       VALUES (?1, ?2, 'evaluation', '{}', ?3, 1)`,
    )
      .bind('agent:a', producer, evidenceRef)
      .run();
  }

  it('promoteConfidence requires ledger peer evidence and rank increase', async () => {
    const mem = store();
    const p = await mem.propose({
      scope: 'participant:agent:a',
      kind: 'observation',
      text: 'Personal heuristic.',
      confidence: 'hypothesis',
      evidence_refs: ['self:a'],
      author_pid: 'agent:a',
    });
    await mem.activate(p.id, 1, 'agent:b');
    await expect(
      mem.promoteConfidence(p.id, 1, 'agent:a', 'peer:fake', 'observed'),
    ).rejects.toThrow(/distinct|PEER/);
    await expect(
      mem.promoteConfidence(p.id, 1, 'agent:b', 'peer:fake', 'observed'),
    ).rejects.toThrow(/PEER_EVIDENCE|ledger/);
    await seedLedger('agent:b', 'ev-peer-b-1');
    const up = await mem.promoteConfidence(p.id, 1, 'agent:b', 'ev-peer-b-1', 'observed');
    expect(up.confidence).toBe('observed');
    expect(up.version).toBe(2);
  });

  it('promoteConfidence rejects downgrade verified → observed', async () => {
    const mem = store();
    const p = await mem.propose({
      scope: 'project:rank-only',
      kind: 'fact',
      text: 'Already verified fact.',
      confidence: 'verified',
      evidence_refs: ['e0'],
      author_pid: 'agent:a',
    });
    await mem.activate(p.id, 1, 'agent:b');
    await seedLedger('agent:b', 'ev-peer-b-2');
    await expect(
      mem.promoteConfidence(p.id, 1, 'agent:b', 'ev-peer-b-2', 'observed'),
    ).rejects.toThrow(/CONFIDENCE_DOWNGRADE|rank/);
  });

  it('activation caps are independent per cycleId', async () => {
    const mem = store();
    for (const cycle of ['cya', 'cyb']) {
      for (let i = 0; i < 10; i++) {
        const p = await mem.propose({
          scope: `task:cap-${cycle}`,
          kind: 'observation',
          text: `cap item ${cycle} ${i}`,
          evidence_refs: [`e-${cycle}-${i}`],
          author_pid: 'agent:a',
        });
        // The growth alarm legitimately pauses a fresh scope after the
        // first activations (baseline = 1). Clear the pause with a real
        // owner decision fixture instead of bypassing product logic.
        if (await mem.isActivationPaused(`task:cap-${cycle}`)) {
          const decision = await approveOwnerSubject(`memory-pause:task:cap-${cycle}`);
          await mem.clearActivationPause(decision, `task:cap-${cycle}`);
        }
        await mem.activate(p.id, 1, 'agent:b', cycle);
      }
    }
    const extra = await mem.propose({
      scope: 'task:cap-cya',
      kind: 'observation',
      text: 'one too many on cya',
      evidence_refs: ['e-over'],
      author_pid: 'agent:a',
    });
    if (await mem.isActivationPaused('task:cap-cya')) {
      const decision = await approveOwnerSubject('memory-pause:task:cap-cya');
      await mem.clearActivationPause(decision, 'task:cap-cya');
    }
    await expect(mem.activate(extra.id, 1, 'agent:b', 'cya')).rejects.toThrow(/ACTIVATION_CAP/);
  });

  it('real C5 owner decision for another subject is rejected', async () => {
    const mem = store();
    const wrongDecision = await approveOwnerSubject('memory-pause:common');
    await expect(
      mem.propose({
        id: 'mem-wrong-subject',
        scope: 'common',
        kind: 'invariant',
        text: 'Needs matching subject.',
        evidence_refs: ['plan:x'],
        author_pid: 'agent:a',
        owner_decision_ref: wrongDecision,
      }),
    ).rejects.toThrow(/OWNER_DECISION_SUBJECT|subject/);
  });

  it('promoteScope lifts participant → project; rejects task', async () => {
    const mem = store();
    const p = await mem.propose({
      scope: 'participant:agent:a',
      kind: 'lesson',
      text: 'Reusable lesson from personal scope.',
      evidence_refs: ['self:a'],
      author_pid: 'agent:a',
      confidence: 'observed',
    });
    await mem.activate(p.id, 1, 'agent:b');
    await expect(mem.promoteScope(p.id, 1, 'agent:a', 'project:cc3')).rejects.toThrow(/distinct/);
    await expect(mem.promoteScope(p.id, 1, 'agent:b', 'task:t1')).rejects.toThrow(/SCOPE_TARGET|role|project|common/);
    const lifted = await mem.promoteScope(p.id, 1, 'agent:b', 'project:cc3');
    expect(lifted.scope).toBe('project:cc3');
    expect(lifted.status).toBe('candidate');
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
