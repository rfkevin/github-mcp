import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { nextActors, readControllerSnapshot, taskProposal } from '../../../src/collab-store/controller';
import { createCollabToolContext, type CollabToolContext } from '../../../src/collab-store/mcp/context';
import { registerCollabStoreTools } from '../../../src/collab-store/mcp/tools';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { snapshot, task } from './fixtures';

// CC-7 L0 — une tâche remise par proposal.submit (conception, sans PR) ne réveille plus son auteur « no-submission ».

describe('CC-7 L0 — règles : proposition déposée', () => {
  it('sans proposition ni soumission → réveil implement (inchangé)', () => {
    expect(nextActors(snapshot([task()])).decisions)
      .toMatchObject([{ kind: 'wake', actor: 'vibe', action: 'implement', rule: 'no-submission' }]);
  });

  it('proposition de l\'auteur sans PR → aucun réveil de l\'auteur', () => {
    expect(nextActors(snapshot([task({ proposal: { seq: 12 } })])).decisions).toEqual([]);
  });

  it('une demande de correction reste prioritaire sur la proposition', () => {
    const { decisions } = nextActors(snapshot([task({ proposal: { seq: 12 }, correction: { seq: 20, items: 1 } })]));
    expect(decisions).toMatchObject([{ actor: 'vibe', action: 'address_correction' }]);
  });

  it('proposition puis PR soumise → la PR prime (relecteur et testeur réveillés)', () => {
    const submission = { head: 'a'.repeat(40), base: 'b'.repeat(40), seq: 30 };
    const { decisions } = nextActors(snapshot([task({ proposal: { seq: 12 }, submission })]));
    expect(decisions.map(d => [d.actor, d.action]).sort()).toEqual([['claude', 'test'], ['grok', 'review']]);
  });
});

describe('CC-7 L0 — faits : taskProposal', () => {
  const event = (seq: number, participant: string, payload: unknown) =>
    ({ seq, participant, payload_json: typeof payload === 'string' ? payload : JSON.stringify(payload) });

  it('ne compte que l\'auteur ET la tâche nommée, et garde la plus récente', () => {
    const events = [
      event(1, 'vibe', { sealed_id: 's1', content_hash: 'h', task: 't1' }),
      event(2, 'grok', { task: 't1', content: 'x' }),
      event(3, 'vibe', { task: 't2', content: 'y' }),
      event(4, 'vibe', { sealed_id: 's2', content_hash: 'h' }),
      event(5, 'vibe', 'not json'),
      event(6, 'vibe', { task: 't1', content: 'z' }),
    ];
    expect(taskProposal('t1', 'vibe', events)).toEqual({ seq: 6 });
    expect(taskProposal('t1', 'grok', events)).toEqual({ seq: 2 });
    expect(taskProposal('t3', 'vibe', events)).toBeNull();
  });

  it('une proposition sans tâche (scellé ancien format) ne compte jamais', () => {
    expect(taskProposal('t1', 'vibe', [event(1, 'vibe', { sealed_id: 's', content_hash: 'h' })])).toBeNull();
  });
});

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
type Result = { isError?: boolean; structuredContent: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function registry(context: CollabToolContext): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerCollabStoreTools({
    registerTool(name: string, spec: { inputSchema: z.ZodRawShape; outputSchema: z.ZodRawShape }, handler: Handler) {
      handlers.set(name, async input => {
        const result = await handler(z.object(spec.inputSchema).parse(input));
        if (!result.isError) z.object(spec.outputSchema).parse(result.structuredContent);
        return result;
      });
    },
  } as unknown as McpServer, context);
  return handlers;
}

describe('CC-7 L0 — store et instantané : scellé P1 avec tâche', () => {
  it('garde la tâche publique, scelle le contenu, et l\'instantané ne réveille plus l\'auteur', async () => {
    await ensureSchema(db, true);
    const cycle = 'cc7-l0-' + Date.now();
    const clientId = 'client-' + cycle;
    await db.prepare("INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P1', 1, 'open')").bind(cycle).run();
    for (const pid of ['sol', 'grok', 'vibe']) {
      await db.prepare([
        'INSERT INTO participants (participant_id, display_label, status)',
        "VALUES (?1, ?1, 'active')",
        "ON CONFLICT(participant_id) DO UPDATE SET status = 'active'",
      ].join(' ')).bind(pid).run();
    }
    await db.prepare('INSERT INTO participant_clients (oauth_client_id, participant_id) VALUES (?1, ?2)').bind(clientId, 'sol').run();
    await db.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status) VALUES',
      "('p-sol', ?1, 'sol', 'grok', 'vibe', 'accepted'), ('p-other', ?1, 'sol', 'vibe', 'grok', 'accepted')",
    ].join(' ')).bind(cycle).run();
    const createContextCompat = createCollabToolContext as unknown as (...args: unknown[]) => CollabToolContext;
    const handlers = registry(createContextCompat(
      { COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true', COLLAB_DAILY_WRITE_LIMIT: '100000' },
      'agent:sol', ['collab:'], { now: () => new Date('2026-10-25T00:00:00Z') }, clientId,
    ));

    const before = await readControllerSnapshot(db, cycle, async () => false);
    expect(nextActors(before).decisions.filter(d => d.rule === 'no-submission').map(d => d.task_id).sort())
      .toEqual(['p-other', 'p-sol']);

    const append = await handlers.get('collab_append_event')!({
      cycle, expected_rev: 1, op_id: 'sol:' + cycle + ':proposal:1', type: 'proposal.submit', participant_id: 'sol',
      role: 'author', payload_json: JSON.stringify({ task: 'p-sol', content: 'idée secrète' }),
    });
    expect(append.isError, JSON.stringify(append.structuredContent)).toBeFalsy();

    const delta = await handlers.get('collab_get_delta')!({ cycle, since_seq: 0, limit: 10 });
    expect(JSON.stringify(delta.structuredContent)).not.toContain('idée secrète');
    const stored = JSON.parse((delta.structuredContent.events as Array<{ payload_json: string }>)[0].payload_json) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['content_hash', 'sealed_id', 'task']);
    expect(stored.task).toBe('p-sol');

    const after = await readControllerSnapshot(db, cycle, async () => false);
    expect(after.tasks.find(t => t.task_id === 'p-sol')?.proposal).toBeTruthy();
    const wakes = nextActors(after).decisions.filter(d => d.rule === 'no-submission').map(d => d.task_id);
    // Seule la tâche nommée est remise ; l'autre tâche du même auteur reste à faire.
    expect(wakes).toEqual(['p-other']);
  });

  it('une tâche invalide n\'est pas recopiée à côté du scellé', async () => {
    await ensureSchema(db, true);
    const cycle = 'cc7-l0b-' + Date.now();
    const clientId = 'client-' + cycle;
    await db.prepare("INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P1', 1, 'open')").bind(cycle).run();
    await db.prepare([
      'INSERT INTO participants (participant_id, display_label, status)',
      "VALUES ('sol', 'Sol', 'active')",
      "ON CONFLICT(participant_id) DO UPDATE SET status = 'active'",
    ].join(' ')).run();
    await db.prepare('INSERT INTO participant_clients (oauth_client_id, participant_id) VALUES (?1, ?2)').bind(clientId, 'sol').run();
    const createContextCompat = createCollabToolContext as unknown as (...args: unknown[]) => CollabToolContext;
    const handlers = registry(createContextCompat(
      { COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true', COLLAB_DAILY_WRITE_LIMIT: '100000' },
      'agent:sol', ['collab:'], { now: () => new Date('2026-10-25T00:00:00Z') }, clientId,
    ));
    const append = await handlers.get('collab_append_event')!({
      cycle, expected_rev: 1, op_id: 'sol:' + cycle + ':proposal:1', type: 'proposal.submit', participant_id: 'sol',
      role: 'author', payload_json: JSON.stringify({ task: 'bad task <x>', content: 'c' }),
    });
    expect(append.isError, JSON.stringify(append.structuredContent)).toBeFalsy();
    const delta = await handlers.get('collab_get_delta')!({ cycle, since_seq: 0, limit: 10 });
    const stored = JSON.parse((delta.structuredContent.events as Array<{ payload_json: string }>)[0].payload_json) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['content_hash', 'sealed_id']);
  });
});
