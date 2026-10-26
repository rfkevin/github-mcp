import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createXaiModel, parseXaiRef } from '../../../src/collab-store/agentrun';
import { apiModelRate } from '../../../src/collab-store/executors/model-rates';
import { XAI_CHAT_COMPLETIONS_URL } from '../../../src/collab-store/executors/openai-compatible';
import { FUNDED, fetchStub, freshRun, reply } from './cc7-l2-paid-harness';
import { paidAdapterContract, paidContractCall, type PaidContractCall } from './cc7-l2-paid-contract';

// CC-7 L2 (PR 2.2, plan CC-PLAN-7 v0.2 S2) — adaptateur xAI du canal payant :
// mêmes invariants que Z.ai, conduits une seule fois par le contrat commun
// cc7-l2-paid-contract.ts (mois 2032-05, jours 01-08) ; cette suite ne garde
// que les spécificités xAI : aucune option de raisonnement dans le corps
// (contrastée avec Z.ai), variantes non-reasoning = références distinctes du
// registre. Aucun appel réel : fetch scripté, secret factice. Helpers partagés
// : cc7-l2-paid-harness.ts.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_976_000_000;

/** Modèle xAI de test : enveloppe financée, secret factice, fetch injecté, horloge fixée. */
function xaiModel(opts: PaidContractCall) {
  return createXaiModel({
    env: (opts.env ?? { LLM_KEY_XAI: 'xai-test-key-CANARY-never-store' }) as { LLM_KEY_XAI?: string },
    ref: opts.ref ?? 'xai:grok-4.7', db, runId: opts.runId,
    envelope: opts.envelope ?? FUNDED,
    schemas: () => [{ name: 'store_context', description: 'Contexte du cycle pour ce participant.', parameters: { type: 'object' } }],
    system: 'S', maxOutputTokens: 4_096, fetchImpl: opts.fetchImpl, now: () => opts.at,
  });
}

// Invariants communs des adaptateurs payants du canal API, conduits pour xAI.
paidAdapterContract(db, {
  prefix: 'l2x',
  ref: 'xai:grok-4.7',
  provider: 'xai',
  url: XAI_CHAT_COMPLETIONS_URL,
  testSecret: 'xai-test-key-CANARY-never-store',
  worstCents: 3,
  actualCents: 1,
  month: '2032-05',
  offRegistryRef: 'xai:grok-4.1-fast',
  toolDescription: 'Contexte du cycle pour ce participant.',
  expectBody: body => expect(body.thinking).toBeUndefined(),
  model: opts => xaiModel(opts),
});

describe('CC-7 L2 PR 2.2 — adaptateur xAI : construction', () => {
  it('références refusées à la construction : hors registre xAI, autre fournisseur, maxOutputTokens', () => {
    expect(() => parseXaiRef('xai:grok-4.1-fast')).toThrow(/XAI_MODEL_UNSUPPORTED/);
    expect(() => parseXaiRef('xai:grok-3')).toThrow(/XAI_MODEL_UNSUPPORTED/);
    expect(() => parseXaiRef('zai:glm-5.3')).toThrow(/XAI_MODEL_UNSUPPORTED/);
    expect(() => parseXaiRef('workers-ai:@cf/moonshotai/kimi-k2.6')).toThrow(/XAI_MODEL_UNSUPPORTED/);
    const parsed = parseXaiRef('xai:grok-4.7');
    expect(parsed.model).toBe('grok-4.7');
    expect(parsed.rate).toBe(apiModelRate('xai:grok-4.7'));
    const base = { env: { LLM_KEY_XAI: 'xai-test-key-CANARY-never-store' }, fetchImpl: fetchStub([]).fetchImpl, db,
      runId: 'l2x-x', envelope: FUNDED, schemas: () => [], system: 'S' };
    expect(() => createXaiModel({ ...base, ref: 'xai:grok-4.7', maxOutputTokens: 0 })).toThrow(/maxOutputTokens/);
    expect(() => createXaiModel({ ...base, ref: 'xai:grok-4.7', maxOutputTokens: 8_193 })).toThrow(/maxOutputTokens/);
  });
});

describe('CC-7 L2 PR 2.2 — adaptateur xAI : spécificités', () => {
  it('variante non-reasoning du registre : référence distincte, tarif 125/250, aucun thinking dans le corps', async () => {
    const at = new Date('2032-05-10T10:00:00Z');
    const run = await freshRun(db, 'l2x', T + 250);
    const stub = fetchStub([reply('ok', { prompt_tokens: 1_000, completion_tokens: 1_000 })]);
    const result = await paidContractCall(xaiModel({ fetchImpl: stub.fetchImpl, runId: run.runId, at,
      ref: 'xai:grok-4.20-0309-non-reasoning' }));
    expect(stub.seen[0].body.model).toBe('grok-4.20-0309-non-reasoning');
    expect(stub.seen[0].body.thinking).toBeUndefined();
    expect(result.usage.cost_cents).toBe(1);
  });
});

