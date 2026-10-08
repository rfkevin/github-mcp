import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import stateR6 from './fixtures/cc3-state-r6.md?raw';
import { canonicalState } from '../../../src/collab-store/export/document';
import { createCollabToolContext, type CollabToolContext } from '../../../src/collab-store/mcp/context';
import { registerCollabStoreTools } from '../../../src/collab-store/mcp/tools';
import { mapClient } from '../../../src/collab-store/owner/decisions';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { createOAuthFixture } from '../../oauth/helpers';
import { PROOF, importState, registerCc3 } from './helpers';

// CC-3 C6 — outil collab_export, isolement mémoire, repli explicite store indisponible (R4).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
type Result = { isError?: boolean; structuredContent: Record<string, any> };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const FALLBACK = 'rfkevin/project-mcp-collab:docs/coordination/cc3/state.md@main';

function tools(context: CollabToolContext): Map<string, Handler> {
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

function contextFor(clientId: string, database: D1Database = db): CollabToolContext {
  return createCollabToolContext({ COLLAB_DB: database, COLLAB_STORE_ENABLED: 'true', COLLAB_FALLBACK_STATE: FALLBACK },
    'agent', ['collab:'], {}, clientId);
}

beforeAll(async () => {
  await ensureSchema(db);
  await registerCc3(db, 'c6-tool');
  await mapClient(db, { oauth_client_id: 'client-c6-sol', participant_id: 'sol', proof: PROOF, op: 'c6-tool-map-sol' });
});

describe('CC-3 C6 — collab_export', () => {
  it('cc-state-1 : contenu canonique, empreinte et consigne de publication, sans écriture', async () => {
    const cycle = 'c6-tool-state';
    await importState(db, cycle, stateR6);
    const before = (await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())?.n;
    const result = await tools(contextFor('client-c6-sol')).get('collab_export')!({ cycle });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.content).toBe(canonicalState(stateR6));
    expect(result.structuredContent.state).toMatchObject({ revision: 6, changed: false,
      imported: { target: { repository: 'rfkevin/project-mcp-collab', path: 'docs/coordination/cc3/state.md', ref: 'main' } } });
    expect(result.structuredContent.publish).toMatch(/rien à publier/);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())?.n).toBe(before);
  });

  it('cycle sans état importé : NO_STATE_SNAPSHOT typé, non retryable', async () => {
    const result = await tools(contextFor('client-c6-sol')).get('collab_export')!({ cycle: 'c6-tool-none' });
    expect(result.structuredContent.error).toMatchObject({ code: 'NO_STATE_SNAPSHOT', retryable: false });
  });

  it('memory-md : scopes partagés + le scope personnel de l’appelant seulement', async () => {
    const insert = (id: string, scope: string, status: string, text: string) => db.prepare([
      'INSERT INTO memory_entries (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid)',
      "VALUES (?1, 1, ?2, 'lesson', ?3, '[\"github-mcp#70\"]', 'verified', ?4, 'sol', 'claude')",
    ].join(' ')).bind(id, scope, text, status).run();
    await insert('c6-m-common', 'common', 'active', 'Lire le delta avant de réessayer.');
    await insert('c6-m-mine', 'participant:sol', 'active', 'Ma stratégie.');
    await insert('c6-m-other', 'participant:vibe', 'active', 'Stratégie privée de Vibe.');
    await insert('c6-m-candidate', 'common', 'candidate', 'Pas encore revu.');
    const sol = await tools(contextFor('client-c6-sol')).get('collab_export')!({ cycle: 'any', format: 'memory-md' });
    expect(sol.isError).toBeFalsy();
    expect(sol.structuredContent.content).toContain('Lire le delta avant de réessayer.');
    expect(sol.structuredContent.content).toContain('Ma stratégie.');
    expect(sol.structuredContent.content).not.toContain('Stratégie privée de Vibe.');
    expect(sol.structuredContent.content).not.toContain('Pas encore revu.');
    const stranger = await tools(contextFor('client-c6-unmapped')).get('collab_export')!({ cycle: 'any', format: 'memory-md' });
    expect(stranger.structuredContent.content).not.toContain('Ma stratégie.');
    expect(stranger.structuredContent.content).toContain('Lire le delta avant de réessayer.');
  });
});

describe('CC-3 C6 — store indisponible : repli explicite en lecture seule (R4)', () => {
  const broken = new Proxy({}, { get: () => () => { throw new Error('D1_ERROR: database unavailable'); } }) as unknown as D1Database;

  it('chaque outil répond STORE_UNAVAILABLE, retryable, avec github_collab_context en lecture seule', async () => {
    const handlers = tools(contextFor('client-c6-sol', broken));
    const calls: Array<[string, Record<string, unknown>]> = [
      ['collab_get_context', { cycle: 'c6-down' }],
      ['collab_get_delta', { cycle: 'c6-down' }],
      ['collab_append_event', { cycle: 'c6-down', expected_rev: 0, op_id: 'sol:c6-down:x:1', type: 'checkpoint', participant_id: 'sol', payload_json: '{}' }],
      ['collab_export', { cycle: 'c6-down' }],
    ];
    for (const [name, args] of calls) {
      const result = await handlers.get(name)!(args);
      expect(result.isError, name).toBe(true);
      expect(result.structuredContent.error, name).toMatchObject({ code: 'STORE_UNAVAILABLE', retryable: true });
      expect(result.structuredContent.fallback, name).toEqual(expect.objectContaining({
        tool: 'github_collab_context', endpoint: '/mcp', mode: 'read_only', writes: 'suspended',
        state: { repository: 'rfkevin/project-mcp-collab', path: 'docs/coordination/cc3/state.md', ref: 'main' },
      }));
      expect(result.structuredContent.error.message, name).not.toContain('D1_ERROR');
    }
  });

  it('sans COLLAB_DB, /collab/mcp répond 503 en nommant le repli', async () => {
    // Jeton émis pendant que le store est configuré, puis appel après la perte du binding (même KV OAuth).
    const healthy = createOAuthFixture({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true' });
    const session = await healthy.mcpSession('mcp:read collab: offline_access', 'http://localhost:4321/callback',
      healthy.ORIGIN + '/collab/mcp');
    const fixture = createOAuthFixture({ COLLAB_DB: undefined, COLLAB_STORE_ENABLED: 'true', COLLAB_FALLBACK_STATE: FALLBACK });
    const response = await fixture.send('/collab/mcp', { method: 'POST', headers: session.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain('STORE_UNAVAILABLE');
    expect(text).toContain('github_collab_context');
    expect(text).toContain('docs/coordination/cc3/state.md');
  });

  it('aucun code du store n’écrit dans GitHub ; le module export est en lecture seule', async () => {
    const modules = import.meta.glob('../../../src/collab-store/**/*.ts', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
    for (const [path, load] of Object.entries(modules)) {
      const source = await load();
      expect(source, path).not.toMatch(/api\.github\.com|octokit|from ['"][./]*\/github\//i);
      if (path.includes('/collab-store/export/')) expect(source, path).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM|\w+\s+SET)\b/);
    }
  });
});

describe('CC-3 C6 — import par le canal owner', () => {
  const SECRET = 'owner-secret-C6-0123456789abcdefghijklmn';
  const fixture = () => createOAuthFixture({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true', OWNER_AUTH_MODE: 'secret', OWNER_SECRET: SECRET });
  const post = (f: ReturnType<typeof fixture>, fields: Record<string, string>) =>
    f.send('/owner', { method: 'POST', headers: { Origin: f.ORIGIN }, body: new URLSearchParams(fields) });

  it('importe l’état fusionné avec la preuve owner ; sans preuve : 403 et rien n’est écrit', async () => {
    const f = fixture();
    const fields = { action: 'import_state', cycle_id: 'c6-owner-http', target_repository: 'rfkevin/project-mcp-collab',
      target_path: 'docs/coordination/cc3/state.md', target_ref: 'main', state: stateR6 };
    expect((await post(f, { ...fields, owner_secret: 'mauvais-secret-0123456789abcdefghijkl' })).status).toBe(403);
    expect(await db.prepare("SELECT 1 FROM tasks WHERE cycle_id = 'c6-owner-http'").first()).toBeNull();
    const ok = await post(f, { ...fields, owner_secret: SECRET });
    expect(ok.status).toBe(200);
    const page = await ok.text();
    expect(page).toContain('État importé : révision 6, 11 tâches');
    expect(page).not.toContain(SECRET);
    const invalid = await post(f, { ...fields, cycle_id: 'c6-owner-bad', state: stateR6.replace('phase: P5', 'phase: P9'), owner_secret: SECRET });
    expect(invalid.status).toBe(409);
    expect(await invalid.text()).toContain('INVALID_PHASE');
    const tool = await tools(contextFor('client-c6-sol')).get('collab_export')!({ cycle: 'c6-owner-http' });
    expect(tool.structuredContent.content).toBe(canonicalState(stateR6));
  });

  it('collab_append_event ne peut pas forger un import (owner.decision réservé au canal owner)', async () => {
    const result = await tools(contextFor('client-c6-sol')).get('collab_append_event')!({
      cycle: 'c6-forge', expected_rev: 0, op_id: 'sol:c6-forge:import:1', type: 'owner.decision', participant_id: 'sol',
      payload_json: JSON.stringify({ action: 'import_state', content: stateR6 }),
    });
    expect(result.structuredContent.error.code).toBe('OWNER_DECISION_FORBIDDEN');
    await expect(importState(db, 'c6-forge', stateR6)).resolves.toMatchObject({ status: 'applied' });
  });
});
