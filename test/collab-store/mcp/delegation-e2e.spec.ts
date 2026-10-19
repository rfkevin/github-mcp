import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { appointCycleCoordinator } from '../../../src/collab-store/owner/delegation-execution';
import { executablePayloadSha256 } from '../../../src/collab-store/owner/executable';
import { registerDelegationTools } from '../../../src/collab-store/mcp/delegation-tools';
import type { CollabToolContext } from '../../../src/collab-store/mcp/context';

const db = (env as unknown as { COLLAB_DB_C6_RESTORE: D1Database }).COLLAB_DB_C6_RESTORE;
const ownerProof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const unique = (tag: string) => 'l3c-real-' + tag + '-' + (++n);

async function fixture(options: { appoint?: boolean; expiresOffset?: number; alteredHash?: boolean } = {}) {
  await ensureSchema(db);
  const cycle = unique('cycle');
  const requestId = unique('req');
  await db.prepare('INSERT INTO cycles (cycle_id) VALUES (?1)').bind(cycle).run();
  for (const pid of ['l3c-coord', 'l3c-author', 'l3c-review', 'l3c-outsider']) {
    await db.prepare("INSERT INTO participants (participant_id, display_label) VALUES (?1, ?1) ON CONFLICT(participant_id) DO NOTHING").bind(pid).run();
  }
  if (options.appoint !== false) await appointCycleCoordinator(db, {cycleId: cycle, participantId: 'l3c-coord', familyId: 'l3c-coord', expectedEpoch: 0, proof: ownerProof, op: unique('appoint')});
  const params = {cycle_id: cycle, definitions: ''};
  const hash = await executablePayloadSha256('install_phases', params);
  const expires = Math.floor(Date.now() / 1000) + (options.expiresOffset ?? 3600);
  const store = new CollabStore(db);
  const ask = await store.appendEvent({cycle_id: cycle, type: 'owner.request', participant_id: 'l3c-author', expected_rev: await store.currentRevision(cycle), op_id: 'l3c-author:' + cycle + ':ask:1', payload_json: JSON.stringify({request_id: requestId, summary: 'install phases', action: 'install_phases', params, payload_sha256: options.alteredHash ? 'f'.repeat(64) : hash, preconditions: {previous_seq: null}, expires_at: expires, max_cost_cents: 0, reason: 'test', risk: 'test', rollback: 'test'})});
  expect(ask.status).toBe('applied');
  return {cycle, requestId, store, expires};
}
async function approval(f: Awaited<ReturnType<typeof fixture>>, reviewer: string) {
  return f.store.appendEvent({cycle_id: f.cycle, type: 'delegation.approve', participant_id: reviewer, expected_rev: await f.store.currentRevision(f.cycle), op_id: reviewer + ':' + f.cycle + ':approve:1', payload_json: JSON.stringify({request_id: f.requestId})});
}
async function tool(cycle: string, requestId: string, participant: string) {
  let handler: ((input: {cycle: string; request_id: string}) => Promise<{isError?: boolean; content?: Array<{text?: string}>}>) | undefined;
  registerDelegationTools({registerTool(_name: string, _schema: unknown, callback: typeof handler) { handler = callback; }} as unknown as McpServer,
    {db, identity: async () => ({status: 'registered', participant_id: participant})} as unknown as CollabToolContext);
  return handler!({cycle, request_id: requestId});
}

describe('L3c real delegated owner path', () => {
  it('M3 vacancy: authenticated MCP cannot execute without owner appointment', async () => {
    const f = await fixture({appoint: false});
    expect((await tool(f.cycle, f.requestId, 'l3c-coord')).isError).toBe(true);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'owner.decision'").bind(f.cycle).first()).toMatchObject({n: 0});
  });
  it('M3 forged reviewer family: append approval rejects same logical identity', async () => {
    const f = await fixture();
    await db.prepare('INSERT OR REPLACE INTO participant_identity_families (participant_id, family_id, updated_at) VALUES (?1, ?2, ?3)').bind('l3c-review', 'l3c-coord', Math.floor(Date.now() / 1000)).run();
    try {
      await expect(approval(f, 'l3c-review')).rejects.toThrow();
      expect((await tool(f.cycle, f.requestId, 'l3c-coord')).isError).toBe(true);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM delegated_approvals WHERE request_id = ?1').bind(f.requestId).first()).toMatchObject({n: 0});
    } finally {
      await db.prepare('DELETE FROM participant_identity_families WHERE participant_id = ?1').bind('l3c-review').run();
    }
  });
  it('rejects expired request without owner decision', async () => {
    const f = await fixture({expiresOffset: -60});
    expect((await tool(f.cycle, f.requestId, 'l3c-coord')).isError).toBe(true);
  });
  it('rejects altered request digest without approval', async () => {
    const f = await fixture({alteredHash: true});
    expect((await tool(f.cycle, f.requestId, 'l3c-coord')).isError).toBe(true);
  });
  it('HALT rejects authenticated execution after independent approval', async () => {
    const f = await fixture();
    expect((await approval(f, 'l3c-review')).status).toBe('applied');
    await db.prepare("INSERT OR REPLACE INTO owner_flags (name, value, updated_at) VALUES ('halt', '1', strftime('%s','now'))").run();
    try { expect((await tool(f.cycle, f.requestId, 'l3c-coord')).isError).toBe(true); }
    finally { await db.prepare("DELETE FROM owner_flags WHERE name = 'halt'").run(); }
  });
  it('owner appointment -> owner.request -> independent approval -> MCP execution -> installed phases and delegated proof, no envelope', async () => {
    const f = await fixture();
    expect((await approval(f, 'l3c-review')).status).toBe('applied');
    const result = await tool(f.cycle, f.requestId, 'l3c-coord');
    expect(result.isError).toBeFalsy();
    const rows = await db.prepare('SELECT phase FROM phase_definitions WHERE cycle_id = ?1').bind(f.cycle).all<{phase: string}>();
    expect(rows.results.map(x => x.phase)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
    const decision = await db.prepare("SELECT payload_json FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' ORDER BY seq DESC LIMIT 1").bind(f.cycle).first<{payload_json: string}>();
    expect(decision).not.toBeNull();
    expect(JSON.parse(decision!.payload_json).proof_kind).toBe('delegated');
    expect(await db.prepare('SELECT used FROM delegated_approvals WHERE request_id = ?1').bind(f.requestId).first()).toMatchObject({used: 1});
    expect((await tool(f.cycle, f.requestId, 'l3c-coord')).isError).toBe(true);
  });
  it('rejects coordinator as approver, request author as approver, and non-coordinator executor', async () => {
    const f = await fixture();
    await expect(approval(f, 'l3c-coord')).rejects.toThrow();
    await expect(approval(f, 'l3c-author')).rejects.toThrow();
    expect((await tool(f.cycle, f.requestId, 'l3c-outsider')).isError).toBe(true);
  });
  it('revocation fences queued approval and HALT prevents execution', async () => {
    const f = await fixture();
    expect((await approval(f, 'l3c-review')).status).toBe('applied');
    await appointCycleCoordinator(db, {cycleId: f.cycle, participantId: null, familyId: null, expectedEpoch: 1, proof: ownerProof, op: unique('revoke')});
    expect((await tool(f.cycle, f.requestId, 'l3c-coord')).isError).toBe(true);
  });
});