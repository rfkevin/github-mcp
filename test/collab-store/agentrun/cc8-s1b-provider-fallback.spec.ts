import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoutedModel, type ProviderModelContext } from '../../../src/collab-store/agentrun';
import { GEMINI_CC3_TEST_PUBLIC_ORIGIN } from '../../../src/collab-store/executors/gemini';
import { executorError } from '../../../src/collab-store/executors/fetch-timeout';
import { freshRun } from './cc7-l2-paid-harness';
import { ensureModelPolicySchema } from '../../../src/collab-store/agentrun/model-policy';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const PRIMARY = 'gemini:gemini-3.8-flash';
const BACKUP = 'gemini:gemini-3.6-flash';
const routes = {
  AGENT_RUN_FAMILY_GEMINI: 'google',
  AGENT_RUN_MODELS_GEMINI: PRIMARY + ',' + BACKUP,
  LLM_KEY_GEMINI: 'fake-test-key',
  GEMINI_FREE_PROJECT_ATTESTED: 'true',
  PUBLIC_ORIGIN: GEMINI_CC3_TEST_PUBLIC_ORIGIN,
};
const message = { messages: [{ role: 'user' as const, content: 'ping' }], tools: [], task_kind: 'review' };

function client(runId: string, fetchImpl: typeof fetch) {
  const ctx: ProviderModelContext = {
    env: routes, db, runId, envelope: { dayCents: 0, cycleCents: 0, dayTokens: 0, dayRequests: 0 },
    schemas: () => [], system: 'test', maxOutputTokens: 4096,
    now: () => new Date('2032-11-01T10:00:00Z'), fetchImpl,
  };
  return createRoutedModel(routes, ctx);
}

describe('CC8 S1b — incident Gemini 503, repli pendant le même appel', () => {
  it.each(['503', 'timeout'] as const)('%s sur 3.8 puis réponse 3.6 avec métriques err/ok ; sans repli ce test échoue', async failure => {
    const run = await freshRun(db, 's1b-fallback', 1_983_000_000, 10_000, 'gemini');
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('gemini-3.8-flash')) {
        // Erreur exacte du helper HTTP partagé, ensuite enveloppée par le vrai protocole Gemini.
        if (failure === 'timeout') throw executorError('EXECUTOR_TIMEOUT', 'Fournisseur sans réponse après 60000 ms.');
        return new Response('{"error":{"message":"Service unavailable"}}', { status: 503 });
      }
      if (url.includes('gemini-3.6-flash')) return new Response(JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'repli réussi' }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new Error('Modèle inattendu : ' + url);
    }) as typeof fetch;
    await ensureModelPolicySchema(db);
    const before = await Promise.all([PRIMARY, BACKUP].map(async ref =>
      (await db.prepare('SELECT ok, err FROM agent_model_calls WHERE ref = ?1').bind(ref).first<{ok:number;err:number}>()) ?? {ok:0,err:0}));
    const result = await client(run.runId, fetchImpl).complete(message);
    expect(result.output.text).toBe('repli réussi');
    // Le modèle de secours retourne 12+4=16, mais la première tentative a déjà consommé
    // une estimation d'entrée facturée : l'agrégat de l'étape DOIT inclure les deux.
    expect(result.usage.tokens).toBeGreaterThan(16);
    expect(result.usage.input_tokens).toBe(12);
    expect(result.usage.output_tokens).toBe(4);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('gemini-3.8-flash');
    expect(seen[1]).toContain('gemini-3.6-flash');
    const after = await Promise.all([PRIMARY, BACKUP].map(async ref =>
      (await db.prepare('SELECT ok, err FROM agent_model_calls WHERE ref = ?1').bind(ref).first<{ok:number;err:number}>())!));
    expect(after[0].err - before[0].err).toBe(1);
    expect(after[1].ok - before[1].ok).toBe(1);
    expect((await db.prepare('SELECT status FROM agent_runs WHERE run_id = ?1').bind(run.runId).first<{status:string}>())?.status).not.toBe('failed');
  });
});

// CC-8 S1b-2 : le coupe-circuit (participant × modèle, table agent_model_breaker) persiste en
// base — purger les lignes du participant de test pour que chaque rejeu reparte d’un état
// neutre : sans cela, trois échecs consécutifs cumulés de 3.8 mettraient le maillon en
// pause et écarteraient précisément le repli que cette suite doit prouver.
afterEach(async () => {
  // Assurer la table avant la purge : un test peut échouer avant ensureModelPolicySchema.
  await ensureModelPolicySchema(db);
  await db.prepare('DELETE FROM agent_model_breaker WHERE participant_id = ?1').bind('gemini').run();
});
