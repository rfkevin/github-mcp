import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import { e2eScenario, toolCode as code, type E2eClient, type ToolResult } from './e2e-harness';

// CC-3 — conformité stricte des sorties d'événements (constat Claude sur cc3, 2026-10-11 :
// « Structured content does not match the tool's output schema: data/events/0 must NOT have
// additional properties »). Les clients MCP stricts valident structuredContent contre le
// schéma JSON publié par tools/list (additionalProperties: false) ; une colonne interne
// d'events (model_meta, migration store 0002) renvoyée par SELECT * faisait rejeter toute
// réponse contenant un événement. Chemin réel : OAuth + /collab/mcp, D1 local.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

const MODEL_META = 'SENTINELLE-MODEL-META';
const PRIVATE_TEXT = 'SENTINELLE-PRIVEE-SCHEMA';
const PRIVATE_REF = 'SENTINELLE-REF-SCHEMA';
const EVENT_KEYS = ['at', 'cycle_id', 'evidence_ref', 'expected_rev', 'idempotency_key', 'participant_id', 'payload_json',
  'role', 'seq', 'session_id', 'type'];

type Event = Record<string, unknown> & { seq: number; payload_json: string };
type Agent = E2eClient & { pid: string };
type Validate = (tool: string, value: unknown) => void;

/** Validation stricte contre les schémas publiés, comme un client MCP qui applique outputSchema. */
async function strictValidator(client: E2eClient): Promise<Validate> {
  const validator = new CfWorkerJsonSchemaValidator({ shortcircuit: false });
  const schemas = new Map((await client.listTools()).map(tool => [tool.name, tool.outputSchema]));
  return (tool, value) => {
    const schema = schemas.get(tool);
    expect(schema, tool + ' publie un outputSchema').toBeDefined();
    const result = validator.getValidator(schema!)(value);
    expect(result.errorMessage, tool).toBeUndefined();
    expect(result.valid, tool).toBe(true);
  };
}

function strictCall(agent: E2eClient, validate: Validate) {
  return async (tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const result = await agent.call(tool, args);
    if (!result.isError) validate(tool, result.structuredContent);
    return result;
  };
}

function expectNoSentinel(value: unknown, sentinels: string[]): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of sentinels) expect(serialized, sentinel).not.toContain(sentinel);
}

const sortedKeys = (event: unknown) => Object.keys(event as object).sort();

async function revision(cycle: string): Promise<number> {
  return (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())?.revision ?? 0;
}

function appendArgs(agent: Agent, cycle: string, rev: number, op: string, type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return { cycle, expected_rev: rev, op_id: `${agent.pid}:${cycle}:${op}:1`, type, participant_id: agent.pid,
    payload_json: JSON.stringify(payload), ...extra };
}

describe('CC-3 — sorties d’événements conformes au schéma MCP strict (HTTP)', () => {
  it('applied, duplicate, get_delta, get_context+delta et STALE : clés publiques seules, model_meta jamais exposé, mémoire privée masquée', async () => {
    const { agent, uniq } = e2eScenario(db, 'evs', 'owner-secret-EVS-0123456789abcdefghijklmno');
    const [alpha, beta] = [await agent('alpha'), await agent('beta')];
    const validate = await strictValidator(alpha);
    const [asAlpha, asBeta] = [strictCall(alpha, validate), strictCall(beta, validate)];
    const cycle = uniq('cycle');
    const memId = uniq('mem').slice(0, 40).toLowerCase();

    // applied (événement relu par clé d'idempotence) : conforme, clés publiques exactes.
    const opened = await asAlpha('collab_append_event', appendArgs(alpha, cycle, 0, 'open', 'checkpoint', { note: 'ouverture' }));
    expect(opened.structuredContent.status).toBe('applied');
    expect(sortedKeys(opened.structuredContent.event)).toEqual(EVENT_KEYS);

    // Mémoire privée d'alpha (sentinelles) : applied conforme pour son auteur.
    const proposed = await asAlpha('collab_append_event', appendArgs(alpha, cycle, 1, 'mem', 'memory.propose',
      { memory: { id: memId, scope: `participant:${alpha.pid}`, kind: 'fact', text: PRIVATE_TEXT, evidence_refs: [PRIVATE_REF],
        confidence: 'observed' } }, { evidence_ref: PRIVATE_REF }));
    expect(proposed.structuredContent).toMatchObject({ status: 'applied', memory: { id: memId, version: 1 } });
    const proposeSeq = (proposed.structuredContent.event as Event).seq;

    // Un futur écrivain de la colonne interne model_meta (migration 0002) ne doit rien changer aux sorties.
    await db.prepare('UPDATE events SET model_meta = ?1 WHERE cycle_id = ?2').bind(MODEL_META, cycle).run();

    // duplicate : l'événement original, relu depuis la base, reste conforme et sans model_meta.
    const replay = await asAlpha('collab_append_event', appendArgs(alpha, cycle, 0, 'open', 'checkpoint', { note: 'ouverture' }));
    expect(replay.structuredContent.status).toBe('duplicate');
    expect(sortedKeys(replay.structuredContent.event)).toEqual(EVENT_KEYS);
    expect((replay.structuredContent.event as Event).seq).toBe((opened.structuredContent.event as Event).seq);
    expectNoSentinel(replay, [MODEL_META]);

    // collab_get_delta lu par beta : conforme, model_meta absent, mémoire d'alpha masquée (CR-C).
    const delta = await asBeta('collab_get_delta', { cycle, since_seq: 0 });
    const events = delta.structuredContent.events as Event[];
    expect(events).toHaveLength(2);
    for (const event of events) expect(sortedKeys(event)).toEqual(EVENT_KEYS);
    expectNoSentinel(delta, [MODEL_META, PRIVATE_TEXT, PRIVATE_REF]);
    expect(JSON.parse(events.find(event => event.seq === proposeSeq)!.payload_json))
      .toEqual({ memory: { id: memId }, redacted: 'private_scope' });

    // collab_get_context avec include_delta : même garantie.
    const context = await asBeta('collab_get_context', { cycle, include_delta: true });
    const contextEvents = (context.structuredContent.delta as { events: Event[] }).events;
    expect(contextEvents).toHaveLength(2);
    for (const event of contextEvents) expect(sortedKeys(event)).toEqual(EVENT_KEYS);
    expectNoSentinel(context, [MODEL_META, PRIVATE_TEXT, PRIVATE_REF]);

    // L'auteur de la mémoire privée la relit en clair, toujours sans model_meta.
    const own = await asAlpha('collab_get_delta', { cycle, since_seq: 0 });
    expect(JSON.stringify(own)).toContain(PRIVATE_TEXT);
    expectNoSentinel(own, [MODEL_META]);

    // STALE (réponse d'erreur, que les clients ne valident pas) : le delta d'erreur porte
    // les mêmes événements publics, conformes au schéma d'événement publié.
    const before = await revision(cycle);
    const stale = await asBeta('collab_append_event', appendArgs(beta, cycle, 0, 'late', 'checkpoint', { note: 'en retard' }));
    expect(code(stale)).toBe('STALE');
    expect(stale.structuredContent.currentRevision).toBe(before);
    const staleEvents = stale.structuredContent.delta as Event[];
    expect(staleEvents).toHaveLength(2);
    for (const event of staleEvents) expect(sortedKeys(event)).toEqual(EVENT_KEYS);
    validate('collab_get_delta', { cycle_id: cycle, events: staleEvents, hasMore: false });
    expectNoSentinel(stale, [MODEL_META, PRIVATE_TEXT, PRIVATE_REF]);
    expect(await revision(cycle)).toBe(before);
  });

  it('chaque outil collab publie un outputSchema strict sur les événements (additionalProperties: false)', async () => {
    const { client } = e2eScenario(db, 'evl', 'owner-secret-EVL-0123456789abcdefghijklmno');
    const tools = await (await client()).listTools();
    const schema = (name: string) => tools.find(tool => tool.name === name)!.outputSchema as Record<string, any>;
    const deltaEvent = schema('collab_get_delta').properties.events.items;
    expect(deltaEvent.additionalProperties).toBe(false);
    expect(Object.keys(deltaEvent.properties).sort()).toEqual(EVENT_KEYS);
    expect(schema('collab_get_context').properties.delta.properties.events.items).toEqual(deltaEvent);
    expect(schema('collab_append_event').properties.event).toEqual(deltaEvent);
  });
});
