import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { estimateTokens } from '../../../src/collab-store/contracts/memory';
import { ensureResearchSchema } from '../../../src/collab-store/research/schema';
import { runResearchPass } from '../../../src/collab-store/research/run';
import { listFindings } from '../../../src/collab-store/research/index';

const db = (env as unknown as { COLLAB_DB_C6_RESTORE: D1Database }).COLLAB_DB_C6_RESTORE;
let n = 0;
const unique = (tag: string) => 'l5-' + tag + '-' + ++n;

async function seedCycle(): Promise<string> {
  const cycle = unique('cycle');
  await db.prepare('INSERT INTO cycles (cycle_id) VALUES (?1)').bind(cycle).run();
  return cycle;
}

interface SeedMemory {
  id: string;
  scope: string;
  kind: string;
  text: string;
  uses?: number;
  last_used_rev?: number | null;
}

async function seedMemory(row: SeedMemory): Promise<void> {
  await db
    .prepare(
      "INSERT INTO memory_entries (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid, uses, last_used_rev, token_cost) VALUES (?1, 1, ?2, ?3, ?4, '["seed"]', 'observed', 'active', 'l5-author', 'l5-reviewer', ?5, ?6, ?7)",
    )
    .bind(row.id, row.scope, row.kind, row.text, row.uses ?? 0, row.last_used_rev ?? null, estimateTokens(row.text))
    .run();
}

interface ConsolidationDetail {
  groups: Array<{ scope: string; kind: string; count: number; ids: string[] }>;
  hint: string;
}

interface ArchiveFirstDetail {
  candidates: Array<{ id: string; version: number; scope: string; kind: string; uses: number; last_used_rev: number | null }>;
  hint: string;
}

describe('L5 research pass (real D1, read-only over the canonical registry)', () => {
  it('records hygiene findings and never touches memory_entries or events', async () => {
    await ensureSchema(db, true);
    await ensureResearchSchema(db, true);
    const cycle = await seedCycle();
    const tag = unique('mem');
    await seedMemory({ id: tag + '-dup-a', scope: 'common', kind: 'lesson', text: 'l5 duplicate lesson' });
    await seedMemory({ id: tag + '-dup-b', scope: 'common', kind: 'lesson', text: 'l5 duplicate lesson' });
    await seedMemory({ id: tag + '-used', scope: 'common', kind: 'fact', text: 'l5 used fact', uses: 3, last_used_rev: 9 });
    await seedMemory({ id: tag + '-never-1', scope: 'participant:l5-agent', kind: 'observation', text: 'l5 never used one' });
    await seedMemory({ id: tag + '-never-2', scope: 'participant:l5-agent', kind: 'observation', text: 'l5 never used two' });
    await seedMemory({ id: tag + '-invariant', scope: 'common', kind: 'invariant', text: 'l5 critical invariant' });
    const memoryProjection = 'SELECT id, version, scope, kind, text, status, uses, last_used_rev FROM memory_entries ORDER BY id, version';
    const before = await db.prepare(memoryProjection).all();
    const pass = await runResearchPass(db, { passId: unique('pass'), cycleId: cycle, caps: { participant: 1, shared: 50 } });
    expect(pass.status).toBe('recorded');
    expect(pass.findings.scope_stats).toBe(1);
    expect(pass.findings.cap_pressure).toBe(1);
    expect(pass.findings.archive_first).toBe(1);
    expect(pass.findings.consolidation_candidate).toBe(1);
    expect(pass.findings.journal_growth).toBe(1);
    expect(pass.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
    const findings = await listFindings(db, { cycleId: cycle });
    expect(findings.length).toBe(pass.findings_count);
    // Privacy (X2/CRB-R1): findings never carry memory text, even for shared scopes.
    expect(JSON.stringify(findings)).not.toContain('l5 duplicate lesson');
    const consolidation = JSON.parse(findings.find(finding => finding.kind === 'consolidation_candidate')!.detail_json) as ConsolidationDetail;
    const group = consolidation.groups.find(g => g.scope === 'common' && g.kind === 'lesson');
    expect(group?.count).toBe(2);
    expect(group?.ids).toContain(tag + '-dup-a');
    // Archive-first (D3-e): protected kinds are never archive candidates; never-served come first.
    const archiveFirst = JSON.parse(findings.find(finding => finding.kind === 'archive_first')!.detail_json) as ArchiveFirstDetail;
    const ids = archiveFirst.candidates.map(candidate => candidate.id);
    expect(ids).not.toContain(tag + '-invariant');
    expect(ids.indexOf(tag + '-never-1')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(tag + '-never-1')).toBeLessThan(ids.indexOf(tag + '-used'));
    // Read-only proof: the canonical registry is untouched by a research pass.
    const after = await db.prepare(memoryProjection).all();
    expect(after).toEqual(before);
    const written = await db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE cycle_id = ?1 AND type = 'research.pass'")
      .bind(cycle)
      .first<{ c: number }>();
    expect(written?.c).toBe(0);
  });

  it('replaying the same pass_id writes nothing new (idempotence)', async () => {
    await ensureSchema(db, true);
    await ensureResearchSchema(db, true);
    const cycle = await seedCycle();
    const tag = unique('mem');
    await seedMemory({ id: tag + '-dup-a', scope: 'common', kind: 'fact', text: 'l5 replay duplicate' });
    await seedMemory({ id: tag + '-dup-b', scope: 'common', kind: 'fact', text: 'l5 replay duplicate' });
    const passId = unique('pass');
    const count = async () =>
      (await db.prepare('SELECT COUNT(*) AS c FROM research_findings WHERE pass_id = ?1').bind(passId).first<{ c: number }>())?.c ?? 0;
    const first = await runResearchPass(db, { passId, cycleId: cycle });
    expect(first.status).toBe('recorded');
    const findingsAfterFirst = await count();
    const replay = await runResearchPass(db, { passId, cycleId: cycle });
    expect(replay.status).toBe('duplicate');
    expect(replay.snapshot_sha256).toBe(first.snapshot_sha256);
    expect(replay.findings_count).toBe(first.findings_count);
    expect(await count()).toBe(findingsAfterFirst);
    const passes = await db.prepare('SELECT COUNT(*) AS c FROM research_passes WHERE pass_id = ?1').bind(passId).first<{ c: number }>();
    expect(passes?.c).toBe(1);
  });

  it('HALT: no write at all, status halted (fail-closed)', async () => {
    await ensureSchema(db, true);
    await ensureResearchSchema(db, true);
    const cycle = await seedCycle();
    const passId = unique('halted');
    await db.prepare("INSERT OR REPLACE INTO owner_flags (name, value, updated_at) VALUES ('halt', '1', strftime('%s','now'))").run();
    try {
      const pass = await runResearchPass(db, { passId, cycleId: cycle });
      expect(pass.status).toBe('halted');
      expect(pass.findings_count).toBe(0);
      const stored = await db.prepare('SELECT COUNT(*) AS c FROM research_passes WHERE pass_id = ?1').bind(passId).first<{ c: number }>();
      expect(stored?.c).toBe(0);
    } finally {
      await db.prepare("DELETE FROM owner_flags WHERE name = 'halt'").run();
    }
  });
});
