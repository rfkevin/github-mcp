import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MESSAGES_URL, createAnthropicModel, parseAnthropicRef, readAnthropicResponse, toAnthropicMessages,
} from '../../../src/collab-store/agentrun';
import { apiModelRate } from '../../../src/collab-store/executors/model-rates';
import { FUNDED, fetchStub, freshRun, quotaOf, stepRow } from './cc7-l2-paid-harness';
import { paidAdapterContract, paidContractCall, type PaidContractCall } from './cc7-l2-paid-contract';

// CC-7 L2 (PR 2.3, plan CC-PLAN-7 v0.2 S2) — adaptateur Anthropic du canal
// payant : protocole Messages distinct (system top-level, blocs
// text/tool_use/tool_result, input_schema, en-têtes x-api-key +
// anthropic-version, pas de Bearer). Les invariants communs (gardes avant
// tout appel, réservation/règlement, rejeu fail-closed, jamais de découvert,
// plafond de l’exécution, câblage engineFor) sont conduits une seule fois par
// le contrat commun cc7-l2-paid-contract.ts (mois 2032-06, jours 01-08) ;
// cette suite ne garde que les spécificités du protocole Messages. Aucun
// appel réel : fetch scripté, secret factice.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const SECRET = 'anthropic-test-key-CANARY-never-store';
const TOOL_SCHEMA = { name: 'store_context', description: 'Contexte du cycle pour ce participant.', parameters: { type: 'object' } };

/** Réponse du protocole Messages : blocs de contenu + usage input_tokens/output_tokens. */
function anthropicReply(text: string, usage: { input: number; output: number }) {
  return { content: [{ type: 'text', text }], usage: { input_tokens: usage.input, output_tokens: usage.output } };
}

/** Modèle Anthropic de test : enveloppe financée, secret factice, fetch injecté, horloge fixée. */
function anthropicModel(opts: PaidContractCall) {
  return createAnthropicModel({ env: (opts.env ?? { LLM_KEY_ANTHROPIC: SECRET }) as { LLM_KEY_ANTHROPIC?: string },
    ref: opts.ref ?? 'anthropic:claude-sonnet-5-5', db, runId: opts.runId, envelope: opts.envelope ?? FUNDED,
    schemas: () => [TOOL_SCHEMA], system: 'S', maxOutputTokens: 4_096, fetchImpl: opts.fetchImpl, now: () => opts.at });
}

// Invariants communs des adaptateurs payants du canal API, conduits pour Anthropic.
paidAdapterContract(db, {
  prefix: 'l2a',
  ref: 'anthropic:claude-sonnet-5-5',
  provider: 'anthropic',
  url: ANTHROPIC_MESSAGES_URL,
  testSecret: SECRET,
  worstCents: 5,
  actualCents: 2,
  month: '2032-06',
  // CC-7 L9b : Opus 5.5 est désormais tarifé ; la référence hors registre devient un modèle retiré.
  offRegistryRef: 'anthropic:claude-opus-4-1',
  toolDescription: 'Contexte du cycle pour ce participant.',
  makeResponse: anthropicReply,
  expectHeaders: headers => {
    expect(headers.get('x-api-key')).toBe(SECRET);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('Authorization')).toBeNull();
  },
  expectRequestBody: body => {
    expect(body.system).toBe('S');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
    expect(body.tools).toEqual([{ name: 'store_context',
      description: 'Contexte du cycle pour ce participant.', input_schema: { type: 'object' } }]);
  },
  model: opts => anthropicModel(opts),
});

describe('CC-7 L2 PR 2.3 — adaptateur Anthropic : construction', () => {
  it('références refusées à la construction : hors registre, autre fournisseur, vide, maxOutputTokens', () => {
    for (const bad of ['anthropic:claude-opus-4-1', 'anthropic:claude-3-5-sonnet', 'zai:glm-5.3', 'xai:grok-4.7',
      'workers-ai:@cf/moonshotai/kimi-k2.6', 'anthropic:']) {
      expect(() => parseAnthropicRef(bad)).toThrow(/ANTHROPIC_MODEL_UNSUPPORTED/);
    }
    const parsed = parseAnthropicRef('anthropic:claude-sonnet-5-5');
    expect(parsed.model).toBe('claude-sonnet-5-5');
    expect(parsed.rate).toBe(apiModelRate('anthropic:claude-sonnet-5-5'));
    const base = { env: { LLM_KEY_ANTHROPIC: SECRET }, fetchImpl: fetchStub([]).fetchImpl, db,
      runId: 'l2a-x', envelope: FUNDED, schemas: () => [], system: 'S' };
    expect(() => createAnthropicModel({ ...base, ref: 'anthropic:claude-sonnet-5-5', maxOutputTokens: 0 })).toThrow(/maxOutputTokens/);
    expect(() => createAnthropicModel({ ...base, ref: 'anthropic:claude-sonnet-5-5', maxOutputTokens: 8_193 })).toThrow(/maxOutputTokens/);
  });
});

describe('CC-7 L2 PR 2.3 — adaptateur Anthropic : protocole Messages', () => {
  it('journal du moteur converti : system top-level, tool_use assistant, tool_result porté par un tour user', () => {
    const converted = toAnthropicMessages('S', [
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_01', name: 'store_context', args: { q: 1 } }] },
      { role: 'tool', content: '{"n":1}', tool_call_id: 'toolu_01' },
    ]);
    expect(converted.system).toBe('S');
    expect(converted.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'ping' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'store_context', input: { q: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"n":1}' }] },
    ]);
  });

  it('blocs tool_use lus en tool_calls, textes concaténés, id absent synthétisé, arguments non objet rejetés', () => {
    const parsed = readAnthropicResponse({ content: [
      { type: 'text', text: 'Lecture ' },
      { type: 'text', text: 'du cycle.' },
      { type: 'tool_use', id: 'toolu_01', name: 'store_context', input: { q: 1 } },
      { type: 'tool_use', name: 'store_context', input: 'invalide' },
    ], usage: { input_tokens: 10, output_tokens: 20 } });
    expect(parsed.output.text).toBe('Lecture du cycle.');
    expect(parsed.output.tool_calls).toEqual([
      { id: 'toolu_01', name: 'store_context', args: { q: 1 } },
      { id: 'toolu_1', name: 'store_context', args: {} },
    ]);
    expect(parsed.input).toBe(10);
    expect(parsed.output_tokens).toBe(20);
  });

  it('appel d’outils de bout en bout : réponse tool_use visible par le moteur, coût au tarif relevé', async () => {
    const at = new Date('2032-06-10T10:00:00Z');
    const run = await freshRun(db, 'l2a', 1_976_000_400);
    const stub = fetchStub([{ content: [
      { type: 'text', text: 'Je lis le contexte.' },
      { type: 'tool_use', id: 'toolu_01', name: 'store_context', input: { cycle: 'cc7-api-auto' } },
    ], usage: { input_tokens: 1_000, output_tokens: 1_000 } }]);
    const result = await paidContractCall(anthropicModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at }), ['store_context']);
    expect(result.output.tool_calls).toEqual([{ id: 'toolu_01', name: 'store_context', args: { cycle: 'cc7-api-auto' } }]);
    expect(result.usage.cost_cents).toBe(2);
    expect(await stepRow(db, run.runId, 0)).toEqual({ reserved_cents: 5, actual_cents: 2, settled: 1 });
    expect(await quotaOf(db, 'paid:participant:vibe:day:2032-06-10')).toBe(2);
  });

  it('usage absent : jetons d’entrée bornés par les octets du protocole, sortie aux octets de la sortie, jamais 0', async () => {
    const at = new Date('2032-06-11T10:00:00Z');
    const run = await freshRun(db, 'l2a', 1_976_000_450);
    const stub = fetchStub([{ content: [{ type: 'text', text: 'sans usage' }] }]);
    const result = await paidContractCall(anthropicModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at }));
    expect(result.usage.tokens).toBeGreaterThan(100); // borne octets Messages (79) + sortie (36) = 115, jamais 0.
    expect(result.usage.cost_cents).toBeLessThanOrEqual(5);
  });
});
