import { describe, expect, it } from 'vitest';
import { integrationWorthy, scheduleEventIntegration, type EventIntegrationEnv } from '../../../src/collab-store/gates/event-integration';
import rootSource from '../../../src/index.ts?raw';
import collabHandlerSource from '../../../src/collab-store/mcp/handler.ts?raw';

const event = (type: string, payload: unknown) => ({ type, payload_json: JSON.stringify(payload) });

describe('CC8 S8c — event-first integration trigger (no cron / no policy widening)', () => {
  it('only an APPLIED approval/submission/status/owner decision can request a merge scan', () => {
    for (const state of ['AGREED', 'PASS', 'SUBMITTED']) {
      expect(integrationWorthy(event('evidence.add', { state, task: 'S8' })), state).toBe(true);
    }
    for (const state of ['FAILED', 'AMEND', 'HALT', '', 'done']) {
      expect(integrationWorthy(event('evidence.add', { state })), state).toBe(false);
    }
    expect(integrationWorthy(event('task.status', { task: { status: 'done' } }))).toBe(true);
    expect(integrationWorthy(event('task.status', { task: { status: 'verified' } }))).toBe(true);
    expect(integrationWorthy(event('task.status', { task: { status: 'blocked' } }))).toBe(false);
    expect(integrationWorthy(event('owner.decision', {}))).toBe(true);
    expect(integrationWorthy(event('checkpoint', { state: 'PASS' }))).toBe(false);
    expect(integrationWorthy({ type: 'evidence.add', payload_json: 'garbled' })).toBe(false);
  });

  it('default off, no D1 and ordinary events schedule no background execution', () => {
    const pending: Promise<unknown>[] = [];
    const context = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
    const off = { AUTO_MERGE_INTEGRATION: 'false', SALON_ENABLED: 'false', COLLAB_DB: {} as D1Database } as EventIntegrationEnv;
    expect(scheduleEventIntegration(off, context, event('evidence.add', { state: 'AGREED' }))).toBe(false);
    expect(scheduleEventIntegration({ ...off, AUTO_MERGE_INTEGRATION: 'true', COLLAB_DB: undefined },
      context, event('evidence.add', { state: 'PASS' }))).toBe(false);
    expect(scheduleEventIntegration({ ...off, AUTO_MERGE_INTEGRATION: 'true' },
      context, event('checkpoint', { state: 'PASS' }))).toBe(false);
    expect(pending).toHaveLength(0);
  });

  it('cron cannot call model pass or merge; signed webhook and applied store hook retain event flow', () => {
    const scheduled = rootSource.slice(rootSource.indexOf('async scheduled('));
    expect(scheduled).toContain('runScheduledControllers(db');
    expect(scheduled).not.toContain('scheduleAgentRunPass(env, ctx)');
    expect(scheduled).not.toContain('scheduleIntegrationPass(');
    expect(scheduled).not.toContain('integrationPass(');
    // The accepted webhook still drives agent and separate integration passes.
    expect(rootSource).toContain('scheduleIntegrationPass(env as EventIntegrationEnv, ctx)');
    expect(rootSource).toContain('scheduleEventIntegration(env as EventIntegrationEnv, ctx, event)');
    // On the MCP route, event integration follows the same onApplied hook as agent-run wake.
    expect(collabHandlerSource).toContain('scheduleEventIntegration(env as AuthEnv & EventIntegrationEnv, context, event)');
    expect(collabHandlerSource).toContain('wake(event)');
  });
});
