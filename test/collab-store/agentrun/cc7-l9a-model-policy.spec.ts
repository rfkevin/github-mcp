import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ModelCallError, createRoutedModel, type ProviderModelContext } from '../../../src/collab-store/agentrun';
import {
  chooseModel, familyOf, modelCatalog, modelOption, participantEnvelope, participantPolicy, setModelPreference, type BudgetState, type PolicyEnv,
} from '../../../src/collab-store/agentrun/model-policy';
import { ANTHROPIC_MESSAGES_URL } from '../../../src/collab-store/agentrun/anthropic-model';
import { modelEnvOf } from '../../../src/collab-store/mcp/context';
import { GEMINI_CC3_TEST_PUBLIC_ORIGIN } from '../../../src/collab-store/executors/gemini';
import { fetchStub, freshRun } from './cc7-l2-paid-harness';

// CC-7 L9a — choix libre du modèle dans la famille de chaque agent, sous son budget ; catalogue des modèles.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const SONNET = 'anthropic:claude-sonnet-5-5';
const HAIKU = 'anthropic:claude-haiku-5-5';
const CLAUDE: PolicyEnv = { AGENT_RUN_FAMILY_CLAUDE: 'anthropic', AGENT_RUN_MODELS_CLAUDE: SONNET + ',' + HAIKU, LLM_KEY_ANTHROPIC: 'k' };
const budget = (day: number, cycle = 1_000, spent = 0): BudgetState => ({ day_limit: day, day_spent: spent, cycle_limit: cycle, cycle_spent: 0 });
const anthropicReply = (text: string) => ({ content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 10 } });

describe('CC-7 L9a — famille et liste de modèles par agent', () => {
  it('la vraie famille se lit quel que soit le canal : direct, Workers AI, Groq, OpenRouter', () => {
    expect(familyOf(SONNET)).toBe('anthropic');
    expect(familyOf('openrouter:anthropic/claude-opus-5.5')).toBe('anthropic');
    expect(familyOf('openrouter:x-ai/grok-4.7')).toBe('xai');
    expect(familyOf('openrouter:z-ai/glm-5.3')).toBe('zai');
    expect(familyOf('openrouter:deepseek/deepseek-v4-flash-0731:free')).toBe('deepseek');
    expect(familyOf('workers-ai:@cf/zai-org/glm-4.7-flash')).toBe('zai');
    expect(familyOf('workers-ai:@cf/google/gemma-4-26b-a4b-it')).toBe('google');
    expect(familyOf('gemini:gemini-3.6-flash')).toBe('google');
    expect(familyOf('groq:openai/gpt-oss-20b')).toBe('openai');
    expect(familyOf('groq:llama-3.3-70b-versatile')).toBe('meta');
    expect(familyOf('openrouter:inconnu/x')).toBeNull();
    expect(familyOf('sans-deux-points')).toBeNull();
  });

  it('politique : les deux variables exigées ; un modèle d’une autre famille est écarté et signalé, jamais retenu', () => {
    expect(participantPolicy({ AGENT_RUN_MODELS_CLAUDE: SONNET }, 'claude')).toBeNull();
    expect(participantPolicy({ AGENT_RUN_FAMILY_CLAUDE: 'anthropic' }, 'claude')).toBeNull();
    expect(() => participantPolicy({ AGENT_RUN_FAMILY_CLAUDE: 'openai-ish', AGENT_RUN_MODELS_CLAUDE: SONNET }, 'claude')).toThrow(/Famille inconnue/);
    const policy = participantPolicy({ AGENT_RUN_FAMILY_CLAUDE: 'Anthropic',
      AGENT_RUN_MODELS_CLAUDE: SONNET + ', openrouter:anthropic/claude-opus-5.5, zai:glm-5.3, ' + SONNET + ', pas une ref' }, 'claude')!;
    expect(policy.family).toBe('anthropic');
    expect(policy.models).toEqual([SONNET, 'openrouter:anthropic/claude-opus-5.5']);
    expect(policy.rejected).toEqual([{ ref: 'zai:glm-5.3', reason: 'famille zai ≠ anthropic' }, { ref: SONNET, reason: 'doublon' }, { ref: 'pas une ref', reason: 'format' }]);
  });

  it('budget propre à l’agent prioritaire sur l’enveloppe commune ; valeur invalide = 0', () => {
    const common = { AGENT_RUN_PAID_PARTICIPANT_DAY_CENTS: '200', AGENT_RUN_PAID_PARTICIPANT_CYCLE_CENTS: '1000' };
    expect(participantEnvelope(common, 'vibe')).toMatchObject({ dayCents: 200, cycleCents: 1_000 });
    expect(participantEnvelope({ ...common, AGENT_RUN_PAID_DAY_CENTS_VIBE: '50' }, 'vibe')).toMatchObject({ dayCents: 50, cycleCents: 1_000 });
    expect(participantEnvelope({ ...common, AGENT_RUN_PAID_DAY_CENTS_VIBE: '-3' }, 'vibe')).toMatchObject({ dayCents: 0 });
  });
});

describe('CC-7 L9a — choix sous budget', () => {
  const policy = participantPolicy(CLAUDE, 'claude')!;

  it('options : coût d’une étape estimé au tarif daté ; sans clé = indisponible ; gratuit permis = 0', () => {
    expect(modelOption(CLAUDE, SONNET, 'review')).toEqual({ ref: SONNET, tier: 'paid', credential_present: true, est_step_cents: 6 });
    expect(modelOption(CLAUDE, HAIKU, 'review').est_step_cents).toBe(1);
    expect(modelOption({}, SONNET, 'review')).toMatchObject({ tier: 'unavailable', credential_present: false, reason: 'clé absente' });
    const gem = { LLM_KEY_GEMINI: 'k', GEMINI_FREE_PROJECT_ATTESTED: 'true', PUBLIC_ORIGIN: GEMINI_CC3_TEST_PUBLIC_ORIGIN };
    expect(modelOption(gem, 'gemini:gemini-3.5-flash-lite', 'review')).toEqual({ ref: 'gemini:gemini-3.5-flash-lite', tier: 'free', credential_present: true, est_step_cents: 0 });
    expect(modelOption({}, 'openrouter:x-ai/grok-4.7', 'review')).toMatchObject({ tier: 'unavailable', reason: 'ni gratuit permis ni tarif daté' });
  });

  it('défaut : le plus fort abordable pour review, le moins cher pour design ; budget serré = descente ; rien d’abordable = refus', () => {
    expect(chooseModel(CLAUDE, policy, 'review', budget(100), null)).toMatchObject({ ref: SONNET, chosen_by: 'serveur', tier: 'paid', est_step_cents: 6 });
    expect(chooseModel(CLAUDE, policy, 'design', budget(100), null).ref).toBe(HAIKU);
    expect(chooseModel(CLAUDE, policy, 'review', budget(3), null).ref).toBe(HAIKU);
    expect(chooseModel(CLAUDE, policy, 'review', budget(100, 1_000, 98), null).ref).toBe(HAIKU);
    expect(() => chooseModel(CLAUDE, policy, 'review', budget(0), null)).toThrow(/MODEL_BUDGET_EXHAUSTED|Aucun modèle abordable/);
  });

  it('préférence : appliquée si abordable, sinon option suivante journalisée ; un gratuit permis reste toujours abordable', () => {
    expect(chooseModel(CLAUDE, policy, 'design', budget(100), { ref: SONNET, set_by: 'claude' }))
      .toMatchObject({ ref: SONNET, chosen_by: 'claude', reason: 'préférence' });
    const down = chooseModel(CLAUDE, policy, 'review', budget(3), { ref: SONNET, set_by: 'grok' });
    expect(down).toMatchObject({ ref: HAIKU, chosen_by: 'serveur' });
    expect(down.reason).toMatch(/préférence anthropic:claude-sonnet-5-5 non abordable.*option suivante/);
    const vibeEnv: PolicyEnv = { AGENT_RUN_FAMILY_VIBE: 'zai', AGENT_RUN_MODELS_VIBE: 'zai:glm-5.3,zai:glm-4.7-flash', LLM_KEY_ZAI: 'k' };
    expect(chooseModel(vibeEnv, participantPolicy(vibeEnv, 'vibe')!, 'review', budget(0), null)).toMatchObject({ ref: 'zai:glm-4.7-flash', tier: 'free', est_step_cents: 0 });
  });

  it('préférence posée par l’agent pour lui-même ou par un coordinateur ; modèle hors liste refusé ; retrait', async () => {
    const at = 1_978_000_000;
    const base = { cycleId: 'l9a-cycle', participantId: 'claude', now: at };
    expect(await setModelPreference(db, CLAUDE, { ...base, actor: 'claude', actorIsCoordinator: false, ref: SONNET, reason: 'relecture sécurité' }))
      .toEqual({ status: 'set', ref: SONNET, task_id: '' });
    await expect(setModelPreference(db, CLAUDE, { ...base, actor: 'grok', actorIsCoordinator: false, ref: HAIKU })).rejects.toThrow(/MODEL_CHOICE_FORBIDDEN|Seul l’agent/);
    expect(await setModelPreference(db, CLAUDE, { ...base, actor: 'grok', actorIsCoordinator: true, taskId: 'L9', ref: HAIKU }))
      .toEqual({ status: 'set', ref: HAIKU, task_id: 'L9' });
    await expect(setModelPreference(db, CLAUDE, { ...base, actor: 'claude', actorIsCoordinator: false, ref: 'zai:glm-5.3' })).rejects.toThrow(/n’est pas dans les modèles autorisés/);
    expect(await setModelPreference(db, CLAUDE, { ...base, actor: 'claude', actorIsCoordinator: false, taskId: 'L9', ref: null }))
      .toEqual({ status: 'cleared', ref: null, task_id: 'L9' });
  });
});

describe('CC-7 L9a — aiguillage par étape et catalogue', () => {
  const ctx = (runId: string, fetchImpl: typeof fetch, now: Date): ProviderModelContext => ({
    env: {}, db, runId, envelope: { dayCents: 0, cycleCents: 0, dayTokens: 0, dayRequests: 0 },
    schemas: () => [], system: 'S', maxOutputTokens: 4_096, fetchImpl, now: () => now });

  it('chaque étape : choix serveur dans la famille sous le budget de l’agent, journalisé ; disponibilité mesurée', async () => {
    const routes: PolicyEnv = { ...CLAUDE, AGENT_RUN_PAID_DAY_CENTS_CLAUDE: '3', AGENT_RUN_PAID_CYCLE_CENTS_CLAUDE: '100' };
    const run = await freshRun(db, 'l9a', 1_978_000_100, 10_000, 'claude');
    const stub = fetchStub([anthropicReply('léger'), anthropicReply('fort')]);
    const now = new Date('2032-09-01T10:00:00Z');
    const model = createRoutedModel(routes, { ...ctx(run.runId, stub.fetchImpl, now), env: routes });
    const first = await model.complete({ messages: [{ role: 'user', content: 'q' }], tools: [], task_kind: 'review' });
    expect(first.output.text).toBe('léger');
    expect(stub.seen[0].url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(stub.seen[0].body.model).toBe('claude-haiku-5-5');
    const choice = await db.prepare('SELECT ref, chosen_by, reason FROM agent_model_choices WHERE run_id = ?1 AND n = 0').bind(run.runId)
      .first<{ ref: string; chosen_by: string; reason: string }>();
    expect(choice).toMatchObject({ ref: HAIKU, chosen_by: 'serveur' });
    const calls = await db.prepare('SELECT ok, err FROM agent_model_calls WHERE ref = ?1').bind(HAIKU).first<{ ok: number; err: number }>();
    expect(calls!.ok).toBeGreaterThanOrEqual(1);
    // Le coordinateur impose Sonnet ; le budget de l'agent (3 c/jour) ne le permet pas : descente journalisée.
    await setModelPreference(db, routes, { actor: 'grok', actorIsCoordinator: true, cycleId: run.cycleId, participantId: 'claude', ref: SONNET, now: 1 });
    await db.prepare('UPDATE agent_runs SET steps_done = 1 WHERE run_id = ?1').bind(run.runId).run();
    await model.complete({ messages: [{ role: 'user', content: 'q' }], tools: [], task_kind: 'review' });
    expect(stub.seen[1].body.model).toBe('claude-haiku-5-5');
    const second = await db.prepare('SELECT reason FROM agent_model_choices WHERE run_id = ?1 AND n = 1').bind(run.runId).first<{ reason: string }>();
    expect(second!.reason).toMatch(/non abordable/);
  });

  it('budget à 0 sans gratuit dans la famille : MODEL_BUDGET_EXHAUSTED, aucun appel', async () => {
    const run = await freshRun(db, 'l9a', 1_978_000_200, 10_000, 'claude');
    const stub = fetchStub([]);
    const error = await createRoutedModel(CLAUDE, { ...ctx(run.runId, stub.fetchImpl, new Date('2032-09-02T10:00:00Z')), env: CLAUDE })
      .complete({ messages: [], tools: [], task_kind: 'review' }).catch(e => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).message).toMatch(/^MODEL_BUDGET_EXHAUSTED : /);
    expect(stub.seen.length).toBe(0);
  });

  it('catalogue : familles, gratuit / payant, clé présente sans valeur, tarif daté et périmé, défaut par type, refus', async () => {
    const raw = { AGENT_RUN_PARTICIPANTS: 'claude,vibe,grok', ...CLAUDE, LLM_KEY_ANTHROPIC: 'sk-ant-CANARY-SECRET',
      AGENT_RUN_PAID_DAY_CENTS_CLAUDE: '100', AGENT_RUN_PAID_CYCLE_CENTS_CLAUDE: '500',
      AGENT_RUN_MODEL_VIBE: 'zai:glm-4.7-flash', LLM_KEY_ZAI: 'zai-CANARY', AGENT_RUN_FAMILY_GROK: 'xai', AGENT_RUN_MODELS_GROK: 'anthropic:claude-haiku-5-5' };
    const view = modelEnvOf(raw);
    expect(JSON.stringify(view)).not.toMatch(/CANARY/);
    const agents = await modelCatalog(db, view, { cycleId: 'l9a-cycle', now: new Date('2026-12-15T00:00:00Z') });
    expect(JSON.stringify(agents)).not.toMatch(/CANARY/);
    const claude = agents.find(a => a.participant_id === 'claude')!;
    expect(claude).toMatchObject({ mode: 'policy', family: 'anthropic', budget: { day_limit: 100, cycle_limit: 500 } });
    expect(claude.models.map(m => [m.ref, m.tier, m.credential_present, m.rate?.as_of, m.rate?.stale]))
      .toEqual([[SONNET, 'paid', true, '2026-10-25', true], [HAIKU, 'paid', true, '2026-10-25', true]]);
    expect(claude.default_by_kind).toMatchObject({ review: SONNET, design: HAIKU });
    expect(claude.preferences).toEqual([expect.objectContaining({ task_id: '', ref: SONNET, set_by: 'claude' })]);
    const vibe = agents.find(a => a.participant_id === 'vibe')!;
    expect(vibe).toMatchObject({ mode: 'single', family: 'zai', default_ref: 'zai:glm-4.7-flash' });
    expect(vibe.models[0]).toMatchObject({ tier: 'free', credential_present: true, est_step_cents: 0 });
    const grok = agents.find(a => a.participant_id === 'grok')!;
    expect(grok).toMatchObject({ mode: 'policy', family: 'xai', models: [] });
    expect(grok.rejected).toEqual([{ ref: 'anthropic:claude-haiku-5-5', reason: 'famille anthropic ≠ xai' }]);
    expect(grok.default_by_kind.review).toBeNull();
  });
});
