import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createReadToolHost, createRoutedModel, ToolRefused, type ProviderModelContext } from '../../../src/collab-store/agentrun';
import { defaultEffort, effortMaxTokens, effortOptions, effortsDownFrom, effortSupported } from '../../../src/collab-store/agentrun/effort';
import { chooseModel, participantPolicy, setModelPreference, type BudgetState, type PolicyEnv } from '../../../src/collab-store/agentrun/model-policy';
import { createModelChoiceTools } from '../../../src/collab-store/agentrun/model-choice-tools';
import { apiModelRate } from '../../../src/collab-store/executors/model-rates';
import { resolveEffectiveMaxTokens } from '../../../src/collab-store/executors/task-profiles';
import { XAI_CHAT_COMPLETIONS_URL, ZAI_CHAT_COMPLETIONS_URL } from '../../../src/collab-store/executors/openai-compatible';
import { fetchStub, freshRun, reply } from './cc7-l2-paid-harness';

// CC-7 L9b — niveaux de réflexion traduits par fournisseur, choisis par l'agent, le coordinateur ou par défaut,
// sous le budget de l'agent ; tarif daté d'Opus 5.5 ; outil store_choose_model des agents API.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const OPUS = 'anthropic:claude-opus-5-5';
const HAIKU = 'anthropic:claude-haiku-5-5';
const CLAUDE: PolicyEnv = { AGENT_RUN_FAMILY_CLAUDE: 'anthropic', AGENT_RUN_MODELS_CLAUDE: OPUS + ',' + HAIKU, LLM_KEY_ANTHROPIC: 'k' };
const budget = (day: number): BudgetState => ({ day_limit: day, day_spent: 0, cycle_limit: 10_000, cycle_spent: 0 });
const anthropicReply = (text: string) => ({ content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 10 } });
const ctx = (runId: string, fetchImpl: typeof fetch, routes: PolicyEnv): ProviderModelContext => ({
  env: routes, db, runId, envelope: { dayCents: 0, cycleCents: 0, dayTokens: 0, dayRequests: 0 },
  schemas: () => [], system: 'S', maxOutputTokens: 4_096, fetchImpl, now: () => new Date('2032-10-01T10:00:00Z'),
  // Comme engineFor : plafond de sortie par type de tâche (review = 2048), relevé ensuite par la réflexion.
  maxOutputTokensFor: kind => resolveEffectiveMaxTokens({ task_kind: kind }) });

describe('CC-7 L9b — traduction par fournisseur', () => {
  it('Anthropic adaptatif + effort ; xAI reasoning_effort (grok-4.5 à 4.9 seulement) ; Groq / OpenRouter plafonnés à high ; Z.ai on/off ; Gemini thinkingLevel', () => {
    expect(effortOptions(OPUS, 'xhigh')).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } });
    expect(effortOptions('xai:grok-4.7', 'xhigh')).toEqual({ reasoning_effort: 'xhigh' });
    expect(effortOptions('xai:grok-4.20-0309-non-reasoning', 'high')).toBeNull();
    expect(effortOptions('xai:grok-build-0.1', 'high')).toBeNull();
    expect(effortOptions('groq:openai/gpt-oss-120b', 'xhigh')).toEqual({ reasoning_effort: 'high' });
    expect(effortOptions('groq:llama-3.3-70b-versatile', 'high')).toBeNull();
    expect(effortOptions('openrouter:anthropic/claude-opus-5.5', 'xhigh')).toEqual({ reasoning: { effort: 'high' } });
    expect(effortOptions('zai:glm-4.7-flash', 'low')).toEqual({ thinking: { type: 'disabled' } });
    expect(effortOptions('zai:glm-4.7-flash', 'high')).toEqual({ thinking: { type: 'enabled' } });
    expect(effortOptions('zai:glm-5.3', 'high')).toBeNull();
    expect(['low', 'medium', 'high', 'xhigh'].map(e => effortOptions('gemini:gemini-3.6-flash', e as 'low')))
      .toEqual([{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, { thinkingLevel: 'medium' }, { thinkingLevel: 'high' }]);
    expect(effortSupported('workers-ai:@cf/zai-org/glm-4.7-flash')).toBe(false);
    expect(effortSupported('deepseek:deepseek-flash')).toBe(false);
  });

  it('défauts par type de tâche, descente des niveaux, plafond de sortie relevé et borné à 8192 ; Opus 5.5 tarifé', () => {
    expect(['review', 'test', 'implement', 'design', 'answer'].map(defaultEffort)).toEqual(['high', 'high', 'medium', 'medium', 'low']);
    expect(effortsDownFrom('high')).toEqual(['high', 'medium', 'low']);
    expect([effortMaxTokens(2_048, 'low'), effortMaxTokens(2_048, 'high'), effortMaxTokens(4_096, 'xhigh'), effortMaxTokens(2_048, null)])
      .toEqual([2_048, 4_096, 8_192, 2_048]);
    expect(apiModelRate(OPUS)).toMatchObject({ input_per_m: 400, output_per_m: 2_000, as_of: '2026-10-27' });
    expect(apiModelRate('anthropic:claude-fable-5-1')).toMatchObject({ input_per_m: 1_000, output_per_m: 5_000, as_of: '2026-10-27' });
  });
});

describe('CC-7 L9b — choix sous budget', () => {
  const policy = participantPolicy(CLAUDE, 'claude')!;

  it('réflexion demandée tenue si abordable ; sinon niveau plus léger du même modèle avant le modèle suivant, journalisé', () => {
    // Opus review : high = 6,4 + 8,192 → 15 c ; medium → 13 c ; low → 11 c ; Haiku high → 1 c.
    expect(chooseModel(CLAUDE, policy, 'review', budget(100), null)).toMatchObject({ ref: OPUS, effort: 'high', est_step_cents: 15 });
    const lighter = chooseModel(CLAUDE, policy, 'review', budget(13), null);
    expect(lighter).toMatchObject({ ref: OPUS, effort: 'medium', est_step_cents: 13 });
    expect(lighter.reason).toMatch(/réflexion medium au lieu de high \(budget\)/);
    expect(chooseModel(CLAUDE, policy, 'review', budget(10), null)).toMatchObject({ ref: HAIKU, effort: 'high' });
    expect(chooseModel(CLAUDE, policy, 'review', budget(100), { ref: OPUS, set_by: 'grok', effort: 'xhigh' }))
      .toMatchObject({ ref: OPUS, effort: 'xhigh', chosen_by: 'grok', reason: 'préférence' });
  });

  it('préférence sortie de la liste : ignorée ET journalisée (note de Vibe sur L9a) ; niveau invalide refusé', async () => {
    const ignored = chooseModel(CLAUDE, policy, 'design', budget(100), { ref: 'anthropic:claude-sonnet-5-5', set_by: 'claude' });
    expect(ignored.ref).toBe(HAIKU);
    expect(ignored.reason).toMatch(/^préférence anthropic:claude-sonnet-5-5 hors liste ignorée ; défaut/);
    await expect(setModelPreference(db, CLAUDE, { actor: 'claude', actorIsCoordinator: false, cycleId: 'l9b-c', participantId: 'claude',
      ref: OPUS, effort: 'ultra', now: 1 })).rejects.toThrow(/Niveau de réflexion invalide/);
    expect(await setModelPreference(db, CLAUDE, { actor: 'claude', actorIsCoordinator: false, cycleId: 'l9b-c', participantId: 'claude',
      ref: OPUS, effort: 'xhigh', now: 1 })).toEqual({ status: 'set', ref: OPUS, task_id: '', effort: 'xhigh' });
  });
});

describe('CC-7 L9b — corps envoyés et outil des agents API', () => {
  it('Anthropic : adaptatif + effort et plafond relevé ; xAI grok-4.7 : reasoning_effort ; Z.ai glm-4.7-flash : réflexion activée', async () => {
    const routes: PolicyEnv = { ...CLAUDE, AGENT_RUN_PAID_DAY_CENTS_CLAUDE: '100', AGENT_RUN_PAID_CYCLE_CENTS_CLAUDE: '1000',
      AGENT_RUN_FAMILY_GROK: 'xai', AGENT_RUN_MODELS_GROK: 'xai:grok-4.7', LLM_KEY_XAI: 'x',
      AGENT_RUN_PAID_DAY_CENTS_GROK: '100', AGENT_RUN_PAID_CYCLE_CENTS_GROK: '1000',
      AGENT_RUN_FAMILY_VIBE: 'zai', AGENT_RUN_MODELS_VIBE: 'zai:glm-4.7-flash', LLM_KEY_ZAI: 'z' };
    const claude = await freshRun(db, 'l9b', 1_979_000_000, 10_000, 'claude');
    const grok = await freshRun(db, 'l9b', 1_979_000_000, 10_000, 'grok');
    const vibe = await freshRun(db, 'l9b', 1_979_000_000, 10_000, 'vibe');
    const stub = fetchStub([anthropicReply('a'), reply('x', { prompt_tokens: 10, completion_tokens: 5 }), reply('z', { prompt_tokens: 10, completion_tokens: 5 })]);
    const step = { messages: [{ role: 'user' as const, content: 'q' }], tools: [], task_kind: 'review' };
    await createRoutedModel(routes, ctx(claude.runId, stub.fetchImpl, routes)).complete(step);
    await createRoutedModel(routes, ctx(grok.runId, stub.fetchImpl, routes)).complete(step);
    await createRoutedModel(routes, ctx(vibe.runId, stub.fetchImpl, routes)).complete(step);
    expect(stub.seen[0].body).toMatchObject({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, max_tokens: 4_096 });
    expect(stub.seen[1].url).toBe(XAI_CHAT_COMPLETIONS_URL);
    expect(stub.seen[1].body).toMatchObject({ model: 'grok-4.7', reasoning_effort: 'high', max_tokens: 4_096 });
    expect(stub.seen[2].url).toBe(ZAI_CHAT_COMPLETIONS_URL);
    expect(stub.seen[2].body).toMatchObject({ model: 'glm-4.7-flash', thinking: { type: 'enabled' } });
    const logged = await db.prepare('SELECT effort FROM agent_model_choices WHERE run_id = ?1 AND n = 0').bind(claude.runId).first<{ effort: string }>();
    expect(logged).toEqual({ effort: 'high' });
  });

  it('store_choose_model : l’agent choisit pour SA tâche dans SA liste ; hors liste refusé ; proposé seulement avec l’aiguillage', async () => {
    const run = await freshRun(db, 'l9b', 1_979_000_100, 10_000, 'claude');
    const tools = createModelChoiceTools(db, CLAUDE, () => 2);
    expect(await tools.execute({ id: 'c', name: 'store_choose_model', args: { ref: OPUS, effort: 'xhigh', reason: 'lot critique' } }, { run_id: run.runId }))
      .toEqual({ status: 'set', ref: OPUS, task_id: 'l9b', effort: 'xhigh' });
    const pref = await db.prepare('SELECT set_by, effort FROM agent_model_prefs WHERE cycle_id = ?1 AND participant_id = ?2 AND task_id = ?3')
      .bind(run.cycleId, 'claude', 'l9b').first();
    expect(pref).toEqual({ set_by: 'claude', effort: 'xhigh' });
    await expect(tools.execute({ id: 'c', name: 'store_choose_model', args: { ref: 'xai:grok-4.7' } }, { run_id: run.runId }))
      .rejects.toBeInstanceOf(ToolRefused);
    await expect(tools.execute({ id: 'c', name: 'store_choose_model', args: { ref: OPUS } }, { run_id: 'absent' })).rejects.toThrow(/unknown_run/);
    const host = createReadToolHost({ db, repository: null, github: null, storeWrites: true, modelChoice: CLAUDE });
    expect(host.list('review')).toContain('store_choose_model');
    expect(host.spec('review', 'store_choose_model')).toEqual({ name: 'store_choose_model', effect: 'write' });
    expect(createReadToolHost({ db, repository: null, github: null, storeWrites: true }).list('review')).not.toContain('store_choose_model');
  });
});
