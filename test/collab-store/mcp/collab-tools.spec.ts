import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createCollabToolContext, type CollabToolContext } from '../../../src/collab-store/mcp/context';
import { registerCollabStoreTools } from '../../../src/collab-store/mcp/tools';
import { mapClient, registerParticipant } from '../../../src/collab-store/owner/decisions';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { mapIssueToCycle } from '../../../src/collab-store/context';

const bindings = env as unknown as { COLLAB_DB_C2: D1Database };
type Result = { isError?: boolean; structuredContent: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function registry(context: CollabToolContext): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerCollabStoreTools({
    registerTool(name: string, spec: {
      inputSchema: z.ZodRawShape;
      outputSchema: z.ZodRawShape;
    }, handler: Handler) {
      handlers.set(name, async (input) => {
        const result = await handler(z.object(spec.inputSchema).parse(input));
        if (!result.isError) z.object(spec.outputSchema).parse(result.structuredContent);
        return result;
      });
    },
  } as unknown as McpServer, context);
  return handlers;
}

let counter = 0;
let day = 0;

function makeContext(dailyWriteLimit = 100_000): CollabToolContext {
  counter += 1;
  day += 1;
  const stamp = '2026-11-' + String(day).padStart(2, '0') + 'T10:00:00.000Z';
  return createCollabToolContext(
    { COLLAB_DB: bindings.COLLAB_DB_C2, COLLAB_STORE_ENABLED: 'true', COLLAB_DAILY_WRITE_LIMIT: String(dailyWriteLimit) },
    'agent:vibe', ['collab:'], { now: () => new Date(stamp) }, CLIENT_ID);
}

const CLIENT_ID = 'client-c2-tools';
beforeAll(async () => {
  const proof = { kind: 'secret' as const, subject: 'owner-secret' };
  await registerParticipant(bindings.COLLAB_DB_C2, { participant_id: 'agent:a', display_label: 'A', proof, op: 'c2-tools-register' });
  await mapClient(bindings.COLLAB_DB_C2, { oauth_client_id: CLIENT_ID, participant_id: 'agent:a', proof, op: 'c2-tools-map' });
});

function cycle(label: string): string {
  return ('c2m-' + label + '-' + counter).slice(0, 64);
}

function appendInput(cycleId: string, expectedRev: number, op: string, payload = '{"n":1}') {
  return {
    cycle: cycleId, expected_rev: expectedRev, op_id: 't:' + cycleId + ':' + op,
    type: 'checkpoint', participant_id: 'agent:a', payload_json: payload,
  };
}

async function seedPhaseCycle(label: string, autoAdvance = 'policy-p1'): Promise<string> {
  await ensureSchema(bindings.COLLAB_DB_C2);
  const cycleId = cycle(label);
  await bindings.COLLAB_DB_C2.prepare(
    "INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P1', 1, 'open')",
  ).bind(cycleId).run();
  await bindings.COLLAB_DB_C2.prepare([
    'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
    "VALUES (?1, 'P1', '[]', '[]', '[]', ?2)",
  ].join(' ')).bind(cycleId, autoAdvance).run();
  await bindings.COLLAB_DB_C2.prepare([
    'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
    "VALUES (?1, 'P2', '[]', '[]', '[]', 'none')",
  ].join(' ')).bind(cycleId).run();
  // CR-A / CR-01 : seul un participant qui tient un rôle dans le cycle déclenche la policy.
  // Parcours sans SQL (amorçage owner + garde d'identité) : phase-bootstrap-e2e.spec.ts.
  await bindings.COLLAB_DB_C2.prepare([
    'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
    "VALUES ('T-phase', ?1, 'agent:a', 'agent:b', 'agent:c', 'in_progress', '[]', '', '', 1)",
  ].join(' ')).bind(cycleId).run();
  return cycleId;
}

async function seedActiveMemory(id: string, scope: string, text: string): Promise<void> {
  await ensureSchema(bindings.COLLAB_DB_C2);
  await bindings.COLLAB_DB_C2.prepare([
    'INSERT INTO memory_entries',
    '(id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid, supersedes, uses, last_used_rev, expires_rev)',
    "VALUES (?1, 1, ?2, 'fact', ?3, '[\"e1\"]', 'observed', 'active', 'agent:a', 'agent:b', NULL, 0, NULL, NULL)",
  ].join(' ')).bind(id, scope, text).run();
}

describe('CC-3 C2 — outils collab_* (registre local)', () => {
  it('collab_append_event applique puis rejoue en duplicate (même seq)', async () => {
    const handlers = registry(makeContext());
    const cycleId = cycle('dup');
    const first = await handlers.get('collab_append_event')!(appendInput(cycleId, 0, 'cp:1'));
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent.status).toBe('applied');
    const retry = await handlers.get('collab_append_event')!(appendInput(cycleId, 0, 'cp:1'));
    expect(retry.structuredContent.status).toBe('duplicate');
    expect((retry.structuredContent.event as { seq: number }).seq)
      .toBe((first.structuredContent.event as { seq: number }).seq);
  });

  it('STALE : expected_rev périmé renvoie code, currentRevision et delta', async () => {
    const handlers = registry(makeContext());
    const cycleId = cycle('stale');
    const result = await handlers.get('collab_append_event')!(appendInput(cycleId, 5, 'cp:1'));
    expect(result.isError).toBe(true);
    const error = (result.structuredContent.error as { code: string; retryable: boolean });
    expect(error.code).toBe('STALE');
    expect(error.retryable).toBe(false);
    expect(result.structuredContent.currentRevision).toBe(0);
    expect(result.structuredContent.delta).toEqual([]);
  });

  it('QUOTA_EXHAUSTED après la limite quotidienne, sans écriture', async () => {
    const handlers = registry(makeContext(1));
    const cycleId = cycle('quota');
    const first = await handlers.get('collab_append_event')!(appendInput(cycleId, 0, 'cp:1'));
    expect(first.isError).toBeFalsy();
    const second = await handlers.get('collab_append_event')!(appendInput(cycleId, 1, 'cp:2'));
    expect(second.isError).toBe(true);
    expect((second.structuredContent.error as { code: string }).code).toBe('QUOTA_EXHAUSTED');
    const delta = await handlers.get('collab_get_delta')!({ cycle: cycleId, since_seq: 0, limit: 10 });
    expect((delta.structuredContent.events as unknown[])).toHaveLength(1);
  });

  it('OWNER_DECISION_FORBIDDEN : owner.decision refusé aux agents (I7)', async () => {
    const handlers = registry(makeContext());
    const cycleId = cycle('owner');
    const result = await handlers.get('collab_append_event')!({
      ...appendInput(cycleId, 0, 'own:1'), type: 'owner.decision',
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent.error as { code: string }).code).toBe('OWNER_DECISION_FORBIDDEN');
  });

  it('DUPLICATE_TASK_ROLE via task.claim (D12 à l\'écriture)', async () => {
    const handlers = registry(makeContext());
    const cycleId = cycle('d12');
    const result = await handlers.get('collab_append_event')!({
      cycle: cycleId, expected_rev: 0, op_id: 't:' + cycleId + ':claim:1', type: 'task.claim',
      participant_id: 'agent:a',
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:a', reviewer_pid: 'agent:a', tester_pid: 'agent:b' } }),
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent.error as { code: string }).code).toBe('DUPLICATE_TASK_ROLE');
  });

  it('UNKNOWN_CYCLE sur collab_get_context', async () => {
    const handlers = registry(makeContext());
    const result = await handlers.get('collab_get_context')!({ cycle: 'c2m-ghost-999' });
    expect(result.isError).toBe(true);
    expect((result.structuredContent.error as { code: string }).code).toBe('UNKNOWN_CYCLE');
  });

  it('aller-retour : append ×2 puis get_delta par curseur', async () => {
    const handlers = registry(makeContext());
    const cycleId = cycle('roundtrip');
    await handlers.get('collab_append_event')!(appendInput(cycleId, 0, 'cp:1'));
    await handlers.get('collab_append_event')!(appendInput(cycleId, 1, 'cp:2'));
    const delta = await handlers.get('collab_get_delta')!({ cycle: cycleId, since_seq: 0, limit: 10 });
    expect((delta.structuredContent.events as unknown[])).toHaveLength(2);
    expect(delta.structuredContent.hasMore).toBe(false);
  });
});

describe('F5 A07 — collab_phase_advance (outil MCP réel)', () => {
  it('applique P1→P2 puis rejeu → duplicate (même event_seq)', async () => {
    const handlers = registry(makeContext());
    const cycleId = await seedPhaseCycle('phase-ok');
    const first = await handlers.get('collab_phase_advance')!({
      cycle: cycleId, expected_rev: 1, next_phase: 'P2',
    });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent.status).toBe('applied');
    expect(first.structuredContent.revision).toBe(2);
    expect(typeof first.structuredContent.event_seq).toBe('number');

    const retry = await handlers.get('collab_phase_advance')!({
      cycle: cycleId, expected_rev: 1, next_phase: 'P2',
    });
    expect(retry.isError).toBeFalsy();
    expect(retry.structuredContent.status).toBe('duplicate');
    expect(retry.structuredContent.event_seq).toBe(first.structuredContent.event_seq);
  });

  it('refuse policy forgeable : auto_advance none → POLICY_NOT_AUTHORIZED', async () => {
    const handlers = registry(makeContext());
    const cycleId = await seedPhaseCycle('phase-none', 'none');
    const result = await handlers.get('collab_phase_advance')!({
      cycle: cycleId, expected_rev: 1, next_phase: 'P2',
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent.error as { code: string }).code).toBe('POLICY_NOT_AUTHORIZED');
  });

  it('refuse transition interdite P1→P6 → PHASE_TRANSITION_FORBIDDEN', async () => {
    const handlers = registry(makeContext());
    const cycleId = await seedPhaseCycle('phase-forbid');
    const result = await handlers.get('collab_phase_advance')!({
      cycle: cycleId, expected_rev: 1, next_phase: 'P6',
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent.error as { code: string }).code).toBe('PHASE_TRANSITION_FORBIDDEN');
  });
});

describe('F5 A09 — collab_get_context packet + mémoire', () => {
  it('expose packet phase/mémoire isolée + delta optionnel (identité serveur)', async () => {
    const handlers = registry(makeContext());
    await ensureSchema(bindings.COLLAB_DB_C2);
    const suffix = Date.now().toString(36) + String(counter);
    const cycleId = ('c2m-a09-' + suffix).slice(0, 64);
    const memCommon = ('memc-' + suffix).slice(0, 40);
    const memOwn = ('memo-' + suffix).slice(0, 40);
    const memOther = ('memx-' + suffix).slice(0, 40);

    await bindings.COLLAB_DB_C2.prepare(
      "INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P1', 1, 'open')",
    ).bind(cycleId).run();
    await bindings.COLLAB_DB_C2.prepare([
      'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
      "VALUES (?1, 1, 'checkpoint', 'agent:a', '', '', '{\"n\":1}', 0, ?2, '')",
    ].join(' ')).bind(cycleId, 'seed-a09-' + suffix).run();

    await seedActiveMemory(memCommon, 'common', 'shared fact for all');
    await seedActiveMemory(memOwn, 'participant:agent:a', 'private own');
    await seedActiveMemory(memOther, 'participant:agent:other', 'private other must not leak');

    const result = await handlers.get('collab_get_context')!({
      cycle: cycleId,
      include_delta: true,
      last_seen_seq: 0,
      delta_limit: 10,
    });
    if (result.isError) throw new Error('collab_get_context failed: ' + JSON.stringify(result.structuredContent));
    expect(result.structuredContent.participant_id).toBe('agent:a');

    const packet = result.structuredContent.packet as {
      header: { phase: string; participant_id: string; cycle_id: string };
      memory: Array<{ id: string; scope: string }>;
      budget: { max_tokens: number; estimated_tokens: number };
    };
    expect(packet.header.cycle_id).toBe(cycleId);
    expect(packet.header.phase).toBe('P1');
    const ids = packet.memory.map(m => m.id);
    expect(ids).toContain(memCommon);
    expect(ids).toContain(memOwn);
    expect(ids).not.toContain(memOther);

    const delta = result.structuredContent.delta as { events: unknown[] };
    expect(delta.events.length).toBeGreaterThanOrEqual(1);
  });

  it('I6 : task:other / role:other / project:other ne fuitent pas', async () => {
    const handlers = registry(makeContext());
    await ensureSchema(bindings.COLLAB_DB_C2);
    const suffix = Date.now().toString(36) + String(counter);
    const cycleId = ('c2m-i6-' + suffix).slice(0, 64);
    // C4: project:[A-Za-z0-9_-]{1,64} — pas de /
    const projectId = 'mcp-collab';

    await bindings.COLLAB_DB_C2.prepare(
      "INSERT INTO cycles (cycle_id, project, phase, revision, status) VALUES (?1, ?2, 'P1', 1, 'open')",
    ).bind(cycleId, projectId).run();
    await bindings.COLLAB_DB_C2.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
      "VALUES ('f5', ?1, 'agent:a', 'agent:b', 'agent:c', 'in_progress', '[]', 'ref', 'implement', 1)",
    ].join(' ')).bind(cycleId).run();

    const okCommon = ('i6c-' + suffix).slice(0, 40);
    const okOwn = ('i6o-' + suffix).slice(0, 40);
    const okRole = ('i6r-' + suffix).slice(0, 40);
    const okTask = ('i6t-' + suffix).slice(0, 40);
    const okProj = ('i6p-' + suffix).slice(0, 40);
    const leakTask = ('i6lt-' + suffix).slice(0, 40);
    const leakRole = ('i6lr-' + suffix).slice(0, 40);
    const leakProj = ('i6lp-' + suffix).slice(0, 40);

    await seedActiveMemory(okCommon, 'common', 'visible common');
    await seedActiveMemory(okOwn, 'participant:agent:a', 'visible own');
    await seedActiveMemory(okRole, 'role:owner', 'visible role owner');
    await seedActiveMemory(okTask, 'task:f5', 'visible task f5');
    await seedActiveMemory(okProj, 'project:' + projectId, 'visible project');
    await seedActiveMemory(leakTask, 'task:other', 'LEAK task other');
    await seedActiveMemory(leakRole, 'role:reviewer', 'LEAK role other');
    await seedActiveMemory(leakProj, 'project:other', 'LEAK project other');

    const result = await handlers.get('collab_get_context')!({ cycle: cycleId, task: 'f5' });
    if (result.isError) throw new Error('I6 get_context failed: ' + JSON.stringify(result.structuredContent));
    const packet = result.structuredContent.packet as { memory: Array<{ id: string }> };
    const ids = packet.memory.map(m => m.id);
    expect(ids).toContain(okCommon);
    expect(ids).toContain(okOwn);
    expect(ids).toContain(okRole);
    expect(ids).toContain(okTask);
    expect(ids).toContain(okProj);
    expect(ids).not.toContain(leakTask);
    expect(ids).not.toContain(leakRole);
    expect(ids).not.toContain(leakProj);
  });

  it('A09 E2E : issue → context → contribution → phase → mémoire → export', async () => {
    const handlers = registry(makeContext());
    await ensureSchema(bindings.COLLAB_DB_C2);
    const suffix = Date.now().toString(36) + String(counter);
    const cycleId = ('c2m-e2e-' + suffix).slice(0, 64);
    const repo = 'rfkevin/project-mcp-collab';
    const issueNum = 900000 + (counter % 10000);

    await bindings.COLLAB_DB_C2.prepare(
      "INSERT INTO cycles (cycle_id, project, phase, revision, status) VALUES (?1, ?2, 'P1', 1, 'open')",
    ).bind(cycleId, repo).run();
    await bindings.COLLAB_DB_C2.prepare([
      'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
      "VALUES (?1, 'P1', '[]', '[]', '[]', 'policy-p1')",
    ].join(' ')).bind(cycleId).run();
    await bindings.COLLAB_DB_C2.prepare([
      'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
      "VALUES (?1, 'P2', '[]', '[]', '[]', 'none')",
    ].join(' ')).bind(cycleId).run();
    await bindings.COLLAB_DB_C2.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
      "VALUES ('e2e', ?1, 'agent:a', 'agent:b', 'agent:c', 'in_progress', '[]', 'ref', 'implement', 1)",
    ].join(' ')).bind(cycleId).run();
    await mapIssueToCycle(bindings.COLLAB_DB_C2, '#' + issueNum, cycleId, repo);

    const memId = ('e2em-' + suffix).slice(0, 40);
    await seedActiveMemory(memId, 'common', 'e2e memory');

    const ctx1 = await handlers.get('collab_get_context')!({
      issue: String(issueNum), repository: repo, task: 'e2e',
      include_delta: true, last_seen_seq: 0,
    });
    if (ctx1.isError) throw new Error('E2E ctx1: ' + JSON.stringify(ctx1.structuredContent));
    expect((ctx1.structuredContent.resolved as { cycle_id: string }).cycle_id).toBe(cycleId);

    // op_id format {client}:{cycle}:{op}:{n} — n numérique
    const contrib = await handlers.get('collab_append_event')!(appendInput(cycleId, 1, 'cp:2'));
    expect(contrib.isError).toBeFalsy();
    expect(contrib.structuredContent.status).toBe('applied');

    // A09 : la contribution doit être observable via collab_get_delta dans le même parcours.
    const contribSeq = (contrib.structuredContent.event as { seq: number }).seq;
    const deltaAfter = await handlers.get('collab_get_delta')!({ cycle: cycleId, since_seq: 0, limit: 20 });
    if (deltaAfter.isError) throw new Error('E2E delta après contribution : ' + JSON.stringify(deltaAfter.structuredContent));
    expect((deltaAfter.structuredContent.events as Array<{ seq: number }>).map(e => e.seq)).toContain(contribSeq);

    const adv = await handlers.get('collab_phase_advance')!({
      cycle: cycleId, expected_rev: 2, next_phase: 'P2',
    });
    if (adv.isError) throw new Error('E2E advance: ' + JSON.stringify(adv.structuredContent));
    expect(adv.structuredContent.status).toBe('applied');

    const ctx2 = await handlers.get('collab_get_context')!({ cycle: cycleId, task: 'e2e' });
    if (ctx2.isError) throw new Error('E2E ctx2: ' + JSON.stringify(ctx2.structuredContent));
    expect((ctx2.structuredContent.packet as { header: { phase: string } }).header.phase).toBe('P2');
    const memIds = ((ctx2.structuredContent.packet as { memory: Array<{ id: string }> }).memory).map(m => m.id);
    expect(memIds).toContain(memId);

    const exp = await handlers.get('collab_export')!({ cycle: cycleId, format: 'memory-md' });
    if (exp.isError) throw new Error('E2E export: ' + JSON.stringify(exp.structuredContent));
    expect(exp.structuredContent.format).toBe('memory-md');
    expect((exp.structuredContent.content as string).length).toBeGreaterThan(0);
  });
});
