import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MemoryStore, proposeRequestId } from '../../../src/collab-store/memory/memory-store';
import { CollabStore, type AppendOutcome } from '../../../src/collab-store/store/collab-store';
import type { StoreEventType } from '../../../src/collab-store/contracts';
import type { MemoryConfidence, MemoryKind } from '../../../src/collab-store/contracts/memory';
import { ensureSchema } from '../../../src/collab-store/store/schema';

/**
 * CC-3 Lot X2/X5 (github-mcp#107).
 * X2 : auto-revue bornée du propriétaire d’un scope participant.
 * X5 : indépendance P1 des cycles de travail (garde read-only + transactionnelle).
 */
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const NOW = () => new Date('2026-11-01T10:00:00.000Z');

let n = 0;
const uniq = (label: string) => 'x2x5-' + label + '-' + ++n;

const store = () => new MemoryStore(db);
const collab = () => new CollabStore(db, { now: NOW, dailyWriteLimit: 100_000 });

async function seedOwnerDecision(requestId: string): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO owner_decisions (request_id, decision, access_subject, at) VALUES (?1, 'approve', 'kevin', 1)",
  )
    .bind(requestId)
    .run();
}

async function seedP2Cycle(cycle: string, project = ''): Promise<void> {
  await db.prepare("INSERT INTO cycles (cycle_id, project, phase, revision) VALUES (?1, ?2, 'P2', 0)")
    .bind(cycle, project)
    .run();
}

async function seedP1WorkCycle(cycle: string, project: string, task?: string): Promise<void> {
  await db.prepare("INSERT INTO cycles (cycle_id, project, phase, revision) VALUES (?1, ?2, 'P1', 1)")
    .bind(cycle, project)
    .run();
  if (task) {
    await db.prepare(
      "INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid) VALUES (?1, ?2, 'agent:x2x5-o', 'agent:x2x5-r', 'agent:x2x5-t')",
    )
      .bind(task, cycle)
      .run();
  }
}

interface AppendArgs {
  cycle: string;
  type: StoreEventType;
  participant: string;
  op: string;
  payload: Record<string, unknown>;
}

async function append(args: AppendArgs): Promise<AppendOutcome> {
  const cs = collab();
  return cs.appendEvent({
    cycle_id: args.cycle,
    type: args.type,
    participant_id: args.participant,
    expected_rev: await cs.currentRevision(args.cycle),
    payload_json: JSON.stringify(args.payload),
    op_id: 'x2x5:' + args.cycle + ':' + args.op + ':1',
  });
}

async function refuse(args: AppendArgs): Promise<string> {
  try {
    const outcome = await append(args);
    throw new Error('refus attendu, événement ' + outcome.status);
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
}

async function journalState(cycle: string): Promise<{ revision: number; events: number }> {
  await ensureSchema(db);
  const c = await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>();
  const e = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
  return { revision: c?.revision ?? 0, events: e?.n ?? 0 };
}

async function memoryRowCount(id: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE id = ?1').bind(id).first<{ n: number }>())?.n ?? 0;
}

describe('CC-3 X2 — auto-revue bornée du propriétaire d’un scope participant (github-mcp#107)', () => {
  const kinds = ['observation', 'open_question', 'lesson', 'procedure'] as const;
  const confidences = ['hypothesis', 'observed'] as const;
  const combos: Array<{ kind: MemoryKind; confidence: MemoryConfidence }> = [];
  for (const kind of kinds) {
    for (const confidence of confidences) {
      combos.push({ kind, confidence });
    }
  }

  for (const [index, combo] of combos.entries()) {
    it('X2 : ' + combo.kind + '/' + combo.confidence + ' — l’auteur active sa proposition, reviewer_pid = author_pid', async () => {
      const author = 'agent:x2a-' + index;
      const mem = store();
      const proposed = await mem.propose({
        id: uniq('self'),
        scope: 'participant:' + author,
        kind: combo.kind,
        confidence: combo.confidence,
        text: 'Auto-revue bornée ' + combo.kind + '/' + combo.confidence + '.',
        evidence_refs: ['ev:x2-self'],
        author_pid: author,
      });
      const activated = await mem.activate(proposed.id, 1, author);
      expect(activated.status).toBe('active');
      expect(activated.reviewer_pid).toBe(author);
      expect(activated.scope).toBe('participant:' + author);
    });
  }

  it('X2 : hors bornes — ni fact, ni verified+, ni protected kind : auto-revue refusée, rien d’écrit', async () => {
    const author = 'agent:x2a-bounds';
    const mem = store();
    const factId = uniq('bounds-fact');
    await mem.propose({ id: factId, scope: 'participant:' + author, kind: 'fact',
      text: 'Fait hors bornes.', evidence_refs: ['ev:x2-bounds'], confidence: 'observed', author_pid: author });
    await expect(mem.activate(factId, 1, author)).rejects.toMatchObject({ code: 'MEMORY_SELF_ACTIVATION' });
    const verifiedId = uniq('bounds-verified');
    await mem.propose({ id: verifiedId, scope: 'participant:' + author, kind: 'observation',
      text: 'Observation vérifiée hors bornes.', evidence_refs: ['ev:x2-bounds'], confidence: 'verified', author_pid: author });
    await expect(mem.activate(verifiedId, 1, author)).rejects.toMatchObject({ code: 'MEMORY_SELF_ACTIVATION' });
    const procedureId = uniq('bounds-procedure');
    await mem.propose({ id: procedureId, scope: 'participant:' + author, kind: 'procedure',
      text: 'Procédure owner-validée hors bornes.', evidence_refs: ['ev:x2-bounds'], confidence: 'owner_validated', author_pid: author });
    await expect(mem.activate(procedureId, 1, author)).rejects.toMatchObject({ code: 'MEMORY_SELF_ACTIVATION' });
    const invariantId = 'x2x5-inv-bounds';
    const invariantRef = proposeRequestId(invariantId, 1);
    await seedOwnerDecision(invariantRef);
    await mem.propose({ id: invariantId, scope: 'participant:' + author, kind: 'invariant',
      text: 'Invariant hors bornes.', evidence_refs: ['ev:x2-bounds'], confidence: 'observed',
      author_pid: author, owner_decision_ref: invariantRef });
    await expect(mem.activate(invariantId, 1, author)).rejects.toMatchObject({ code: 'MEMORY_SELF_ACTIVATION' });
    await expect(mem.activate(factId, 1, 'agent:x2a-owner')).rejects.toMatchObject({ code: 'MEMORY_SCOPE_FORBIDDEN' });
    for (const id of [factId, verifiedId, procedureId, invariantId]) {
      expect((await mem.get(id, 1))?.status).toBe('candidate');
    }
  });

  it('X2 : une lignée ancienne pair-revue reste lisible, reviewer_pid conservé', async () => {
    await ensureSchema(db);
    await db.prepare(
      "INSERT INTO memory_entries (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid, uses) VALUES ('x2x5-legacy', 1, 'participant:agent:x2a-legacy', 'fact', 'lignée ancienne pair-revue', '[\"ev:legacy"]', 'observed', 'active', 'agent:x2a-legacy', 'agent:x2a-pair', 4)",
    ).run();
    const rows = await store().listActiveFor('agent:x2a-legacy', ['participant:agent:x2a-legacy']);
    expect(rows.some((r) => r.id === 'x2x5-legacy')).toBe(true);
    expect(rows.find((r) => r.id === 'x2x5-legacy')?.reviewer_pid).toBe('agent:x2a-pair');
  });
});

describe('CC-3 X5 — indépendance P1 des cycles de travail (github-mcp#107)', () => {
  it('propose commun sur un cycle naissant P1 → MEMORY_P1_SHARED_MUTATION, rien écrit', async () => {
    const cycle = uniq('cycle');
    const id = uniq('mem');
    const before = await journalState(cycle);
    expect(await refuse({ cycle, type: 'memory.propose', participant: 'agent:x2x5-alpha', op: 'p',
      payload: { memory: { id, scope: 'common', kind: 'fact', text: 'commune interdite',
        evidence_refs: ['ev:x5-naissant'], confidence: 'observed' } } }))
      .toBe('MEMORY_P1_SHARED_MUTATION');
    expect(await journalState(cycle)).toEqual(before);
    expect(await memoryRowCount(id)).toBe(0);
  });

  it('cycles système P1 exclus + rejeu duplicate + garde transactionnelle (preparePropose → P1 → batch refuse → P2 → batch OK)', async () => {
    const w = uniq('work');
    await db.prepare("INSERT OR REPLACE INTO cycles (cycle_id, project, phase, revision) VALUES ('memory-alarms', '', 'P1', 1)").run();
    await db.prepare("INSERT OR REPLACE INTO cycles (cycle_id, project, phase, revision) VALUES ('owner-registry', '', 'P1', 1)").run();
    await seedP2Cycle(w);
    const proposePayload = { id: uniq('sys'), scope: 'common', kind: 'fact', text: 'commune depuis un cycle P2',
      evidence_refs: ['ev:x5-sys'], confidence: 'observed', author_pid: 'agent:x2x5-alpha' };
    expect((await append({ cycle: w, type: 'memory.propose', participant: 'agent:x2x5-alpha', op: 'p',
      payload: { memory: proposePayload } })).status).toBe('applied');
    expect(await refuse({ cycle: w, type: 'memory.propose', participant: 'agent:x2x5-alpha', op: 'p',
      payload: { memory: proposePayload } })).toBe('duplicate');
    const raceId = uniq('race');
    const prepared = await store().preparePropose({ id: raceId, scope: 'common', kind: 'fact',
      text: 'commune en course', evidence_refs: ['ev:x5-race'], confidence: 'observed', author_pid: 'agent:x2x5-alpha' });
    const racer = uniq('racer');
    await seedP1WorkCycle(racer, '');
    await expect(db.batch(prepared.statements)).rejects.toThrow();
    expect(await memoryRowCount(raceId)).toBe(0);
    await db.prepare("UPDATE cycles SET phase = 'P2' WHERE cycle_id = ?1").bind(racer).run();
    const rePrepared = await store().preparePropose({ id: raceId, scope: 'common', kind: 'fact',
      text: 'commune en course', evidence_refs: ['ev:x5-race'], confidence: 'observed', author_pid: 'agent:x2x5-alpha' });
    await db.batch(rePrepared.statements);
    expect(await memoryRowCount(raceId)).toBe(1);
  });

  it('matrice de visibilité : common, project, task, role — refus sous P1, acceptés sinon, retire non gardé', async () => {
    const alpha = 'agent:x2x5-alpha';
    const beta = 'agent:x2x5-beta';
    const b = uniq('cycle-b');
    await seedP2Cycle(b, 'x2x5-b');
    const c1 = uniq('c1');
    const c2 = uniq('c2');
    const pb = uniq('pb');
    expect((await append({ cycle: b, type: 'memory.propose', participant: alpha, op: 'p-c1',
      payload: { memory: { id: c1, scope: 'common', kind: 'fact', text: 'commune c1', evidence_refs: ['ev:c1'], confidence: 'observed' } } })).status).toBe('applied');
    expect((await append({ cycle: b, type: 'memory.review', participant: beta, op: 'r-c1',
      payload: { memory: { id: c1, version: 1 } } })).status).toBe('applied');
    expect((await append({ cycle: b, type: 'memory.propose', participant: alpha, op: 'p-c2',
      payload: { memory: { id: c2, scope: 'common', kind: 'fact', text: 'commune c2', evidence_refs: ['ev:c2'], confidence: 'observed' } } })).status).toBe('applied');
    expect((await append({ cycle: b, type: 'memory.propose', participant: alpha, op: 'p-pb',
      payload: { memory: { id: pb, scope: 'project:x2x5-b', kind: 'fact', text: 'projet b', evidence_refs: ['ev:pb'], confidence: 'observed' } } })).status).toBe('applied');
    const a = uniq('cycle-a');
    await seedP1WorkCycle(a, 'proj-a', 'x2x5-task');
    const before = await journalState(b);
    const blockedScopes = ['common', 'project:proj-a', 'task:x2x5-task', 'role:owner'];
    for (const scope of blockedScopes) {
      expect(await refuse({ cycle: b, type: 'memory.propose', participant: alpha, op: 'blk-' + scope,
        payload: { memory: { id: uniq('blk'), scope, kind: 'fact', text: 'bloqué ' + scope,
          evidence_refs: ['ev:x5-blk'], confidence: 'observed' } } }))
        .toBe('MEMORY_P1_SHARED_MUTATION');
    }
    expect(await refuse({ cycle: b, type: 'memory.review', participant: beta, op: 'r-c2',
      payload: { memory: { id: c2, version: 1 } } })).toBe('MEMORY_P1_SHARED_MUTATION');
    expect(await refuse({ cycle: b, type: 'memory.consolidate', participant: alpha, op: 'sup-c1',
      payload: { memory: { id: c1, text: 'c1 v2', evidence_refs: ['ev:c1b'] } } })).toBe('MEMORY_P1_SHARED_MUTATION');
    expect(await journalState(b)).toEqual(before);
    const acceptedScopes = ['project:x2x5-other', 'task:absente', 'role:xyz'];
    for (const scope of acceptedScopes) {
      expect((await append({ cycle: b, type: 'memory.propose', participant: alpha, op: 'ok-' + scope,
        payload: { memory: { id: uniq('ok'), scope, kind: 'fact', text: 'accepté ' + scope,
          evidence_refs: ['ev:x5-ok'], confidence: 'observed' } } })).status).toBe('applied');
    }
    expect((await append({ cycle: b, type: 'memory.review', participant: beta, op: 'r-pb',
      payload: { memory: { id: pb, version: 1 } } })).status).toBe('applied');
    expect((await append({ cycle: b, type: 'memory.retire', participant: alpha, op: 'x-c1',
      payload: { memory: { id: c1, version: 1 } } })).status).toBe('applied');
    expect((await append({ cycle: b, type: 'memory.propose', participant: alpha, op: 'p-private',
      payload: { memory: { id: uniq('priv'), scope: 'participant:agent:x2x5-alpha', kind: 'observation',
        text: 'privée X2', evidence_refs: ['ev:priv'], confidence: 'observed' } } })).status).toBe('applied');
    expect(await journalState(b)).toEqual({ revision: 10, events: 10 });
  });
});
