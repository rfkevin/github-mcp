import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  MemoryStore,
  MemoryStoreError,
  pauseRequestId,
  promoteConfidenceRequestId,
  promoteScopeRequestId,
  proposeRequestId,
  retireRequestId,
  StoredMemory,
  supersedeRequestId,
} from '../../../src/collab-store/memory/memory-store';
import { estimateTokens, type MemoryConfidence } from '../../../src/collab-store/contracts/memory';
import { ensureSchema } from '../../../src/collab-store/store/schema';
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

/** Append an owner.request through the real C1/C2 channel (no direct INSERT). */
async function fileOwnerRequest(cycle: string, requestId: string, summary: string, op: string): Promise<void> {
  const cs = new CollabStore(bindings.COLLAB_DB_C2);
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

/**
 * Real C5 channel: file the owner.request then record the approval (no direct INSERT).
 * CR-F02 : une alarme mémoire dépose elle-même la demande de reprise de sa pause
 * (cycle memory-alarms) ; on tranche alors cette demande-là, par sa seq.
 */
async function approveViaC5(requestId: string, summary: string, op: string): Promise<void> {
  const filed = await bindings.COLLAB_DB_C2.prepare([
    "SELECT seq FROM events WHERE type = 'owner.request' AND participant_id = 'system'",
    "AND json_extract(payload_json, '$.request_id') = ?1 ORDER BY seq DESC LIMIT 1",
  ].join(' ')).bind(requestId).first<{ seq: number }>();
  if (!filed) await fileOwnerRequest('c4-owner-approvals', requestId, summary, op);
  const decision = await recordOwnerDecision(bindings.COLLAB_DB_C2, {
    request_id: requestId,
    decision: 'approve',
    proof: { kind: 'secret' as const, subject: 'owner-secret' },
    ...(filed ? { request_seq: filed.seq } : {}),
  });
  if (decision.status !== 'applied' && decision.status !== 'duplicate') {
    throw new Error('owner decision failed: ' + decision.status);
  }
}

/** Propose a protected invariant approved through the real C5 channel. */
async function proposeProtectedInvariant(
  mem: MemoryStore,
  id: string,
  scope: string,
  confidence: MemoryConfidence = 'verified',
): Promise<StoredMemory> {
  const ref = proposeRequestId(id, 1);
  await approveViaC5(ref, `Approve invariant ${id} (C4 §4 mutation tests).`, 'prop-' + id);
  return mem.propose({
    id,
    scope,
    kind: 'invariant',
    text: `Protected invariant ${id} for §4 mutation tests.`,
    evidence_refs: ['plan:4'],
    confidence,
    author_pid: 'agent:a',
    owner_decision_ref: ref,
  });
}

/** Make a proposed version active, clearing any pause through the real C5 channel. */
async function ensureActive(
  mem: MemoryStore,
  id: string,
  version: number,
  scope: string,
  tag: string,
): Promise<void> {
  try {
    await mem.activate(id, version, 'agent:b');
  } catch {
    /* protected activation pauses the scope */
  }
  if ((await mem.get(id, version))?.status !== 'active') {
    const ref = await mem.pauseClearRequestId(scope);
    await approveViaC5(ref, `Clear ${scope} pause (${tag}).`, 'pause-' + tag);
    await mem.clearActivationPause(ref, scope);
    await mem.activate(id, version, 'agent:b');
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
    await seedOwner(proposeRequestId('mem-inv-setup', 1));
    const p = await mem.propose({
      id: 'mem-inv-setup',
      scope: 'common',
      kind: 'invariant',
      text: 'I4 holds forever.',
      evidence_refs: ['plan:25'],
      author_pid: 'agent:a',
      owner_decision_ref: proposeRequestId('mem-inv-setup', 1),
    });
    try {
      await mem.activate(p.id, 1, 'agent:b');
    } catch {
      /* pause on common */
    }
    const setupPauseRef = await mem.pauseClearRequestId('common');
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
          const budgetPauseRef = await mem.pauseClearRequestId('participant:agent:z');
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

  it('hypothesis expires at expires_rev of ITS origin cycle only (CR-F04)', async () => {
    const mem = store();
    const db = bindings.COLLAB_DB_C2;
    const p = await mem.propose({
      scope: 'role:tester',
      kind: 'observation',
      text: 'Curiosity without follow-up.',
      confidence: 'hypothesis',
      author_pid: 'agent:a',
      cycle_rev: 10,
      cycle_id: 'crf4-unit-origin',
    });
    expect(p.expires_rev).toBe(13);
    expect(p.expires_cycle).toBe('crf4-unit-origin');
    // Another cycle far ahead never expires it (the old global sweep did).
    await db.prepare("INSERT INTO cycles (cycle_id, revision) VALUES ('crf4-unit-other', 50)").run();
    expect(await mem.expireHypotheses('crf4-unit-other')).toBe(0);
    await db.prepare("INSERT INTO cycles (cycle_id, revision) VALUES ('crf4-unit-origin', 12)").run();
    expect(await mem.expireHypotheses('crf4-unit-origin')).toBe(0);
    expect((await mem.get(p.id, 1))?.status).toBe('candidate');
    await db.prepare("UPDATE cycles SET revision = 13 WHERE cycle_id = 'crf4-unit-origin'").run();
    expect(await mem.expireHypotheses('crf4-unit-origin')).toBe(1);
    expect((await mem.get(p.id, 1))?.status).toBe('retired');
    // Idempotent.
    expect(await mem.expireHypotheses('crf4-unit-origin')).toBe(0);
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
          const capPauseRef = await mem.pauseClearRequestId(`task:cap-${cycle}`);
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
      const extraPauseRef = await mem.pauseClearRequestId('task:cap-cya');
      await seedOwner(extraPauseRef);
      await mem.clearActivationPause(extraPauseRef, 'task:cap-cya');
    }
    await expect(mem.activate(extra.id, 1, 'agent:b', 'cya')).rejects.toThrow(/ACTIVATION_CAP/);
  });

  it('owner decision for wrong subject is rejected', async () => {
    const mem = store();
    // a real approve for another memory id must not authorize this one
    const otherRef = proposeRequestId('mem-inv-other', 1);
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
    // CR-D (GPT6-02) : la copie promue a son propre id (scope immuable), lignée tracée.
    expect(lifted.id).not.toBe(p.id);
    expect(lifted.version).toBe(1);
    expect(lifted.supersedes).toBe(`${p.id}@1`);
    expect((await mem.get(p.id, 1))?.status).toBe('superseded');
    expect(await mem.get(p.id, 2)).toBeNull();
    // La copie promue reste activable par un pair (aucune lignée multi-scope).
    expect((await mem.activate(lifted.id, 1, 'agent:c')).status).toBe('active');
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
    const cycle = 'e2e-owner-decision';
    const proof = { kind: 'secret' as const, subject: 'owner-secret' };
    const fileRequest = (requestId: string, summary: string, op: string): Promise<void> =>
      fileOwnerRequest(cycle, requestId, summary, op);

    // 1. agent files the request through the real store (C1/C2 channel)
    const requestId = proposeRequestId('mem-inv-e2e', 1);
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
    const otherRef = proposeRequestId('mem-inv-e2e-other', 1);
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
      const e2ePauseRef = await mem.pauseClearRequestId('common');
      await fileRequest(e2ePauseRef, 'Approve clearing the common activation pause (C4 x C5 E2E).', 'owner-request-3');
      await recordOwnerDecision(db, { request_id: e2ePauseRef, decision: 'approve', proof });
      await mem.clearActivationPause(e2ePauseRef, 'common');
      await mem.activate(p.id, 1, 'agent:b');
    }
    expect((await mem.get(p.id, 1))?.status).toBe('active');
  });

  it('retire of a protected kind requires an owner decision bound to the version', async () => {
    const mem = store();
    const p = await proposeProtectedInvariant(mem, 'mem-prot-retire', 'common');
    await ensureActive(mem, p.id, 1, 'common', 'retire');
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
    const p = await proposeProtectedInvariant(mem, 'mem-prot-sup', 'common');
    await ensureActive(mem, p.id, 1, 'common', 'sup1');
    const v2ref = supersedeRequestId(p.id, 2);
    await approveViaC5(v2ref, 'Approve supersede mem-prot-sup to v2.', 'sup-v2');
    const next = await mem.supersede(p.id, 'agent:c', 'Wording clarified.', ['plan:4'], undefined, undefined, v2ref);
    expect(next.version).toBe(2);
    await ensureActive(mem, p.id, 2, 'common', 'sup2');
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
    const p = await proposeProtectedInvariant(mem, 'mem-prot-scope', 'participant:agent:a');
    await ensureActive(mem, p.id, 1, 'participant:agent:a', 'scope');
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
    // CR-D (GPT6-02) : nouvel id dans le scope cible ; l'approbation reste liée à la lignée source.
    expect(lifted.id).not.toBe(p.id);
    expect(lifted.version).toBe(1);
    expect(lifted.supersedes).toBe(`${p.id}@1`);
    expect(lifted.status).toBe('candidate');
  });

  it('CRD-R2 (revue GPT-6) : une approbation owner de promotion ne sert qu’une fois, même en course', async () => {
    const mem = store();
    const p = await proposeProtectedInvariant(mem, 'mem-prot-race', 'participant:agent:a');
    await ensureActive(mem, p.id, 1, 'participant:agent:a', 'scope-race');
    const ref = await promoteScopeRequestId(p.id, 2, 'project:cc5');
    await approveViaC5(ref, 'Approve lifting mem-prot-race to project:cc5 once.', 'scope-race-ok');
    // Deux promotions préparées avec la même approbation avant le premier commit.
    const first = await mem.preparePromoteScope(p.id, 1, 'agent:b', 'project:cc5', ref);
    const second = await mem.preparePromoteScope(p.id, 1, 'agent:c', 'project:cc5', ref);
    await bindings.COLLAB_DB_C2.batch(first.statements);
    await expect(bindings.COLLAB_DB_C2.batch(second.statements)).rejects.toThrow();
    const copies = await bindings.COLLAB_DB_C2.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE supersedes = ?1')
      .bind(`${p.id}@1`).first<{ n: number }>();
    expect(copies?.n).toBe(1);
    await expect(mem.promoteScope(p.id, 1, 'agent:c', 'project:cc5', ref)).rejects.toMatchObject({ code: 'MEMORY_NOT_ACTIVE' });
  });

  it('promoteConfidence of a protected kind requires an owner decision (candidate and active)', async () => {
    const mem = store();
    const p = await proposeProtectedInvariant(mem, 'mem-prot-conf', 'participant:agent:a', 'observed');
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
    await ensureActive(mem, p.id, 1, 'participant:agent:a', 'conf');
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

  it('T1: a propose approval is never reusable after a protected retire (replay refused)', async () => {
    const mem = store();
    const p = await proposeProtectedInvariant(mem, 'mem-t1-inv', 'common');
    await ensureActive(mem, p.id, 1, 'common', 't1');
    const retireRef = retireRequestId(p.id, 1);
    await approveViaC5(retireRef, 'Approve retiring mem-t1-inv v1.', 't1-ret');
    expect((await mem.retire(p.id, 1, 'default', retireRef)).status).toBe('retired');
    // A different author replays the SAME v1 approval: the retired invariant
    // must not come back without a new owner decision (bound to v2).
    await expect(
      mem.propose({
        id: 'mem-t1-inv',
        scope: 'common',
        kind: 'invariant',
        text: 'Resurrected invariant without a new decision.',
        evidence_refs: ['plan:4'],
        confidence: 'verified',
        author_pid: 'agent:c',
        owner_decision_ref: proposeRequestId('mem-t1-inv', 1),
      }),
    ).rejects.toThrow(/does not target subject/);
  });

  it('T2: one propose approval never authorizes a second proposal of the same id', async () => {
    const mem = store();
    const ref = proposeRequestId('mem-t2-inv', 1);
    await approveViaC5(ref, 'Approve invariant mem-t2-inv v1 only.', 't2-v1');
    const first = await mem.propose({
      id: 'mem-t2-inv',
      scope: 'common',
      kind: 'invariant',
      text: 'First text.',
      evidence_refs: ['plan:4'],
      confidence: 'verified',
      author_pid: 'agent:a',
      owner_decision_ref: ref,
    });
    expect(first.version).toBe(1);
    await expect(
      mem.propose({
        id: 'mem-t2-inv',
        scope: 'common',
        kind: 'invariant',
        text: 'Second text with the same approval.',
        evidence_refs: ['plan:4'],
        confidence: 'verified',
        author_pid: 'agent:a',
        owner_decision_ref: ref,
      }),
    ).rejects.toThrow(/does not target subject/);
  });

  it('T3: a pause decision for another scope never clears this scope (no global clear)', async () => {
    const mem = store();
    const p = await proposeProtectedInvariant(mem, 'mem-t3-inv', 'project:pause-t3');
    try {
      await mem.activate(p.id, 1, 'agent:b');
    } catch {
      /* INVARIANT_TOUCHED pauses the scope */
    }
    expect(await mem.isActivationPaused('project:pause-t3')).toBe(true);
    const wrongRef = await pauseRequestId('', 1);
    // CR-F02 : une approbation qui ne désigne aucune pause courante est refusée dès
    // la décision (rien n'est écrit), et ne peut donc pas lever cette pause.
    await expect(approveViaC5(wrongRef, 'Approve clearing an unrelated pause subject.', 't3-wrong')).rejects.toMatchObject({
      code: 'MEMORY_PAUSE_NOT_CURRENT',
    });
    const decided = await bindings.COLLAB_DB_C2.prepare('SELECT COUNT(*) AS n FROM owner_decisions WHERE request_id = ?1')
      .bind(wrongRef).first<{ n: number }>();
    expect(decided?.n).toBe(0);
    await expect(mem.clearActivationPause(wrongRef, 'project:pause-t3')).rejects.toThrow(
      /does not target subject/,
    );
    expect(await mem.isActivationPaused('project:pause-t3')).toBe(true);
  });

  it('T4: a used pause approval cannot be replayed for the next pause occurrence', async () => {
    const mem = store();
    const scope = 'project:pause-t4';
    const first = await proposeProtectedInvariant(mem, 'mem-t4-a', scope);
    try {
      await mem.activate(first.id, 1, 'agent:b');
    } catch {
      /* protected activation pauses the scope */
    }
    const second = await proposeProtectedInvariant(mem, 'mem-t4-b', scope);
    await expect(mem.activate(second.id, 1, 'agent:b')).rejects.toThrow(/Activations paused for scope/);
    const firstRef = await mem.pauseClearRequestId(scope);
    // CR-F02 : la pause INVARIANT_TOUCHED a déposé sa demande owner exacte (cause invariant).
    const filed = await bindings.COLLAB_DB_C2.prepare([
      "SELECT json_extract(payload_json, '$.reason') AS reason FROM events WHERE cycle_id = 'memory-alarms'",
      "AND participant_id = 'system' AND json_extract(payload_json, '$.request_id') = ?1",
    ].join(' ')).bind(firstRef).all<{ reason: string }>();
    expect(filed.results).toEqual([{ reason: 'invariant' }]);
    await approveViaC5(firstRef, 'Approve clearing the pause occurrence of mem-t4.', 't4-one');
    await mem.clearActivationPause(firstRef, scope);
    await mem.activate(second.id, 1, 'agent:b');
    expect((await mem.get(second.id, 1))?.status).toBe('active');
    // The protected activation re-paused the scope (new occurrence): the
    // already-used occurrence-1 approval must not clear it again.
    expect(await mem.isActivationPaused(scope)).toBe(true);
    await expect(mem.clearActivationPause(firstRef, scope)).rejects.toThrow(/does not target subject/);
    expect(await mem.isActivationPaused(scope)).toBe(true);
  });

  it('T5: a retired protected id cannot be resurrected under another kind without a decision', async () => {
    const mem = store();
    const p = await proposeProtectedInvariant(mem, 'mem-t5-inv', 'common');
    await ensureActive(mem, p.id, 1, 'common', 't5');
    const retireRef = retireRequestId(p.id, 1);
    await approveViaC5(retireRef, 'Approve retiring mem-t5-inv v1.', 't5-ret');
    await mem.retire(p.id, 1, 'default', retireRef);
    await expect(
      mem.propose({
        id: 'mem-t5-inv',
        scope: 'common',
        kind: 'fact',
        text: 'Resurrected as a plain fact without a decision.',
        evidence_refs: ['plan:4'],
        author_pid: 'agent:a',
      }),
    ).rejects.toThrow(/PROTECTED_KIND_OWNER_REQUIRED|required/);
    const ref = proposeRequestId('mem-t5-inv', 2);
    await approveViaC5(ref, 'Approve mem-t5-inv v2 (explicit resurrection).', 't5-ok');
    const back = await mem.propose({
      id: 'mem-t5-inv',
      scope: 'common',
      kind: 'fact',
      text: 'Resurrected as a plain fact with an explicit decision.',
      evidence_refs: ['plan:4'],
      author_pid: 'agent:a',
      owner_decision_ref: ref,
    });
    expect(back.version).toBe(2);
    expect(back.kind).toBe('fact');
  });

  // -- A03 (post-audit F3): atomic activation --------------------------------

  /** Seed the growth baseline so the growth alarm stays out of a race test's way. */
  async function seedBaseline(scope: string, writes: number): Promise<void> {
    await bindings.COLLAB_DB_C2.prepare(
      `INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, ?2)`,
    )
      .bind('mem:base:' + scope, writes)
      .run();
  }

  async function capWrites(day: string): Promise<number> {
    const row = await bindings.COLLAB_DB_C2
      .prepare(`SELECT writes FROM quota_counters WHERE day = ?1`)
      .bind(day)
      .first<{ writes: number }>();
    return row?.writes ?? 0;
  }

  /** Race two activations: exactly one must win, exactly one must fail typed. */
  async function raceTwo(
    first: Promise<StoredMemory>,
    second: Promise<StoredMemory>,
  ): Promise<{ winner: StoredMemory; loserError: MemoryStoreError }> {
    const outcomes = await Promise.allSettled([first, second]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    if (fulfilled.length !== 1 || rejected.length !== 1) {
      throw new Error(
        'A03 race must yield exactly one success and one failure, got ' +
          JSON.stringify(outcomes.map((o) => o.status)),
      );
    }
    const loserError = (rejected[0] as PromiseRejectedResult).reason as MemoryStoreError;
    expect(loserError).toBeInstanceOf(MemoryStoreError);
    return { winner: (fulfilled[0] as PromiseFulfilledResult<StoredMemory>).value, loserError };
  }

  /** The winner is active, the loser's candidate is untouched. */
  async function expectWinnerActiveLoserCandidate(
    mem: MemoryStore,
    a: StoredMemory,
    b: StoredMemory,
    winner: StoredMemory,
  ): Promise<void> {
    expect((await mem.get(winner.id, 1))?.status).toBe('active');
    const loser = winner.id === a.id ? b : a;
    expect((await mem.get(loser.id, 1))?.status).toBe('candidate');
  }

  it('A03: two concurrent reviewers on one candidate -> one activation, one reviewer, one counter bump', async () => {
    const mem = store();
    const p = await mem.propose({
      scope: 'project:a03-two-reviewers',
      kind: 'fact',
      text: 'Two reviewers race for this candidate.',
      evidence_refs: ['plan:4'],
      author_pid: 'agent:a',
    });
    const { winner, loserError } = await raceTwo(
      mem.activate(p.id, 1, 'agent:b'),
      mem.activate(p.id, 1, 'agent:c'),
    );
    expect(['ACTIVATION_RACE', 'MEMORY_NOT_CANDIDATE']).toContain(loserError.code);
    const after = (await mem.get(p.id, 1))!;
    expect(after.status).toBe('active');
    // Exactly one reviewer is registered — the winner's, never overwritten.
    expect(after.reviewer_pid).toBe(winner.reviewer_pid);
    expect(['agent:b', 'agent:c']).toContain(after.reviewer_pid);
    // Exactly one counter increment for the single applied activation.
    expect(await capWrites('mem:act:default:project:a03-two-reviewers')).toBe(1);
  });

  it('A03: two candidates for the last cycle-cap slot -> exactly one activation, no overflow', async () => {
    const mem = store();
    const scope = 'task:a03-last-slot';
    const cycle = 'cy-a03';
    await seedBaseline(scope, 10); // keep the growth alarm out of this race
    for (let i = 0; i < 9; i++) {
      const p = await mem.propose({
        scope,
        kind: 'observation',
        text: `cap filler ${i}`,
        evidence_refs: [`e-cap-${i}`],
        author_pid: 'agent:a',
      });
      await mem.activate(p.id, 1, 'agent:b', cycle);
    }
    const a = await mem.propose({
      scope,
      kind: 'observation',
      text: 'candidate A for the last slot',
      evidence_refs: ['e-a'],
      author_pid: 'agent:a',
    });
    const b = await mem.propose({
      scope,
      kind: 'observation',
      text: 'candidate B for the last slot',
      evidence_refs: ['e-b'],
      author_pid: 'agent:a',
    });
    const { winner, loserError } = await raceTwo(
      mem.activate(a.id, 1, 'agent:b', cycle),
      mem.activate(b.id, 1, 'agent:c', cycle),
    );
    expect(loserError.code).toBe('ACTIVATION_CAP');
    // The loser's activation mutated nothing: candidate untouched, and its
    // cap reservation rolled back with the failed transaction.
    await expectWinnerActiveLoserCandidate(mem, a, b, winner);
    expect(await capWrites(`mem:act:${cycle}:${scope}`)).toBe(10);
  });

  it('A03: two candidates for the last budget tokens -> exactly one activation, budget never exceeded', async () => {
    const mem = store();
    const scope = 'participant:agent:aa03';
    const cycle = 'cy-a03-budget';
    await seedBaseline(scope, 10); // keep the growth alarm out of this race
    for (let i = 0; i < 2; i++) {
      const p = await mem.propose({
        scope,
        kind: 'lesson',
        text: ('budget filler ' + i + ' ').repeat(60).slice(0, 600),
        evidence_refs: [`e-budget-${i}`],
        author_pid: 'agent:aa03',
      });
      await mem.activate(p.id, 1, 'agent:bb03', cycle);
    }
    const a = await mem.propose({
      scope,
      kind: 'lesson',
      text: 'a'.repeat(600),
      evidence_refs: ['e-budget-a'],
      author_pid: 'agent:aa03',
    });
    const b = await mem.propose({
      scope,
      kind: 'lesson',
      text: 'b'.repeat(600),
      evidence_refs: ['e-budget-b'],
      author_pid: 'agent:aa03',
    });
    const { winner, loserError } = await raceTwo(
      mem.activate(a.id, 1, 'agent:bb03', cycle),
      mem.activate(b.id, 1, 'agent:cc03', cycle),
    );
    expect(loserError.code).toBe('MEMORY_BUDGET_EXCEEDED');
    await expectWinnerActiveLoserCandidate(mem, a, b, winner);
    // 300 filler tokens + 150 winner tokens = 450 <= 500 budget: the guard
    // refused the second 150-token activation before the budget could slip.
    const { results: activeRows } = await bindings.COLLAB_DB_C2.prepare(
      `SELECT text FROM memory_entries WHERE status = 'active' AND scope = ?1`,
    )
      .bind(scope)
      .all<{ text: string }>();
    const used = (activeRows ?? []).reduce((sum, r) => sum + Math.ceil(r.text.length / 4), 0);
    expect(used).toBe(450);
    // The loser's cap reservation rolled back with its failed transaction.
    expect(await capWrites(`mem:act:${cycle}:${scope}`)).toBe(3);
  });

  it('A03: non-BMP budget race -> the guard sums the persisted exact token cost', async () => {
    const mem = store();
    const scope = 'participant:agent:uni03';
    const cycle = 'cy-a03-unicode';
    await seedBaseline(scope, 100); // keep the growth alarm out of this race
    // Emoji fillers: one rocket is 2 UTF-16 units in JS but a single code
    // point for SQLite length(), so the old in-batch guard under-counted
    // non-BMP text. Used after activation: 150 + 150 + 120 = 420 tokens
    // (budget 500 for a participant scope).
    for (const [i, units] of [600, 600, 480].entries()) {
      const p = await mem.propose({
        scope,
        kind: 'lesson',
        text: '🚀'.repeat(units / 2),
        evidence_refs: [`e-uni-${i}`],
        author_pid: 'agent:uni03',
      });
      await mem.activate(p.id, 1, 'agent:rev03', cycle);
    }
    // Two 60-token candidates (120 emoji = 240 UTF-16 units): each passes the
    // JS pre-check alone (420 + 60 <= 500), together they exceed the budget
    // (540 > 500). The transactional guard must refuse the second one using
    // the persisted exact costs, not the under-counting SQL approximation.
    const a = await mem.propose({
      scope,
      kind: 'lesson',
      text: '🚀'.repeat(120),
      evidence_refs: ['e-uni-a'],
      author_pid: 'agent:uni03',
    });
    const b = await mem.propose({
      scope,
      kind: 'lesson',
      text: '🚀'.repeat(120),
      evidence_refs: ['e-uni-b'],
      author_pid: 'agent:uni03',
    });
    const { winner, loserError } = await raceTwo(
      mem.activate(a.id, 1, 'agent:rev03', cycle),
      mem.activate(b.id, 1, 'agent:rev04', cycle),
    );
    expect(loserError.code).toBe('MEMORY_BUDGET_EXCEEDED');
    await expectWinnerActiveLoserCandidate(mem, a, b, winner);
    const { results: activeCosts } = await bindings.COLLAB_DB_C2.prepare(
      `SELECT COALESCE(token_cost, -1) AS token_cost FROM memory_entries WHERE status = 'active' AND scope = ?1`,
    )
      .bind(scope)
      .all<{ token_cost: number }>();
    // Exact persisted costs (UTF-16 based), never the code-point approximation.
    expect((activeCosts ?? []).map((r) => r.token_cost).sort((x, y) => x - y)).toEqual([60, 120, 150, 150]);
    // 420 + 60 = 480 <= 500: the scope budget holds at the JS contract level.
    expect((activeCosts ?? []).reduce((sum, r) => sum + r.token_cost, 0)).toBe(480);
    expect(await capWrites(`mem:act:${cycle}:${scope}`)).toBe(4);
  });

  it('A03/I4: two candidate versions of one id activated in parallel -> exactly one active version', async () => {
    const mem = store();
    const id = 'mem-i4-race';
    const scope = 'project:a03-i4';
    await seedBaseline(scope, 100); // keep the growth alarm out of this race
    await mem.propose({ id, scope, kind: 'fact', text: 'v1 original.', evidence_refs: ['plan:4'], author_pid: 'agent:a' });
    await mem.activate(id, 1, 'agent:b');
    await mem.supersede(id, 'agent:a', 'v2 candidate replacing v1.', ['plan:4']);
    const v3 = await mem.propose({ id, scope, kind: 'fact', text: 'v3 parallel candidate.', evidence_refs: ['plan:4'], author_pid: 'agent:a' });
    expect(v3.version).toBe(3);
    // Both versions are candidates: parallel activation must converge to the
    // sequential outcome — exactly one active version of the id (I4).
    const [a2, a3] = await Promise.all([mem.activate(id, 2, 'agent:c'), mem.activate(id, 3, 'agent:d')]);
    // Both activations applied; the loser may already have been superseded
    // by the winner between its own commit and its durable re-read (I4
    // convergence), so each returned row is active or superseded, never a
    // candidate anymore.
    expect(['active', 'superseded']).toContain(a2.status);
    expect(['active', 'superseded']).toContain(a3.status);
    const s2 = (await mem.get(id, 2))?.status;
    const s3 = (await mem.get(id, 3))?.status;
    expect([s2, s3].filter((st) => st === 'active')).toHaveLength(1);
    expect([s2, s3]).toContain('superseded');
    const winnerVersion = s2 === 'active' ? 2 : 3;
    const activeRow = (await mem.get(id, winnerVersion))!;
    expect(activeRow.reviewer_pid).toBe(winnerVersion === 2 ? 'agent:c' : 'agent:d');
    expect((await mem.get(id, 1))?.status).toBe('superseded');
    // Each applied activation bumps the cap counter exactly once.
    expect(await capWrites('mem:act:default:' + scope)).toBe(3);
  });

  /** Insert a row as if it predated migration 0003: token_cost stays NULL. */
  async function insertPreMigrationRow(id: string, scope: string, text: string): Promise<void> {
    await bindings.COLLAB_DB_C2
      .prepare(
        `INSERT INTO memory_entries
           (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid, supersedes, uses)
         VALUES (?1, 1, ?2, 'lesson', ?3, '[]', 'hypothesis', 'candidate', 'agent:pre', '', NULL, 0)`,
      )
      .bind(id, scope, text)
      .run();
  }

  /** Costs of two rows, NULL rendered as -1, sorted ascending. */
  const readCosts = async (idA: string, idB: string): Promise<number[]> => {
    const { results } = await bindings.COLLAB_DB_C2
      .prepare(
        `SELECT COALESCE(token_cost, -1) AS token_cost FROM memory_entries WHERE id IN (?1, ?2)`,
      )
      .bind(idA, idB)
      .all<{ token_cost: number }>();
    return (results ?? []).map((r) => r.token_cost).sort((x, y) => x - y);
  };

  it('A03: pre-migration rows are backfilled with the exact canonical cost', async () => {
    // Write two rows as if they predated migration 0003: token_cost is
    // NULL, not the SQLite code-point approximation.
    const emoji = '🚀'.repeat(120); // 120 code points but 240 UTF-16 units
    const ascii = 'a'.repeat(200);
    await insertPreMigrationRow('mem-backfill-emoji', 'project:a03-backfill', emoji);
    await insertPreMigrationRow('mem-backfill-ascii', 'project:a03-backfill', ascii);
    // Before the backfill: both costs are NULL (COALESCE -> -1).
    expect(await readCosts('mem-backfill-emoji', 'mem-backfill-ascii')).toEqual([-1, -1]);
    // Re-running the schema bootstrap backfills NULL costs from JS with the
    // exact canonical metric, UTF-16 units included: the emoji row gets 60
    // tokens, never the code-point approximation (120 + 3) / 4 = 30.
    await ensureSchema(bindings.COLLAB_DB_C2, true);
    expect(await readCosts('mem-backfill-emoji', 'mem-backfill-ascii')).toEqual([50, 60]);
    expect(estimateTokens(emoji)).toBe(60);
    // Idempotent: a second bootstrap changes nothing.
    await ensureSchema(bindings.COLLAB_DB_C2, true);
    expect(await readCosts('mem-backfill-emoji', 'mem-backfill-ascii')).toEqual([50, 60]);
  });

  it('A03: crash between the 0003 ALTER and its backfill -> a plain cold bootstrap repairs the NULL costs', async () => {
    // Rows as a crashed migration 0003 left them: the ALTER was applied (the
    // column exists) but the process died before the backfill, so pre-0003
    // rows keep token_cost NULL.
    await ensureSchema(bindings.COLLAB_DB_C2, true);
    const emoji = '🚀'.repeat(90); // 90 code points but 180 UTF-16 units -> 45 tokens
    const ascii = 'z'.repeat(100); // 25 tokens
    await insertPreMigrationRow('mem-crash-emoji', 'project:a03-crash', emoji);
    await insertPreMigrationRow('mem-crash-ascii', 'project:a03-crash', ascii);
    expect(await readCosts('mem-crash-emoji', 'mem-crash-ascii')).toEqual([-1, -1]);
    // A new isolate runs a plain ensureSchema, without `force`: a fresh
    // binding object is not in the process-local ENSURED cache, exactly like
    // a restarted Worker seeing the same durable D1. The NULL costs must be
    // repaired, or the crash would permanently defeat the exact-metric
    // budget guard (review Sol, F3).
    const coldStart = (): D1Database =>
      ({
        prepare: (sql: string) => bindings.COLLAB_DB_C2.prepare(sql),
        batch: (statements: D1PreparedStatement[]) => bindings.COLLAB_DB_C2.batch(statements),
      }) as unknown as D1Database;
    await ensureSchema(coldStart());
    expect(await readCosts('mem-crash-emoji', 'mem-crash-ascii')).toEqual([25, 45]);
    expect(estimateTokens(emoji)).toBe(45);
    // Idempotent: another cold bootstrap changes nothing.
    await ensureSchema(coldStart());
    expect(await readCosts('mem-crash-emoji', 'mem-crash-ascii')).toEqual([25, 45]);
  });

  // -- CR-F03 (github-mcp#95, contre-revue Codex #79/6096598889) ----------------
  // Revue Claude PR #100/6098002656 : la nouveauté se juge sur la lignée ENTIÈRE
  // de l’id — le chemin candidate de promoteConfidence est gardé aussi.
  // Toute hausse de confiance d'une consolidation exige une preuve de registre
  // NOUVELLE, produite par un pair distinct de l'auteur. Chaque refus est
  // pré-batch : aucune version 2 n'est créée, la version active reste intacte.

  /** Un fait observed proposé par agent:a, SANS activation : la v1 reste candidate. */
  async function proposedCandidate(mem: MemoryStore, scope: string, refs: string[]): Promise<string> {
    const p = await mem.propose({
      scope,
      kind: 'fact',
      text: `Observed fact for ${scope}.`,
      evidence_refs: refs,
      confidence: 'observed',
      author_pid: 'agent:a',
    });
    return p.id;
  }

  /** Un fait observed proposé par agent:a puis activé par le pair distinct agent:b. */
  async function observedFact(mem: MemoryStore, scope: string, refs: string[]): Promise<string> {
    const id = await proposedCandidate(mem, scope, refs);
    await mem.activate(id, 1, 'agent:b');
    return id;
  }

  /** Hausse verified acceptée avec une preuve NOUVELLE d'un pair, puis activation. */
  async function raiseVerified(mem: MemoryStore, id: string, refs: string[], evidence: string): Promise<number> {
    await seedLedger('agent:b', evidence);
    const up = await mem.supersede(id, 'agent:a', `Verified consolidation of ${id}.`, refs, undefined, 'verified', undefined, evidence);
    await mem.activate(id, up.version, 'agent:b');
    return up.version;
  }

  /** Une hausse recyclant une preuve déjà utilisée par la lignée : refus pré-batch. */
  const expectRaiseRefused = (mem: MemoryStore, id: string, refs: string[], presented: string, target: MemoryConfidence = 'verified') =>
    expect(
      mem.supersede(id, 'agent:a', 'Raise recycling an already-used evidence.', refs, undefined, target, undefined, presented),
    ).rejects.toMatchObject({ code: 'PEER_EVIDENCE_REQUIRED' });

  it('CR-F03: a consolidate raising confidence requires a NEW peer ledger evidence (no recycling, no self-validation)', async () => {
    const mem = store();
    const id = await observedFact(mem, 'project:crf3-raise', ['ev:crf3-v1']);
    // Raise without any peer evidence -> PEER_EVIDENCE_REQUIRED.
    await expect(
      mem.supersede(id, 'agent:a', 'Stronger claim.', ['ev:crf3-v1'], undefined, 'verified'),
    ).rejects.toMatchObject({ code: 'PEER_EVIDENCE_REQUIRED' });
    // A self reference is not a peer evidence -> PEER_EVIDENCE_REQUIRED.
    await expect(
      mem.supersede(id, 'agent:a', 'Stronger claim.', ['ev:crf3-v1'], undefined, 'verified', undefined, 'self:agent:a'),
    ).rejects.toMatchObject({ code: 'PEER_EVIDENCE_REQUIRED' });
    // Unknown ledger row -> PEER_EVIDENCE_NOT_FOUND.
    await expect(
      mem.supersede(id, 'agent:a', 'Stronger claim.', ['ev:crf3-v1'], undefined, 'verified', undefined, 'ev:crf3-unknown'),
    ).rejects.toMatchObject({ code: 'PEER_EVIDENCE_NOT_FOUND' });
    // Ledger row produced by the author himself -> PEER_EVIDENCE_SELF.
    await seedLedger('agent:a', 'ev:crf3-self');
    await expect(
      mem.supersede(id, 'agent:a', 'Stronger claim.', ['ev:crf3-v1'], undefined, 'verified', undefined, 'ev:crf3-self'),
    ).rejects.toMatchObject({ code: 'PEER_EVIDENCE_SELF' });
    // Every refusal is pre-batch: no v2 row exists, the active version is untouched.
    expect(await mem.get(id, 2)).toBeNull();
    expect((await mem.get(id, 1))?.status).toBe('active');
    // A NEW peer evidence validates the raise: v2 candidate, ledger ref persisted.
    await seedLedger('agent:b', 'ev:crf3-new-1');
    const v2 = await mem.supersede(
      id, 'agent:a', 'Stronger claim.', ['ev:crf3-v1'], undefined, 'verified', undefined, 'ev:crf3-new-1',
    );
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('candidate');
    expect(v2.confidence).toBe('verified');
    expect(JSON.parse(v2.evidence_refs || '[]')).toContain('ev:crf3-new-1');
    expect((await mem.get(id, 1))?.status).toBe('superseded');
    expect((await mem.activate(id, 2, 'agent:b')).status).toBe('active');
    // Recycling the SAME evidence for another raise -> PEER_EVIDENCE_REQUIRED.
    await expectRaiseRefused(mem, id, ['ev:crf3-v1'], 'ev:crf3-new-1', 'owner_validated');
    // A different NEW peer evidence passes.
    await seedLedger('agent:b', 'ev:crf3-new-2');
    const v3 = await mem.supersede(
      id, 'agent:a', 'Even stronger.', ['ev:crf3-v1'], undefined, 'owner_validated', undefined, 'ev:crf3-new-2',
    );
    expect(v3.version).toBe(3);
    expect(v3.confidence).toBe('owner_validated');
    expect(JSON.parse(v3.evidence_refs || '[]')).toContain('ev:crf3-new-2');
  });

  it('CR-F03: unchanged-confidence consolidation and promoteConfidence stay intact', async () => {
    const mem = store();
    const id = await observedFact(mem, 'project:crf3-unchanged', ['ev:crf3-same']);
    // No confidence -> no raise -> no peer evidence needed (ordinary consolidate).
    const v2 = await mem.supersede(id, 'agent:a', 'Reworded, same confidence.', ['ev:crf3-same']);
    expect(v2.version).toBe(2);
    expect(v2.confidence).toBe('observed');
    await mem.activate(id, 2, 'agent:c');
    // promoteConfidence still raises through its own validated ledger evidence:
    // the internal supersede re-validates the NEW ref (not yet in the active refs).
    await seedLedger('agent:b', 'ev:crf3-promo-1');
    const up = await mem.promoteConfidence(id, 2, 'agent:b', 'ev:crf3-promo-1', 'verified');
    expect(up.version).toBe(3);
    expect(up.confidence).toBe('verified');
    expect(JSON.parse(up.evidence_refs || '[]')).toContain('ev:crf3-promo-1');
  });

  it('CR-F03 (Claude review #100, P1): anti-recycling covers the WHOLE lineage — a ref dropped by an intermediate consolidation is not whitelisted', async () => {
    const mem = store();
    const scope = 'project:crf3-lineage';
    await seedBaseline(scope, 100);
    const id = await observedFact(mem, scope, ['ev:crf3-l0']);
    // v2 : the raise is accepted with a NEW peer evidence L1.
    await raiseVerified(mem, id, ['ev:crf3-l0'], 'ev:crf3-l1');
    expect(JSON.parse((await mem.get(id, 2))!.evidence_refs || '[]')).toContain('ev:crf3-l1');
    // v3 : an unchanged-confidence consolidation may DROP L1 from evidence_refs.
    const v3 = await mem.supersede(id, 'agent:a', 'v3 reworded, L1 dropped.', ['ev:crf3-l0']);
    expect(v3.confidence).toBe('verified');
    expect(JSON.parse(v3.evidence_refs || '[]')).not.toContain('ev:crf3-l1');
    await mem.activate(id, v3.version, 'agent:b');
    // Re-raising by recycling L1 — which now only backs the SUPERSEDED v2 —
    // must stay refused: the anti-recycling check covers every version of the id.
    await expectRaiseRefused(mem, id, ['ev:crf3-l0'], 'ev:crf3-l1', 'owner_validated');
    // The refusal is pre-batch: no v4 exists, v3 stays active.
    expect(await mem.get(id, 4)).toBeNull();
    expect((await mem.get(id, 3))?.status).toBe('active');
  });
  it('CR-F03 (Claude review #100, P1b): a downgrade followed by a re-raise cannot recycle the evidence of the superseded version', async () => {
    const mem = store();
    const scope = 'project:crf3-downup';
    await seedBaseline(scope, 100);
    const id = await observedFact(mem, scope, ['ev:crf3-d0']);
    await raiseVerified(mem, id, ['ev:crf3-d0'], 'ev:crf3-d1');
    // A consolidation may LOWER the confidence without any peer evidence…
    const v3 = await mem.supersede(id, 'agent:a', 'v3 back to observed.', ['ev:crf3-d0'], undefined, 'observed');
    expect(v3.confidence).toBe('observed');
    await mem.activate(id, v3.version, 'agent:b');
    // …but re-raising to the former level cannot recycle D1, which already
    // backs the superseded v2: the whole lineage of the id is checked.
    await expectRaiseRefused(mem, id, ['ev:crf3-d0'], 'ev:crf3-d1');
    expect(await mem.get(id, 4)).toBeNull();
  });
  it('CR-F03 (Claude review #100, P2): promoteConfidence on a CANDIDATE cannot recycle an evidence already in the lineage', async () => {
    const mem = store();
    // v1 reste CANDIDATE (proposedCandidate, sans activation) : le chemin
    // UPDATE direct de promoteConfidence s’applique alors sans supersede.
    const id = await proposedCandidate(mem, 'project:crf3-candidate', ['ev:crf3-c0']);
    // First promotion of the candidate (direct UPDATE path): NEW evidence,
    // the resolved ref is appended exactly once.
    await seedLedger('agent:b', 'ev:crf3-c1');
    const up = await mem.promoteConfidence(id, 1, 'agent:b', 'ev:crf3-c1', 'verified');
    expect(up.status).toBe('candidate');
    expect(up.confidence).toBe('verified');
    expect(JSON.parse(up.evidence_refs || '[]')).toEqual(['ev:crf3-c0', 'ev:crf3-c1']);
    // Second promotion recycling the SAME evidence: refused, nothing written
    // (no duplicated ref in the candidate row).
    await expect(
      mem.promoteConfidence(id, 1, 'agent:b', 'ev:crf3-c1', 'owner_validated'),
    ).rejects.toMatchObject({ code: 'PEER_EVIDENCE_REQUIRED' });
    const row = (await mem.get(id, 1))!;
    expect(row.confidence).toBe('verified');
    expect(JSON.parse(row.evidence_refs || '[]')).toEqual(['ev:crf3-c0', 'ev:crf3-c1']);
  });

  it('CR-F03 (Claude review #100): the lineage check matches BOTH forms of an evidence — evidence_ref and ledger:<seq>', async () => {
    const mem = store();
    const scope = 'project:crf3-alias';
    await seedBaseline(scope, 100);
    const seqOf = async (ref: string): Promise<number> =>
      (await bindings.COLLAB_DB_C2.prepare('SELECT seq FROM evidence_ledger WHERE evidence_ref = ?1').bind(ref).first<{ seq: number }>())!.seq;
    // v1 cites one form of a ledger row; the raise presents the OTHER form of
    // the SAME row — both directions must be refused as recycling.
    for (const [ref, citeAlias] of [['ev:crf3-alias-a', true], ['ev:crf3-alias-b', false]] as Array<[string, boolean]>) {
      await seedLedger('agent:b', ref);
      const alias = `ledger:${await seqOf(ref)}`;
      const refs = [citeAlias ? alias : ref];
      const id = await observedFact(mem, scope, refs);
      await expectRaiseRefused(mem, id, refs, citeAlias ? ref : alias);
      // The refusal is pre-batch: no v2, the observed v1 stays active.
      expect(await mem.get(id, 2)).toBeNull();
      expect((await mem.get(id, 1))?.status).toBe('active');
    }
  });
});
