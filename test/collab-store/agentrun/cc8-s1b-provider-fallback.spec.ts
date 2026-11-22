import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoutedModel, type ProviderModelContext } from '../../../src/collab-store/agentrun';
import { GEMINI_CC3_TEST_PUBLIC_ORIGIN } from '../../../src/collab-store/executors/gemini';
import { executorError } from '../../../src/collab-store/executors/fetch-timeout';
import { modelFailureKind } from '../../../src/collab-store/agentrun/model-failure';
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
// CC8 primary-retry-quality (mandat seq 3170) : kind answer = repli intra-étape conservé
// (basse enjeu) ; les kinds forts (implement/review/test) sont couverts par le test
// PREFERRED_TRANSIENT_BACKOFF en fin de suite.
const message = { messages: [{ role: 'user' as const, content: 'ping' }], tools: [], task_kind: 'answer' };

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
  it.each([401,403])('keeps a fallback HTTP %i authentication refusal permanent after primary 503',async(status)=>{
    const run=await freshRun(db, 's1b-fallback-auth-'+status, 1_983_100_000, 10_000, 'gemini');
    const seen:string[]=[];
    const fetchImpl=(async(input: RequestInfo | URL)=>{
      const url=String(input);seen.push(url);
      return url.includes('gemini-3.8-flash')
        ? new Response('{"error":{"message":"unavailable"}}',{status:503})
        : new Response('{"error":{"message":"unauthorized"}}',{status});
    }) as typeof fetch;
    let caught:unknown;
    try{await client(run.runId,fetchImpl).complete(message);}catch(error){caught=error;}
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain('FALLBACK_AFTER_TRANSIENT');
    expect(modelFailureKind(caught)).toBe('permanent');
    expect(seen).toHaveLength(2);
  });
  it('retry primary when transient primary then permanently incompatible fallback, without bypassing cost policy',async()=>{
    const run = await freshRun(db, 's1b-primary-fallback-bad', 1_983_100_000, 10_000, 'gemini');
    const seen: string[]=[];
    const fetchImpl = (async(input: RequestInfo | URL)=>{
      const url=String(input);seen.push(url);
      if(url.includes('gemini-3.8-flash')) return new Response('{"error":{"message":"unavailable"}}',{status:503});
      if(url.includes('gemini-3.6-flash')) return new Response('{"error":{"message":"invalid tool schema"}}',{status:400});
      throw Error('unexpected model');
    }) as typeof fetch;
    let caught:unknown;
    try{await client(run.runId,fetchImpl).complete(message);}catch(error){caught=error;}
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('FALLBACK_AFTER_TRANSIENT');
    expect(modelFailureKind(caught)).toBe('transient');
    expect(seen).toHaveLength(2);
  });

  // CC8 primary-retry-quality (mandat seq 3170) : kinds forts (implement/review/test) —
  // un échec TRANSITOIRE du maillon préféré ne parcourt PAS la chaîne de repli : le moteur
  // relance durablement le même maillon (model_retry). Le transitoire reste compté par le
  // coupe-circuit S1b-2 : l’écart durable suit la pause ou la chaîne posée par l’owner.
  it.each(['implement', 'review', 'test'] as const)('%s : 503 du maillon préféré → PREFERRED_TRANSIENT_BACKOFF transitoire, repli non appelé, breaker compté', async kind => {
    const run = await freshRun(db, 's1b-strong-retry-' + kind, 1_983_200_000, 10_000, 'gemini');
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      return new Response('{"error":{"message":"Service unavailable"}}', { status: 503 });
    }) as typeof fetch;
    await ensureModelPolicySchema(db);
    let caught: unknown;
    try { await client(run.runId, fetchImpl).complete({ ...message, task_kind: kind }); } catch (error) { caught = error; }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('gemini-3.8-flash');
    expect((caught as Error).message).toContain('PREFERRED_TRANSIENT_BACKOFF');
    expect(modelFailureKind(caught)).toBe('transient');
    const row = await db.prepare('SELECT consecutive_transient_failures FROM agent_model_breaker WHERE participant_id = ?1 AND ref = ?2')
      .bind('gemini', PRIMARY).first<{ consecutive_transient_failures: number }>();
    expect(row?.consecutive_transient_failures).toBe(1);
  });

  // CC8 post-365 (seq 3192 #1, tâche cc8-post365-provider-retry-tests) : un refus PERMANENT
  // (401/403) sur le maillon PRÉFÉRÉ d’un kind fort fait UN SEUL appel, sans
  // PREFERRED_TRANSIENT_BACKOFF : une panne permanente ne devient pas une boucle de relance
  // et ne déclenche aucun repli (le gate ne vise que le transitoire).
  it.each([401, 403] as const)('%i permanent sur le maillon préféré, kind fort : UN appel, classé permanent, sans PREFERRED_TRANSIENT_BACKOFF', async status => {
    const run = await freshRun(db, 's1b-strong-perm-' + status, 1_983_300_000, 10_000, 'gemini');
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response('{"error":{"message":"denied"}}', { status });
    }) as typeof fetch;
    await ensureModelPolicySchema(db);
    let caught: unknown;
    try { await client(run.runId, fetchImpl).complete({ ...message, task_kind: 'review' }); } catch (error) { caught = error; }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('gemini-3.8-flash');
    expect((caught as Error).message).not.toContain('PREFERRED_TRANSIENT_BACKOFF');
    expect((caught as Error).message).not.toContain('gemini-3.6-flash');
    expect(modelFailureKind(caught)).toBe('permanent');
  });

  // CC8 post-365 (seq 3192 #2, AC 1 de la tâche) : panne transitoire PERSISTANTE d’un kind
  // fort — chaque tentative relance le maillon PRÉFÉRÉ (throw PREFERRED_TRANSIENT_BACKOFF,
  // reprise = même étape), le coupe-circuit S1b-2 compte 1 puis 2 puis 3 → pause ; l’appel
  // suivant est servi par le repli de la chaîne owner, le préféré n’est PAS rappelé.
  it('implement : panne persistante du préféré → 3 relances transitoires, pause breaker, puis repli servi sans rappeler le préféré', async () => {
    const run = await freshRun(db, 's1b-strong-persistent', 1_983_400_000, 10_000, 'gemini');
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('gemini-3.8-flash')) return new Response('{"error":{"message":"Service unavailable"}}', { status: 503 });
      return new Response(JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'repli après pause' }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    await ensureModelPolicySchema(db);
    const routed = client(run.runId, fetchImpl);
    for (let attempt = 1; attempt <= 3; attempt++) {
      let caught: unknown;
      try { await routed.complete({ ...message, task_kind: 'implement' }); } catch (error) { caught = error; }
      expect((caught as Error).message).toContain('PREFERRED_TRANSIENT_BACKOFF');
      expect(modelFailureKind(caught)).toBe('transient'); // relance durable du mêtre maillon
      expect(seen).toHaveLength(attempt); // strictement un appel par tentative, jamais le repli
      const row = await db.prepare('SELECT consecutive_transient_failures, circuit_open_until FROM agent_model_breaker WHERE participant_id = ?1 AND ref = ?2')
        .bind('gemini', PRIMARY).first<{ consecutive_transient_failures: number; circuit_open_until: number }>();
      expect(row?.consecutive_transient_failures).toBe(attempt);
      if (attempt === 3) expect(row?.circuit_open_until).toBeGreaterThan(0); // 3 échecs → pause
      else expect(row?.circuit_open_until).toBe(0);
    }
    // Coupe-circuit ouvert : l’étape est servie par le repli owner, le préféré n’est pas rappelé.
    const served = await routed.complete({ ...message, task_kind: 'implement' });
    expect(served.output.text).toBe('repli après pause');
    expect(seen).toHaveLength(4);
    expect(seen[3]).toContain('gemini-3.6-flash');
    const paused = await db.prepare('SELECT consecutive_transient_failures, circuit_open_until FROM agent_model_breaker WHERE participant_id = ?1 AND ref = ?2')
      .bind('gemini', PRIMARY).first<{ consecutive_transient_failures: number; circuit_open_until: number }>();
    expect(paused?.consecutive_transient_failures).toBe(3); // inchangé : pas de rappel du préféré
    expect(paused?.circuit_open_until).toBeGreaterThan(0);
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
