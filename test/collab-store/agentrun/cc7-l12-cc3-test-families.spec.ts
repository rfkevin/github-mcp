import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import wranglerRaw from '../../../wrangler.jsonc?raw';
import { ModelCallError, createRoutedModel, participantModelRoute, type ProviderModelContext } from '../../../src/collab-store/agentrun';
import { chooseModel, familyOf, participantPolicy, type BudgetState, type PolicyEnv } from '../../../src/collab-store/agentrun/model-policy';
import { fetchStub, freshRun } from './cc7-l2-paid-harness';

// CC-7 — famille imposée par agent sur cc3-test (décision de Kevin du 2026-10-30) : chaque agent reste
// sur SA famille, jamais sur le modèle gratuit global. Avant ce lot, aucune politique n'était posée sur
// cc3-test et le repli de participantModelRoute envoyait les réponses automatiques de Claude, Grok et
// Vibe vers AGENT_RUN_MODEL (Workers AI glm-4.7-flash), quelle que soit leur famille.
// Les valeurs sont lues dans wrangler.jsonc lui-même : un changement de configuration casse ce test.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const wrangler = JSON.parse(wranglerRaw) as { env: Record<string, { vars: Record<string, string> }> };
const vars = wrangler.env['cc3-test'].vars;
// Binding Workers AI présent comme sur le Worker ; aucune clé LLM_KEY_* (Kevin ne les a pas posées) ni budget payant.
const CC3_TEST: PolicyEnv = { ...vars, AI: {} } as PolicyEnv;
const NO_BUDGET: BudgetState = { day_limit: 0, day_spent: 0, cycle_limit: 0, cycle_spent: 0 };

const ctx = (runId: string, fetchImpl: typeof fetch, now: Date): ProviderModelContext => ({
  env: CC3_TEST, db, runId, envelope: { dayCents: 0, cycleCents: 0, dayTokens: 0, dayRequests: 0 },
  schemas: () => [], system: 'S', maxOutputTokens: 4_096, fetchImpl, now: () => now });

describe('CC-7 — familles imposées sur cc3-test (wrangler.jsonc)', () => {
  it('chaque agent a sa famille et ses modèles, aucun modèle écarté', () => {
    const expected: Record<string, string> = { claude: 'anthropic', grok: 'xai', vibe: 'zai', gpt6: 'openai', gemini: 'google' };
    for (const [pid, family] of Object.entries(expected)) {
      const policy = participantPolicy(CC3_TEST, pid);
      expect(policy, pid).not.toBeNull();
      expect(policy!.family).toBe(family);
      expect(policy!.rejected, pid).toEqual([]);
      expect(policy!.models.length).toBeGreaterThan(0);
      for (const ref of policy!.models) expect(familyOf(ref), ref).toBe(family);
    }
  });

  it('le repli global existe toujours : sans politique, Claude tomberait sur le modèle gratuit Workers AI', () => {
    const withoutPolicy: PolicyEnv = { AGENT_RUN_MODEL: vars.AGENT_RUN_MODEL };
    expect(participantPolicy(withoutPolicy, 'claude')).toBeNull();
    expect(participantModelRoute(withoutPolicy, 'claude')).toEqual({ ref: 'workers-ai:@cf/zai-org/glm-4.7-flash', tier: 'free' });
    expect(familyOf(vars.AGENT_RUN_MODEL)).not.toBe('anthropic');
  });

  it.each(['claude', 'grok', 'gpt6'])('%s : aucune clé ni budget dans sa famille → MODEL_BUDGET_EXHAUSTED, aucun appel', async (pid) => {
    expect(() => chooseModel(CC3_TEST, participantPolicy(CC3_TEST, pid)!, 'answer', NO_BUDGET, null))
      .toThrow(/MODEL_BUDGET_EXHAUSTED|Aucun modèle abordable/);
    const run = await freshRun(db, 'l12-' + pid, 1_979_000_000, 10_000, pid);
    const stub = fetchStub([]);
    const error = await createRoutedModel(CC3_TEST, { ...ctx(run.runId, stub.fetchImpl, new Date('2032-10-01T10:00:00Z')) })
      .complete({ messages: [{ role: 'user', content: 'q' }], tools: [], task_kind: 'answer' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).message).toMatch(/^MODEL_BUDGET_EXHAUSTED : /);
    expect(stub.seen).toEqual([]);
  });

  it('vibe : reste sur un modèle de SA famille (GLM) — le gratuit Workers AI glm-4.7-flash, pas le payant zai sans clé', () => {
    const choice = chooseModel(CC3_TEST, participantPolicy(CC3_TEST, 'vibe')!, 'answer', NO_BUDGET, null);
    expect(choice.ref).toBe('workers-ai:@cf/zai-org/glm-4.7-flash');
    expect(choice.tier).toBe('free');
    expect(familyOf(choice.ref)).toBe('zai');
  });

  it('gemini sans attestation owner : jamais le Gemini gratuit, reste dans SA famille (Gemma Workers AI gratuit)', () => {
    const choice = chooseModel({ ...CC3_TEST, LLM_KEY_GEMINI: 'k' } as PolicyEnv, participantPolicy(CC3_TEST, 'gemini')!, 'answer', NO_BUDGET, null);
    expect(choice.ref).toBe('workers-ai:@cf/google/gemma-4-26b-a4b-it');
    expect(choice.tier).toBe('free');
    expect(familyOf(choice.ref)).toBe('google');
  });

  it('gemini avec clé ET attestation owner (origine cc3-test) : Gemini 3.8 Flash gratuit en premier, coût 0', () => {
    const attested = { ...CC3_TEST, LLM_KEY_GEMINI: 'k', GEMINI_FREE_PROJECT_ATTESTED: 'true' } as PolicyEnv;
    const choice = chooseModel(attested, participantPolicy(attested, 'gemini')!, 'answer', NO_BUDGET, null);
    expect(choice.ref).toBe('gemini:gemini-3.8-flash');
    expect(choice.tier).toBe('free');
    expect(choice.est_step_cents).toBe(0);
  });

  it('gemini : pas dans AGENT_RUN_PARTICIPANTS tant que Kevin ne l’enregistre pas', () => {
    expect(vars.AGENT_RUN_PARTICIPANTS.split(',').map(p => p.trim())).not.toContain('gemini');
  });

  it('gpt6 : politique préparée mais pas de canal API tant que Kevin ne l’ajoute pas à AGENT_RUN_PARTICIPANTS', () => {
    const participants = vars.AGENT_RUN_PARTICIPANTS.split(',').map(p => p.trim());
    expect(participants).toEqual(['claude', 'grok', 'vibe']);
    expect(participants).not.toContain('gpt6');
  });
});
