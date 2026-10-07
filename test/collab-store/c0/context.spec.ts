import { describe, expect, it } from 'vitest';
import { buildPacket, estimateTokens, type PacketMemory } from '../../../src/collab-store/proto/packet';
import { freshStore, metric, percentile } from './helpers';

describe('C0 S4 — role packet under a token budget', () => {
  const memory: PacketMemory[] = Array.from({ length: 120 }, (_, index) => ({
    id: `m${index}`,
    scope: ['common', 'project:github-mcp', 'role:reviewer', 'participant:p-claude', 'task:C2'][index % 5],
    text: `Lesson ${index}: `.padEnd(400, 'x'),
    score: (index * 37) % 100,
  }));
  const base = { header: { cycle: 'CC-3', phase: 'P5', rev: 2, lastSeen: 1 }, task: { id: 'C2', role: 'reviewer', nextAction: 'review' },
    roleCard: 'Reviewer: read every changed path, unread=[] before agree.', refs: ['https://github.com/rfkevin/project-mcp-collab/issues/25'] };

  it('stays within budget, keeps scope priority and lists excluded IDs', () => {
    const packet = buildPacket({ ...base, memory, budgetTokens: 6000 });
    expect(packet.tokens).toBeLessThanOrEqual(6000);
    expect(estimateTokens(packet)).toBeLessThanOrEqual(6000);
    expect(packet.excludedMemoryIds.length).toBeGreaterThan(0);
    expect(packet.memory.length + packet.excludedMemoryIds.length).toBe(memory.length);
    const firstExcludedCommon = memory.filter((entry) => entry.scope === 'common').every((entry) => packet.memory.some((kept) => kept.id === entry.id));
    expect(firstExcludedCommon).toBe(true);
    metric('S4_packet_tokens', packet.tokens);
    metric('S4_memory_kept', packet.memory.length);
  });

  it('fails closed when the mandatory layers alone exceed the budget', () => {
    expect(() => buildPacket({ ...base, memory, budgetTokens: 10 })).toThrow('BUDGET_TOO_SMALL');
  });
});

describe('C0 S5 — cross-cycle memory query', () => {
  it('reads common/project/role/participant entries across 20 cycles within 50 ms p95 (local)', async () => {
    const { db } = await freshStore();
    const scopes = ['common', 'project:github-mcp', 'project:portalshall', 'role:reviewer', 'role:author', 'participant:p-claude', 'participant:p-sol'];
    const rows = Array.from({ length: 2000 }, (_, index) => db.prepare(
      'INSERT INTO memory_entries (id, version, scope, kind, text, confidence, status, origin_cycle, uses) VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
    ).bind(`s5-${index}`, scopes[index % scopes.length], 'lesson', `entry ${index}`, 'observed', index % 9 === 0 ? 'retired' : 'active', `CC-${index % 20}`, index % 50));
    for (let offset = 0; offset < rows.length; offset += 200) await db.batch(rows.slice(offset, offset + 200));
    const query = db.prepare(
      `SELECT id, scope, text, uses FROM memory_entries WHERE status = 'active' AND scope IN (?1, ?2, ?3, ?4)
       ORDER BY uses DESC LIMIT 50`,
    ).bind('common', 'project:github-mcp', 'role:reviewer', 'participant:p-claude');
    const samples: number[] = [];
    let cycles = new Set<string>();
    for (let run = 0; run < 50; run += 1) {
      const start = performance.now();
      const { results } = await query.all<{ id: string }>();
      samples.push(performance.now() - start);
      expect(results.length).toBe(50);
    }
    const origin = await db.prepare(`SELECT DISTINCT origin_cycle FROM memory_entries WHERE status = 'active' AND scope = 'common'`).all<{ origin_cycle: string }>();
    cycles = new Set(origin.results.map((row) => row.origin_cycle));
    expect(cycles.size).toBeGreaterThan(1);
    const p95 = percentile(samples, 95);
    metric('S5_query_ms_p50', percentile(samples, 50));
    metric('S5_query_ms_p95', p95);
    expect(p95).toBeLessThanOrEqual(50);
  });
});
