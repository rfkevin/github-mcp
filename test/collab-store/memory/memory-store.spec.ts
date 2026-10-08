import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  MemoryStore,
  MemoryStoreError,
  pauseRequestPrefix,
  proposeRequestId,
} from '../../../src/collab-store/memory/memory-store';
import { recordOwnerDecision } from '../../../src/collab-store/owner/decisions';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
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
        id: 'mem-inv-setup',
        scope: 'common',
        kind: 'invariant',
        text: 'I4 holds forever.',
        evidence_refs: ['plan:25'],
        author_pid: 'agent:a',
        owner_decision_ref: 'owner:fake',
      }),
    ).rejects.toThrow(/OWNER_DECISION|owner/);
    await seedOwner(proposeRequestId('mem-inv-setup'));
    const p = await mem.propose({
      id: 'mem-inv-setup',
      scope: 'common',
      kind: 'invariant',
      text: 'I4 holds forever.',
      evidence_refs: ['plan:25'],
      author_pid: 'agent:a',
      owner_decision_ref: proposeRequestId('mem-inv-setup'),
    });
    try {
      await mem.activate(p.id, 1, 'agent:b');
    } catch {
      /* pause on common */
    }
    const setupPauseRef = (await pauseRequestPrefix('common')) + 'setup';
    await seedOwner(setupPauseRef);
    await mem.clearActivationPause(setupPauseRef, 'common');
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
          const budgetPauseRef = (await pauseRequestPrefix('participant:agent:z')) + 'retry' + i;
          await seedOwner(budgetPauseRef);
          await mem.clearActivationPause(budgetPauseRef, 'participant:agent:z');
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
          const capPauseRef = (await pauseRequestPrefix(`task:cap-${cycle}`)) + 'act' + i;
          await seedOwner(capPauseRef);
          await mem.clearActivationPause(capPauseRef, `task:cap-${cycle}`);
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
      const extraPauseRef = (await pauseRequestPrefix('task:cap-cya')) + 'extra';
      await seedOwner(extraPauseRef);
      await mem.clearActivationPause(extraPauseRef, 'task:cap-cya');
    }
    await expect(mem.activate(extra.id, 1, 'agent:b', 'cya')).rejects.toThrow(/ACTIVATION_CAP/);
  });

  it('owner decision for wrong subject is rejected', async () => {
    const mem = store();
    // a real approve for another memory id must not authorize this one
    const otherRef = proposeRequestId('mem-inv-other');
    await seedOwner(otherRef);
    await expect(
      mem.propose({
        id: 'mem-inv-wrong-subject',
        scope: 'common',
        kind: 'invariant',
        text: 'Needs matching subject.',
        evidence_refs: ['plan:x'],
        author_pid: 'agent:a',
        owner_decision_ref: otherRef,
      }),
    ).rejects.toThrow(/OWNER_DECISION_SUBJECT|subject/);
    // protected kinds also require an explicit id (no id -> no request_id)
    await expect(
      mem.propose({
        scope: 'common',
        kind: 'invariant',
        text: 'Needs explicit id.',
        evidence_refs: ['plan:x'],
        author_pid: 'agent:a',
        owner_decision_ref: otherRef,
      }),
    ).rejects.toThrow(/explicit id/);
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

  it('E2E: the real C5 channel produces the decision C4 consumes (no direct INSERT)', async () => {
    const db = bindings.COLLAB_DB_C2;
    const mem = new MemoryStore(db);
    const cs = new CollabStore(db);
    const cycle = 'e2e-owner-decision';
    const proof = { kind: 'secret' as const, subject: 'owner-secret' };

    async function fileRequest(requestId: string, summary: string, op: string): Promise<void> {
      const outcome = await cs.appendEvent({
        cycle_id: cycle,
        type: 'owner.request',
        participant_id: 'agent:a',
        expected_rev: await cs.currentRevision(cycle),
        payload_json: JSON.stringify({ request_id: requestId, summary }),
        op_id: 'agent-a:' + cycle + ':' + op + ':1',
      });
      if (outcome.status !== 'applied' && outcome.status !== 'duplicate') {
        throw new Error('owner.request append failed: ' + outcome.status);
      }
    }

    // 1. agent files the request through the real store (C1/C2 channel)
    const requestId = proposeRequestId('mem-inv-e2e');
    await fileRequest(requestId, 'Approve invariant mem-inv-e2e (C4 x C5 E2E).', 'owner-request');

    // 2. owner approves through the real C5 decision path
    const decision = await recordOwnerDecision(db, { request_id: requestId, decision: 'approve', proof });
    expect(decision.status).toBe('applied');

    // 3. protected propose succeeds with the real owner_decisions row
    const p = await mem.propose({
      id: 'mem-inv-e2e',
      scope: 'common',
      kind: 'invariant',
      text: 'E2E invariant with a real owner decision.',
      evidence_refs: ['plan:25'],
      author_pid: 'agent:a',
      owner_decision_ref: requestId,
    });

    // 4. an approved decision for another id never authorizes this one
    const otherRef = proposeRequestId('mem-inv-e2e-other');
    await fileRequest(otherRef, 'Approve a different memory id (must not leak).', 'owner-request-2');
    await recordOwnerDecision(db, { request_id: otherRef, decision: 'approve', proof });
    await expect(
      mem.propose({
        id: 'mem-inv-e2e-second',
        scope: 'common',
        kind: 'invariant',
        text: 'Must be rejected: decision targets another subject.',
        evidence_refs: ['plan:25'],
        author_pid: 'agent:a',
        owner_decision_ref: otherRef,
      }),
    ).rejects.toThrow(/does not target subject/);

    // 5. activation pause cleared through the real channel as well
    try {
      await mem.activate(p.id, 1, 'agent:b');
    } catch {
      /* growth alarm may pause 'common' */
    }
    if ((await mem.get(p.id, 1))?.status !== 'active') {
      expect(await mem.isActivationPaused('common')).toBe(true);
      const e2ePauseRef = (await pauseRequestPrefix('common')) + 'e2e';
      await fileRequest(e2ePauseRef, 'Approve clearing the common activation pause (C4 x C5 E2E).', 'owner-request-3');
      await recordOwnerDecision(db, { request_id: e2ePauseRef, decision: 'approve', proof });
      await mem.clearActivationPause(e2ePauseRef, 'common');
      await mem.activate(p.id, 1, 'agent:b');
    }
    expect((await mem.get(p.id, 1))?.status).toBe('active');
  });
});
