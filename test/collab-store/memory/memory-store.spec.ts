import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  MemoryStore,
  MemoryStoreError,
  pauseRequestPrefix,
  promoteConfidenceRequestId,
  promoteScopeRequestId,
  proposeRequestId,
  retireRequestId,
  supersedeRequestId,
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

/** Real C5 channel: owner.request via CollabStore + recordOwnerDecision (no direct INSERT). */
async function approveViaC5(requestId: string, summary: string, op: string): Promise<void> {
  const db = bindings.COLLAB_DB_C2;
  const cs = new CollabStore(db);
  const cycle = 'c4-owner-approvals';
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
  const decision = await recordOwnerDecision(db, {
    request_id: requestId,
    decision: 'approve',
    proof: { kind: 'secret' as const, subject: 'owner-secret' },
  });
  if (decision.status !== 'applied' && decision.status !== 'duplicate') {
    throw new Error('owner decision failed: ' + decision.status);
  }
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
      confidence: 'verified',
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

  it('retire of a protected kind requires an owner decision bound to the version', async () => {
    const mem = store();
    await approveViaC5(proposeRequestId('mem-prot-retire'), 'Approve invariant mem-prot-retire.', 'ret-prop');
    const p = await mem.propose({
      id: 'mem-prot-retire',
      scope: 'common',
      kind: 'invariant',
      text: 'Invariant that will be retired.',
      evidence_refs: ['plan:4'],
      confidence: 'verified',
      author_pid: 'agent:a',
      owner_decision_ref: proposeRequestId('mem-prot-retire'),
    });
    try {
      await mem.activate(p.id, 1, 'agent:b');
    } catch {
      /* protected activation pauses the scope */
    }
    if ((await mem.get(p.id, 1))?.status !== 'active') {
      const ref = (await pauseRequestPrefix('common')) + 'retire';
      await approveViaC5(ref, 'Clear common pause (retire test).', 'ret-pause');
      await mem.clearActivationPause(ref, 'common');
      await mem.activate(p.id, 1, 'agent:b');
    }
    await expect(mem.retire(p.id, 1)).rejects.toThrow(/PROTECTED_KIND_OWNER_REQUIRED|required/);
    const wrongRef = retireRequestId(p.id, 2);
    await approveViaC5(wrongRef, 'Decision bound to another version (must not leak).', 'ret-wrong');
    await expect(mem.retire(p.id, 1, 'default', wrongRef)).rejects.toThrow(/does not target subject/);
    const goodRef = retireRequestId(p.id, 1);
    await approveViaC5(goodRef, 'Approve retiring mem-prot-retire v1.', 'ret-ok');
    expect((await mem.retire(p.id, 1, 'default', goodRef)).status).toBe('retired');
  });

  it('a supersede approval never authorizes the next supersede of the same id', async () => {
    const mem = store();
    await approveViaC5(proposeRequestId('mem-prot-sup'), 'Approve invariant mem-prot-sup.', 'sup-prop');
    const p = await mem.propose({
      id: 'mem-prot-sup',
      scope: 'common',
      kind: 'invariant',
      text: 'Invariant superseded twice.',
      evidence_refs: ['plan:4'],
      confidence: 'verified',
      author_pid: 'agent:a',
      owner_decision_ref: proposeRequestId('mem-prot-sup'),
    });
    try {
      await mem.activate(p.id, 1, 'agent:b');
    } catch {
      /* protected activation pauses the scope */
    }
    if ((await mem.get(p.id, 1))?.status !== 'active') {
      const ref = (await pauseRequestPrefix('common')) + 'sup1';
      await approveViaC5(ref, 'Clear common pause (supersede test).', 'sup-pause1');
      await mem.clearActivationPause(ref, 'common');
      await mem.activate(p.id, 1, 'agent:b');
    }
    const v2ref = supersedeRequestId(p.id, 2);
    await approveViaC5(v2ref, 'Approve supersede mem-prot-sup to v2.', 'sup-v2');
    const next = await mem.supersede(p.id, 'agent:c', 'Wording clarified.', ['plan:4'], undefined, undefined, v2ref);
    expect(next.version).toBe(2);
    try {
      await mem.activate(p.id, 2, 'agent:b');
    } catch {
      /* protected activation pauses the scope */
    }
    if ((await mem.get(p.id, 2))?.status !== 'active') {
      const ref = (await pauseRequestPrefix('common')) + 'sup2';
      await approveViaC5(ref, 'Clear common pause (supersede v2 activation).', 'sup-pause2');
      await mem.clearActivationPause(ref, 'common');
      await mem.activate(p.id, 2, 'agent:b');
    }
    await expect(
      mem.supersede(p.id, 'agent:c', 'Unauthorized v3.', ['plan:4'], undefined, undefined, v2ref),
    ).rejects.toThrow(/does not target subject/);
    const v3ref = supersedeRequestId(p.id, 3);
    await approveViaC5(v3ref, 'Approve supersede mem-prot-sup to v3.', 'sup-v3');
    expect(
      (await mem.supersede(p.id, 'agent:c', 'Third wording.', ['plan:4'], undefined, undefined, v3ref)).version,
    ).toBe(3);
  });

  it('promoteScope of a protected kind requires an owner decision bound to the occurrence', async () => {
    const mem = store();
    await approveViaC5(proposeRequestId('mem-prot-scope'), 'Approve invariant mem-prot-scope.', 'scope-prop');
    const p = await mem.propose({
      id: 'mem-prot-scope',
      scope: 'participant:agent:a',
      kind: 'invariant',
      text: 'Personal invariant lifted to project scope.',
      evidence_refs: ['plan:4'],
      confidence: 'verified',
      author_pid: 'agent:a',
      owner_decision_ref: proposeRequestId('mem-prot-scope'),
    });
    try {
      await mem.activate(p.id, 1, 'agent:b');
    } catch {
      /* protected activation pauses the scope */
    }
    if ((await mem.get(p.id, 1))?.status !== 'active') {
      const ref = (await pauseRequestPrefix('participant:agent:a')) + 'scope';
      await approveViaC5(ref, 'Clear participant pause (scope test).', 'scope-pause');
      await mem.clearActivationPause(ref, 'participant:agent:a');
      await mem.activate(p.id, 1, 'agent:b');
    }
    await expect(mem.promoteScope(p.id, 1, 'agent:b', 'project:cc4')).rejects.toThrow(
      /PROTECTED_KIND_OWNER_REQUIRED|required/,
    );
    const wrongRef = await promoteScopeRequestId(p.id, 2, 'project:other');
    await approveViaC5(wrongRef, 'Decision for another target scope (must not leak).', 'scope-wrong');
    await expect(mem.promoteScope(p.id, 1, 'agent:b', 'project:cc4', wrongRef)).rejects.toThrow(
      /does not target subject/,
    );
    const goodRef = await promoteScopeRequestId(p.id, 2, 'project:cc4');
    await approveViaC5(goodRef, 'Approve lifting mem-prot-scope to project:cc4.', 'scope-ok');
    const lifted = await mem.promoteScope(p.id, 1, 'agent:b', 'project:cc4', goodRef);
    expect(lifted.scope).toBe('project:cc4');
    expect(lifted.version).toBe(2);
    expect(lifted.status).toBe('candidate');
  });

  it('promoteConfidence of a protected kind requires an owner decision (candidate and active)', async () => {
    const mem = store();
    await approveViaC5(proposeRequestId('mem-prot-conf'), 'Approve invariant mem-prot-conf.', 'conf-prop');
    const p = await mem.propose({
      id: 'mem-prot-conf',
      scope: 'participant:agent:a',
      kind: 'invariant',
      text: 'Invariant whose confidence will be raised.',
      evidence_refs: ['plan:4'],
      confidence: 'observed',
      author_pid: 'agent:a',
      owner_decision_ref: proposeRequestId('mem-prot-conf'),
    });
    // candidate path: no decision -> rejected; occurrence-bound decision -> allowed
    await seedLedger('agent:b', 'ev-prot-conf-1');
    await expect(mem.promoteConfidence(p.id, 1, 'agent:b', 'ev-prot-conf-1', 'verified')).rejects.toThrow(
      /PROTECTED_KIND_OWNER_REQUIRED|required/,
    );
    const candRef = await promoteConfidenceRequestId(p.id, 1, 'verified');
    await approveViaC5(candRef, 'Approve confidence verified for mem-prot-conf v1.', 'conf-cand');
    const upCand = await mem.promoteConfidence(p.id, 1, 'agent:b', 'ev-prot-conf-1', 'verified', candRef);
    expect(upCand.confidence).toBe('verified');
    expect(upCand.status).toBe('candidate');
    // active path: supersede-bound decision; the candidate-bound one must not leak
    try {
      await mem.activate(p.id, 1, 'agent:b');
    } catch {
      /* protected activation pauses the scope */
    }
    if ((await mem.get(p.id, 1))?.status !== 'active') {
      const ref = (await pauseRequestPrefix('participant:agent:a')) + 'conf';
      await approveViaC5(ref, 'Clear participant pause (confidence test).', 'conf-pause');
      await mem.clearActivationPause(ref, 'participant:agent:a');
      await mem.activate(p.id, 1, 'agent:b');
    }
    await seedLedger('agent:b', 'ev-prot-conf-2');
    await expect(
      mem.promoteConfidence(p.id, 1, 'agent:b', 'ev-prot-conf-2', 'owner_validated', candRef),
    ).rejects.toThrow(/does not target subject/);
    const supRef = supersedeRequestId(p.id, 2);
    await approveViaC5(supRef, 'Approve supersede mem-prot-conf to v2 (confidence).', 'conf-sup');
    const upActive = await mem.promoteConfidence(p.id, 1, 'agent:b', 'ev-prot-conf-2', 'owner_validated', supRef);
    expect(upActive.version).toBe(2);
    expect(upActive.confidence).toBe('owner_validated');
  });
});
