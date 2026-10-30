import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ModelCallError, createProviderModel, createRoutedModel, participantModelRoute, participantModelVar, hasParticipantModels,
  isFreeApiModel, freeAllowed, toGeminiContents, readGeminiResponse, geminiGenerateUrl, GEMINI_SKIP_SIGNATURE, API_FREE_MODELS,
  type ModelClient, type ProviderEnv, type ProviderModelContext,
} from '../../../src/collab-store/agentrun';
import { engineFor } from '../../../src/collab-store/agentrun/object';
import { GEMINI_CC3_TEST_PUBLIC_ORIGIN } from '../../../src/collab-store/executors/gemini';
import {
  GROQ_CHAT_COMPLETIONS_URL, OPENROUTER_CHAT_COMPLETIONS_URL, ZAI_CHAT_COMPLETIONS_URL,
} from '../../../src/collab-store/executors/openai-compatible';
import { FUNDED, fetchStub, freshRun, quotaOf, reply, stepRow } from './cc7-l2-paid-harness';
import { paidAdapterContract, type PaidContractCall } from './cc7-l2-paid-contract';

// CC-7 L8 — chaque agent sur SA propre API : un modèle par participant (AGENT_RUN_MODEL_<PARTICIPANT>)
// et tous les fournisseurs du dépôt sur le moteur des agents API (Gemini, Groq, OpenRouter, DeepSeek
// en plus de Workers AI, Z.ai, xAI, Anthropic). Aucun appel réel : fetch scripté, secrets factices.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const ZERO = { dayCents: 0, cycleCents: 0, dayTokens: 0, dayRequests: 0 };
const SCHEMAS = () => [{ name: 'store_context', description: 'Lit le contexte du cycle.', parameters: { type: 'object' } }];
const GEMINI_FREE_ENV: ProviderEnv = { LLM_KEY_GEMINI: 'gem-test-key', GEMINI_FREE_PROJECT_ATTESTED: 'true', PUBLIC_ORIGIN: GEMINI_CC3_TEST_PUBLIC_ORIGIN };
const caught = (promise: Promise<unknown>) => promise.catch(e => e);
const call = (model: ModelClient, tools: string[] = ['store_context']) =>
  model.complete({ messages: [{ role: 'user', content: 'ping' }], tools, task_kind: 'answer' });

function ctx(runId: string, over: Partial<ProviderModelContext> = {}): ProviderModelContext {
  return { env: {}, db, runId, envelope: ZERO, schemas: SCHEMAS, system: 'S', maxOutputTokens: 4_096, ...over };
}

const geminiReply = (text: string, usage: { input: number; output: number }) =>
  ({ candidates: [{ content: { role: 'model', parts: [{ text }] } }], usageMetadata: { promptTokenCount: usage.input, candidatesTokenCount: usage.output } });

// Invariants communs des adaptateurs payants, conduits pour Gemini (protocole generateContent).
paidAdapterContract(db, {
  prefix: 'l8g', ref: 'gemini:gemini-3.6-flash', provider: 'gemini', url: geminiGenerateUrl('gemini-3.6-flash'),
  testSecret: 'gem-test-key', worstCents: 2, actualCents: 1, month: '2032-07', offRegistryRef: 'gemini:gemini-2.5-pro',
  toolDescription: 'Lit le contexte du cycle.',
  makeResponse: geminiReply,
  expectHeaders: headers => {
    expect(headers.get('x-goog-api-key')).toBe('gem-test-key');
    expect(headers.get('Authorization')).toBeNull();
  },
  expectModelAndMax: (body, _model, max) => {
    expect(body.model).toBeUndefined();
    expect((body.generationConfig as Record<string, unknown>).maxOutputTokens).toBe(max);
  },
  expectRequestBody: body => {
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'S' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'ping' }] }]);
    expect(body.tools).toEqual([{ functionDeclarations: [{ name: 'store_context', description: 'Lit le contexte du cycle.', parametersJsonSchema: { type: 'object' } }] }]);
  },
  model: (opts: PaidContractCall) => createProviderModel(opts.ref ?? 'gemini:gemini-3.6-flash', 'paid', ctx(opts.runId, {
    env: (opts.env ?? { LLM_KEY_GEMINI: 'gem-test-key' }) as ProviderEnv, envelope: opts.envelope ?? FUNDED,
    fetchImpl: opts.fetchImpl, now: () => opts.at })),
});

describe('CC-7 L8 — aiguillage par participant', () => {
  it('AGENT_RUN_MODEL_<PARTICIPANT> prime sur le réglage global (payant puis gratuit) ; aucun = null', () => {
    expect(participantModelVar('vibe-glm.2')).toBe('AGENT_RUN_MODEL_VIBE_GLM_2');
    const all = { AGENT_RUN_MODEL_GEMINI: ' gemini:gemini-3.5-flash-lite ', AGENT_RUN_PAID_MODEL: 'zai:glm-5.3', AGENT_RUN_MODEL: 'workers-ai:@cf/zai-org/glm-4.7-flash' };
    expect(participantModelRoute(all, 'gemini')).toEqual({ ref: 'gemini:gemini-3.5-flash-lite', tier: 'auto' });
    expect(participantModelRoute(all, 'grok')).toEqual({ ref: 'zai:glm-5.3', tier: 'paid' });
    expect(participantModelRoute({ AGENT_RUN_MODEL: 'workers-ai:@cf/zai-org/glm-4.7-flash' }, 'grok'))
      .toEqual({ ref: 'workers-ai:@cf/zai-org/glm-4.7-flash', tier: 'free' });
    expect(participantModelRoute({}, 'grok')).toBeNull();
    expect(hasParticipantModels({ AGENT_RUN_MODEL: 'x' })).toBe(false);
    expect(hasParticipantModels({ AGENT_RUN_MODEL_CLAUDE: '' })).toBe(false);
    expect(hasParticipantModels({ AGENT_RUN_MODEL_CLAUDE: 'anthropic:claude-haiku-5-5' })).toBe(true);
  });

  it('un même cycle, deux agents, deux fournisseurs distincts : Gemini pour gemini, Z.ai pour vibe (gratuits, coût 0)', async () => {
    const routes = { ...GEMINI_FREE_ENV, LLM_KEY_ZAI: 'zai-test-key',
      AGENT_RUN_MODEL_GEMINI: 'gemini:gemini-3.5-flash-lite', AGENT_RUN_MODEL_VIBE: 'zai:glm-4.7-flash' };
    const gem = await freshRun(db, 'l8r', 1_977_000_000, 10_000, 'gemini');
    const vibe = await freshRun(db, 'l8r', 1_977_000_000, 10_000, 'vibe');
    const stub = fetchStub([geminiReply('g', { input: 10, output: 5 }), reply('z', { prompt_tokens: 10, completion_tokens: 5 })]);
    const g = await call(createRoutedModel(routes, ctx(gem.runId, { env: routes, fetchImpl: stub.fetchImpl })));
    const z = await call(createRoutedModel(routes, ctx(vibe.runId, { env: routes, fetchImpl: stub.fetchImpl })));
    expect(stub.seen.map(s => s.url)).toEqual([geminiGenerateUrl('gemini-3.5-flash-lite'), ZAI_CHAT_COMPLETIONS_URL]);
    expect(stub.seen[1].body).toMatchObject({ model: 'glm-4.7-flash', thinking: { type: 'disabled' } });
    expect([g.output.text, g.usage.cost_cents, z.output.text, z.usage.cost_cents]).toEqual(['g', 0, 'z', 0]);
    for (const run of [gem, vibe]) expect(await stepRow(db, run.runId, 0)).toBeNull();
  });

  it('refus d’aiguillage : participant sans modèle, référence non permise, exécution inconnue — aucun appel, aucun repli', async () => {
    const run = await freshRun(db, 'l8r', 1_977_000_100, 10_000, 'grok');
    const stub = fetchStub([]);
    const none = await caught(call(createRoutedModel({}, ctx(run.runId, { fetchImpl: stub.fetchImpl }))));
    expect((none as ModelCallError).message).toMatch(/MODEL_ROUTE_NONE.*AGENT_RUN_MODEL_GROK/);
    const ds = { AGENT_RUN_MODEL_GROK: 'deepseek:deepseek-flash', LLM_KEY_DEEPSEEK: 'k' };
    const refused = await caught(call(createRoutedModel(ds, ctx(run.runId, { env: ds, fetchImpl: stub.fetchImpl }))));
    expect((refused as ModelCallError).message).toMatch(/MODEL_ROUTE_REFUSED : DEEPSEEK_MODEL_UNSUPPORTED/);
    const unknown = await caught(call(createRoutedModel(ds, ctx('l8-absent', { env: ds, fetchImpl: stub.fetchImpl }))));
    expect((unknown as ModelCallError).message).toMatch(/MODEL_ROUTE_UNKNOWN_RUN/);
    expect(stub.seen.length).toBe(0);
  });

  it('engineFor : sans AGENT_RUN_MODEL_* le câblage historique est inchangé ; avec, chaque exécution suit son participant', async () => {
    const legacy = engineFor({}, db)('r');
    expect((await legacy.model.complete({ messages: [], tools: [], task_kind: 'answer' })).output.text).toContain('simulée');
    const routes = { AGENT_RUN_MODEL_CLAUDE: 'anthropic:claude-haiku-5-5', AGENT_RUN_MODEL_GROK: 'deepseek:deepseek-flash',
      AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS: '200', AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS: '1000' };
    const claude = await freshRun(db, 'l8e', 1_977_000_200, 10_000, 'claude');
    const grok = await freshRun(db, 'l8e', 1_977_000_200, 10_000, 'grok');
    const vibe = await freshRun(db, 'l8e', 1_977_000_200, 10_000, 'vibe');
    const msg = { messages: [{ role: 'user' as const, content: 'q' }], tools: [], task_kind: 'answer' };
    // claude → Anthropic (secret absent : refus typé de l'adaptateur, preuve du dispatch).
    expect((await caught(engineFor(routes, db)(claude.runId).model.complete(msg)) as Error).message).toMatch(/EXECUTOR_UNAVAILABLE/);
    expect((await caught(engineFor(routes, db)(grok.runId).model.complete(msg)) as Error).message).toMatch(/DEEPSEEK_MODEL_UNSUPPORTED/);
    expect((await caught(engineFor(routes, db)(vibe.runId).model.complete(msg)) as Error).message).toMatch(/MODEL_ROUTE_NONE/);
    // Réglage global historique vers un fournisseur L8 : AGENT_RUN_MODEL n'accepte qu'un gratuit permis.
    expect(() => engineFor({ AGENT_RUN_MODEL: 'gemini:gemini-3.5-flash-lite', LLM_KEY_GEMINI: 'k' }, db)('r'))
      .toThrow(/GEMINI_MODEL_UNSUPPORTED.*AGENT_RUN_MODEL/);
  });
});

describe('CC-7 L8 — chemin gratuit (aucune enveloppe, coût 0)', () => {
  it('registre gratuit daté : Gemini Flash-Lite, Groq gpt-oss-20b, Z.ai glm-4.7-flash, OpenRouter « :free » ; attestation owner + origine cc3-test pour Gemini et Groq', () => {
    expect([...API_FREE_MODELS].sort()).toEqual(['gemini:gemini-3.5-flash-lite', 'gemini:gemini-3.6-flash', 'gemini:gemini-3.8-flash', 'groq:openai/gpt-oss-20b', 'zai:glm-4.7-flash']);
    expect(isFreeApiModel('openrouter:deepseek/deepseek-v4-flash-0731:free')).toBe(true);
    expect(isFreeApiModel('openrouter:deepseek/deepseek-v4-flash-0731')).toBe(false);
    expect(freeAllowed('gemini', GEMINI_FREE_ENV)).toBe(true);
    expect(freeAllowed('gemini', { ...GEMINI_FREE_ENV, PUBLIC_ORIGIN: 'https://github-mcp.example' })).toBe(false);
    expect(freeAllowed('gemini', { ...GEMINI_FREE_ENV, GEMINI_FREE_PROJECT_ATTESTED: 'TRUE' })).toBe(false);
    expect(freeAllowed('groq', {})).toBe(false);
    expect(freeAllowed('zai', {})).toBe(true);
    expect(freeAllowed('openrouter', {})).toBe(true);
  });

  it('Gemini gratuit : appel de fonction lu, coût 0, aucune ligne d’étape ni registre payant', async () => {
    const run = await freshRun(db, 'l8f', 1_977_000_300, 10_000, 'gemini');
    const stub = fetchStub([{ candidates: [{ content: { parts: [{ text: 'pensée', thought: true },
      { functionCall: { id: 'fc1', name: 'store_context', args: { cycle: 'x' } } }] } }],
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 6, thoughtsTokenCount: 4 } }]);
    const out = await call(createProviderModel('gemini:gemini-3.5-flash-lite', 'auto', ctx(run.runId, { env: GEMINI_FREE_ENV, fetchImpl: stub.fetchImpl })));
    expect(out.output).toEqual({ text: '', tool_calls: [{ id: 'fc1', name: 'store_context', args: { cycle: 'x' } }] });
    expect(out.usage).toEqual({ tokens: 50, cost_cents: 0 });
    expect(stub.seen[0].body.generationConfig).toEqual({ maxOutputTokens: 4_096, thinkingConfig: { thinkingLevel: 'minimal' } });
    expect(await stepRow(db, run.runId, 0)).toBeNull();
    expect(await quotaOf(db, 'paid:participant:gemini:cycle:' + run.cycleId)).toBe(0);
  });

  it('OpenRouter « :free » (données jamais conservées) et Z.ai glm-4.7-flash ; secret absent = EXECUTOR_UNAVAILABLE sans appel', async () => {
    const run = await freshRun(db, 'l8f', 1_977_000_400, 10_000, 'vibe');
    const stub = fetchStub([reply('o', { prompt_tokens: 3, completion_tokens: 2 })]);
    const out = await call(createProviderModel('openrouter:deepseek/deepseek-v4-flash-0731:free', 'auto',
      ctx(run.runId, { env: { LLM_KEY_OPENROUTER: 'or-key' }, fetchImpl: stub.fetchImpl })));
    expect(stub.seen[0].url).toBe(OPENROUTER_CHAT_COMPLETIONS_URL);
    expect(stub.seen[0].headers.get('Authorization')).toBe('Bearer or-key');
    expect(stub.seen[0].body).toMatchObject({ model: 'deepseek/deepseek-v4-flash-0731:free', provider: { data_collection: 'deny' } });
    expect(out.usage.cost_cents).toBe(0);
    const empty = fetchStub([]);
    const error = await caught(call(createProviderModel('zai:glm-4.7-flash', 'auto', ctx(run.runId, { fetchImpl: empty.fetchImpl }))));
    expect((error as ModelCallError).message).toMatch(/EXECUTOR_UNAVAILABLE/);
    expect(empty.seen.length).toBe(0);
  });

  it('Groq payant (gpt-oss-120b) : protocole OpenAI, effort de raisonnement bas, enveloppe par participant réglée au réel', async () => {
    // Le contrat commun n'est pas conduit pour Groq : son pire cas (< 1 cent) ne peut dépasser le plafond d'1 cent du contrat.
    const run = await freshRun(db, 'l8f', 1_977_000_450, 10_000, 'grok');
    const stub = fetchStub([reply('q', { prompt_tokens: 1_000, completion_tokens: 1_000 })]);
    const out = await call(createProviderModel('groq:openai/gpt-oss-120b', 'auto', ctx(run.runId, {
      env: { LLM_KEY_GROQ: 'groq-key' }, envelope: FUNDED, fetchImpl: stub.fetchImpl, now: () => new Date('2032-08-01T10:00:00Z') })));
    expect(stub.seen[0].url).toBe(GROQ_CHAT_COMPLETIONS_URL);
    expect(stub.seen[0].body).toMatchObject({ model: 'openai/gpt-oss-120b', reasoning_effort: 'low', max_tokens: 4_096 });
    expect(out.usage.cost_cents).toBe(1);
    expect(await stepRow(db, run.runId, 0)).toEqual({ reserved_cents: 1, actual_cents: 1, settled: 1 });
    expect(await quotaOf(db, 'paid:participant:grok:cycle:' + run.cycleId)).toBe(1);
  });

  it('jamais de bascule silencieuse : gratuit non permis sans tarif = refus ; payant « paid » sans enveloppe = refus avant appel', async () => {
    const run = await freshRun(db, 'l8f', 1_977_000_500, 10_000, 'grok');
    expect(() => createProviderModel('groq:openai/gpt-oss-20b', 'auto', ctx(run.runId, { env: { LLM_KEY_GROQ: 'k' } })))
      .toThrow(/GROQ_MODEL_UNSUPPORTED.*attestation/);
    expect(() => createProviderModel('mistral:large', 'auto', ctx(run.runId))).toThrow(/MODEL_PROVIDER_UNSUPPORTED/);
    expect(() => createProviderModel('gemini:gemini-3.5-flash-lite', 'free', ctx(run.runId, { env: { LLM_KEY_GEMINI: 'k' } })))
      .toThrow(/GEMINI_MODEL_UNSUPPORTED/);
    // Gratuit non attesté mais tarifé : chemin payant, donc enveloppe exigée (0 = refus, aucun appel).
    const stub = fetchStub([]);
    const error = await caught(call(createProviderModel('gemini:gemini-3.5-flash-lite', 'auto',
      ctx(run.runId, { env: { LLM_KEY_GEMINI: 'k' }, fetchImpl: stub.fetchImpl }))));
    expect((error as ModelCallError).message).toMatch(/PAID_ENVELOPE_NOT_FUNDED/);
    expect(stub.seen.length).toBe(0);
  });
});

describe('CC-7 L8 — protocole Gemini', () => {
  it('journal → generateContent : tour model avec functionCall (signature documentée sur le premier), réponses regroupées et nommées', () => {
    const converted = toGeminiContents('S', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'je lis', tool_calls: [
        { id: 'a', name: 'store_context', args: {} }, { id: 'b', name: 'store_delta', args: { since: 3 } }] },
      { role: 'tool', content: '{"ok":1}', tool_call_id: 'a' },
      { role: 'tool', content: '{"ok":2}', tool_call_id: 'b' },
      { role: 'assistant', content: 'fini' },
    ]);
    expect(converted.systemInstruction).toEqual({ parts: [{ text: 'S' }] });
    expect(converted.contents).toEqual([
      { role: 'user', parts: [{ text: 'q' }] },
      { role: 'model', parts: [{ text: 'je lis' },
        { functionCall: { id: 'a', name: 'store_context', args: {} }, thoughtSignature: GEMINI_SKIP_SIGNATURE },
        { functionCall: { id: 'b', name: 'store_delta', args: { since: 3 } } }] },
      { role: 'user', parts: [
        { functionResponse: { id: 'a', name: 'store_context', response: { content: '{"ok":1}' } } },
        { functionResponse: { id: 'b', name: 'store_delta', response: { content: '{"ok":2}' } } }] },
      { role: 'model', parts: [{ text: 'fini' }] },
    ]);
  });

  it('lecture : pensées ignorées, jetons de pensée comptés en sortie, usage absent = null ; modèle invalide refusé', () => {
    expect(readGeminiResponse({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 3 } }))
      .toEqual({ output: { text: 'ab', tool_calls: [] }, input: 5, output_tokens: 5 });
    expect(readGeminiResponse({})).toEqual({ output: { text: '', tool_calls: [] }, input: null, output_tokens: null });
    expect(() => geminiGenerateUrl('../x')).toThrow(/GEMINI_MODEL_UNSUPPORTED/);
  });
});
