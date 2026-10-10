import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStore, type AppendOutcome } from '../../../src/collab-store/store/collab-store';
import type { StoreEventType } from '../../../src/collab-store/contracts';
import { MemoryStore } from '../../../src/collab-store/memory/memory-store';
import { expireDueHypotheses } from '../../../src/collab-store/memory/hypothesis-expiry';
import { recordOwnerDecision } from '../../../src/collab-store/owner/decisions';
import { advanceByPolicy } from '../../../src/collab-store/phases';
import { exportMemoryMarkdown } from '../../../src/collab-store/export/memory-export';
import { ensureSchema, STORE_MIGRATION_0004 } from '../../../src/collab-store/store/schema';

/**
 * CC-3 CR-F04 (github-mcp#96, contre-revue Codex #79/6096598889) — expiration
 * des hypothèses isolée par cycle. Référence temporelle (décision Kevin) : la
 * révision du cycle d'origine (`expires_cycle`) ; jamais celle d'un autre cycle.
 * Tout passe par le journal public (CollabStore.appendEvent), les décisions
 * owner et les transitions de phase : aucun INSERT SQL de memory_entries, sauf
 * la ligne pré-0004 explicitement simulée.
 */
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const PROOF = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const uniq = (label: string) => 'crf4-' + label + '-' + Date.now().toString(36) + '-' + ++n;
const store = () => new CollabStore(db, { dailyWriteLimit: 100_000 });

async function append(cycle: string, type: StoreEventType, participant: string, payload: Record<string, unknown>): Promise<AppendOutcome> {
  const collab = store();
  return collab.appendEvent({
    cycle_id: cycle,
    type,
    participant_id: participant,
    expected_rev: await collab.currentRevision(cycle),
    payload_json: JSON.stringify(payload),
    op_id: 'u:' + cycle + ':' + uniq('op') + ':1',
  });
}

async function refuse(cycle: string, type: StoreEventType, participant: string, payload: Record<string, unknown>): Promise<string> {
  try {
    const outcome = await append(cycle, type, participant, payload);
    throw new Error('refus attendu, événement ' + outcome.status);
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
}

const checkpoint = (cycle: string) => append(cycle, 'checkpoint', 'agent:a', { note: 'avance ' + uniq('cp') });

/** Avance le cycle par checkpoints jusqu'à la révision `target`. */
async function advanceTo(cycle: string, target: number): Promise<void> {
  while ((await store().currentRevision(cycle)) < target) await checkpoint(cycle);
}

async function propose(cycle: string, scope: string, author = 'agent:a', extra: Record<string, unknown> = {}) {
  const id = uniq('h');
  const outcome = await append(cycle, 'memory.propose', author, {
    memory: { id, scope, kind: 'observation', text: 'hypothèse ' + id, evidence_refs: ['ev:' + id], confidence: 'hypothesis', ...extra },
  });
  expect(outcome.status).toBe('applied');
  return id;
}

async function row(id: string, version = 1) {
  return db.prepare('SELECT status, confidence, expires_rev, expires_cycle FROM memory_entries WHERE id = ?1 AND version = ?2')
    .bind(id, version).first<{ status: string; confidence: string; expires_rev: number | null; expires_cycle: string | null }>();
}

async function snapshot(cycle: string) {
  const c = await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>();
  const e = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
  const m = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(status = \'retired\'), 0) AS r FROM memory_entries').first<{ n: number; r: number }>();
  return { revision: c?.revision ?? 0, events: e?.n ?? 0, rows: m?.n ?? 0, retired: m?.r ?? 0 };
}

describe('CC-3 CR-F04 — expiration des hypothèses isolée par cycle', () => {
  it('deux cycles à révisions différentes, scopes partagés et privé : aucune expiration croisée', async () => {
    const [a, b] = [uniq('cycle-a'), uniq('cycle-b')];
    const shared = await propose(a, 'project:' + uniq('p'));            // A rev 1 → échéance 4
    expect(await row(shared)).toMatchObject({ expires_rev: 4, expires_cycle: a });
    expect((await append(a, 'memory.review', 'agent:b', { memory: { id: shared, version: 1 } })).status).toBe('applied'); // A rev 2
    const priv = await propose(a, 'participant:agent:a');               // A rev 3 → échéance 6 (candidate privée)
    const role = await propose(b, 'role:' + uniq('r'));                 // B rev 1 → échéance 4
    // B file loin devant : ni l'hypothèse partagée ni la privée de A ne bougent.
    await advanceTo(b, 30);
    expect((await row(role))?.status).toBe('retired');
    expect((await row(shared))?.status).toBe('active');
    expect((await row(priv))?.status).toBe('candidate');
    expect((await exportMemoryMarkdown(db, null)).content).toContain(shared);
    // A atteint 4 : seule l'hypothèse partagée expire, dans la transaction de l'append.
    await checkpoint(a);
    expect(await store().currentRevision(a)).toBe(4);
    expect((await row(shared))?.status).toBe('retired');
    expect((await row(priv))?.status).toBe('candidate');
    expect((await exportMemoryMarkdown(db, null)).content).not.toContain(shared);
    await advanceTo(a, 5);
    expect((await row(priv))?.status).toBe('candidate');
    await advanceTo(a, 6);
    expect((await row(priv))?.status).toBe('retired');
  });

  it('revue ou consolidation à la révision d’échéance → MEMORY_HYPOTHESIS_EXPIRED, rien d’écrit', async () => {
    const a = uniq('cycle-a');
    const h = await propose(a, 'project:' + uniq('p'));                 // rev 1 → échéance 4
    await advanceTo(a, 3);
    const before = await snapshot(a);
    expect(await refuse(a, 'memory.review', 'agent:b', { memory: { id: h, version: 1 } })).toBe('MEMORY_HYPOTHESIS_EXPIRED');
    expect(await snapshot(a)).toEqual(before);

    const k = await propose(a, 'project:' + uniq('p'));                 // rev 4 → échéance 7
    expect((await row(h))?.status).toBe('retired');
    expect((await append(a, 'memory.review', 'agent:b', { memory: { id: k, version: 1 } })).status).toBe('applied'); // rev 5
    await advanceTo(a, 6);
    const before2 = await snapshot(a);
    expect(await refuse(a, 'memory.consolidate', 'agent:a', {
      memory: { id: k, text: 'renouvellement trop tard', evidence_refs: ['ev:late'] },
    })).toBe('MEMORY_HYPOTHESIS_EXPIRED');
    expect(await snapshot(a)).toEqual(before2);
  });

  it('une échéance explicite déjà atteinte est refusée à la proposition, sans écriture', async () => {
    const a = uniq('cycle-a');
    await advanceTo(a, 2);
    const before = await snapshot(a);
    expect(await refuse(a, 'memory.propose', 'agent:a', {
      memory: { scope: 'project:' + uniq('p'), kind: 'observation', text: 'déjà échue', confidence: 'hypothesis', expires_rev: 3 },
    })).toBe('MEMORY_HYPOTHESIS_EXPIRED');
    expect(await snapshot(a)).toEqual(before);
    // Une échéance future est conservée telle quelle, liée à ce cycle.
    const h = await propose(a, 'project:' + uniq('p'), 'agent:a', { expires_rev: 9 });
    expect(await row(h)).toMatchObject({ expires_rev: 9, expires_cycle: a });
  });

  it('renouvellement : la consolidation restée hypothesis repart depuis le cycle qui consolide', async () => {
    const [a, b] = [uniq('cycle-a'), uniq('cycle-b')];
    const h = await propose(a, 'project:' + uniq('p'));                 // A rev 1 → échéance 4
    await append(a, 'memory.review', 'agent:b', { memory: { id: h, version: 1 } }); // A rev 2
    await advanceTo(b, 10);
    const renewed = await append(b, 'memory.consolidate', 'agent:a', {
      memory: { id: h, text: 'hypothèse renouvelée', evidence_refs: ['ev:renew'] },
    });                                                                  // B rev 11 → échéance 14 dans B
    expect(renewed.status).toBe('applied');
    expect(await row(h, 2)).toMatchObject({ status: 'candidate', confidence: 'hypothesis', expires_rev: 14, expires_cycle: b });
    expect((await row(h, 1))?.status).toBe('superseded');
    // L'ancienne échéance (A rev 4) ne touche pas la version renouvelée.
    await advanceTo(a, 6);
    expect((await row(h, 2))?.status).toBe('candidate');
    expect((await append(b, 'memory.review', 'agent:b', { memory: { id: h, version: 2 } })).status).toBe('applied'); // B rev 12
    await advanceTo(b, 13);
    expect((await row(h, 2))?.status).toBe('active');
    await advanceTo(b, 14);
    expect((await row(h, 2))?.status).toBe('retired');
  });

  it('une hausse de confiance (preuve pair F03) retire l’échéance', async () => {
    const a = uniq('cycle-a');
    const h = await propose(a, 'project:' + uniq('p'));
    await append(a, 'memory.review', 'agent:b', { memory: { id: h, version: 1 } });
    const ledgerRef = 'ev:' + uniq('ledger');
    await db.prepare("INSERT INTO evidence_ledger (subject_pid, producer, kind, payload_json, evidence_ref, at) VALUES ('agent:a', 'agent:b', 'evaluation', '{}', ?1, 1)")
      .bind(ledgerRef).run();
    const raised = await append(a, 'memory.consolidate', 'agent:a', {
      memory: { id: h, text: 'observée', evidence_refs: ['ev:obs'], confidence: 'observed', peer_evidence_ref: ledgerRef },
    });
    expect(raised.status).toBe('applied');
    expect(await row(h, 2)).toMatchObject({ confidence: 'observed', expires_rev: null, expires_cycle: null });
    await advanceTo(a, 20);
    expect((await row(h, 2))?.status).toBe('candidate');
  });

  it('décision owner et transition de phase avancent la révision : elles appliquent aussi les échéances', async () => {
    // Décision owner : l'append owner.decision amène le cycle à l'échéance.
    const c = uniq('cycle-owner');
    const h = await propose(c, 'project:' + uniq('p'));                 // rev 1 → échéance 4
    const requestId = uniq('req');
    const request = await append(c, 'owner.request', 'agent:a', { request_id: requestId, summary: 'question' }); // rev 2
    await checkpoint(c);                                                  // rev 3
    expect((await row(h))?.status).toBe('candidate');
    await recordOwnerDecision(db, { request_id: requestId, request_seq: (request as { event: { seq: number } }).event.seq, decision: 'deny', proof: PROOF });
    expect(await store().currentRevision(c)).toBe(4);
    expect((await row(h))?.status).toBe('retired');

    // Transition de phase par policy : même effet, dans la transaction de la transition.
    const d = uniq('cycle-phase');
    const k = await propose(d, 'project:' + uniq('p'));                 // rev 1 → échéance 4
    await advanceTo(d, 3);
    await db.prepare([
      'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
      "VALUES (?1, 'P1', '[]', '[]', '[]', 'policy-crf4')",
    ].join(' ')).bind(d).run();
    expect(await advanceByPolicy(db, { cycle_id: d, expected_revision: 3, policy_id: 'policy-crf4', next_phase: 'P2' }))
      .toMatchObject({ status: 'applied', revision: 4 });
    expect((await row(k))?.status).toBe('retired');
  });

  it('ligne sans cycle d’origine (pré-0004 / API interne sans cycle) : jamais expirée par un autre cycle', async () => {
    const mem = new MemoryStore(db);
    const legacy = await mem.propose({
      scope: 'project:' + uniq('legacy'), kind: 'observation', text: 'sans cycle', confidence: 'hypothesis',
      author_pid: 'agent:a', cycle_rev: 1,
    });
    expect(legacy).toMatchObject({ expires_rev: 4, expires_cycle: null });
    await advanceTo(uniq('cycle-x'), 12);
    expect((await mem.get(legacy.id, 1))?.status).toBe('candidate');
  });

  it('D1 Free : l’expiration par cycle utilise l’index partiel, sans balayage de la table', async () => {
    await ensureSchema(db);
    const plan = await db.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM memory_entries WHERE expires_cycle = ?1 AND confidence = 'hypothesis' AND status IN ('active', 'candidate') AND expires_rev <= 5",
    ).bind('crf4-plan').all<{ detail: string }>();
    expect(plan.results.map(step => step.detail).join(' | ')).toContain('idx_memory_hypothesis_expiry');
    // Le statement joint aux batchs est un seul UPDATE, idempotent.
    const first = await expireDueHypotheses(db, 'crf4-plan').run();
    const second = await expireDueHypotheses(db, 'crf4-plan').run();
    expect([first.meta.changes, second.meta.changes]).toEqual([0, 0]);
  });

  it('migration 0004 : un démarrage à froid rétablit la colonne et l’index, de façon idempotente', async () => {
    await ensureSchema(db, true);
    await db.batch([
      db.prepare('DROP INDEX IF EXISTS idx_memory_hypothesis_expiry'),
      db.prepare('ALTER TABLE memory_entries DROP COLUMN expires_cycle'),
    ]);
    const coldStart = (): D1Database =>
      ({
        prepare: (sql: string) => db.prepare(sql),
        batch: (statements: D1PreparedStatement[]) => db.batch(statements),
      }) as unknown as D1Database;
    await ensureSchema(coldStart());
    await ensureSchema(coldStart());
    const columns = await db.prepare('PRAGMA table_info(memory_entries)').all<{ name: string }>();
    expect(columns.results.filter(column => column.name === 'expires_cycle')).toHaveLength(1);
    const index = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_hypothesis_expiry'").first();
    expect(index).not.toBeNull();
    expect(STORE_MIGRATION_0004).toHaveLength(2);
  });
});
