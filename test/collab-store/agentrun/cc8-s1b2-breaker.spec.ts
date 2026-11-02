import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutedModel, type ProviderModelContext } from '../../../src/collab-store/agentrun';
import { GEMINI_CC3_TEST_PUBLIC_ORIGIN } from '../../../src/collab-store/executors/gemini';
import { acquireBreakerProbeLease, breakerOpenUntil, ensureModelPolicySchema, recordModelCallWithBreaker } from '../../../src/collab-store/agentrun/model-policy';
import { BREAKER_PAUSE_S, BREAKER_PROBE_LEASE_S, breakerSkipping } from '../../../src/collab-store/agentrun/run-policy';
import { modelFailureKind } from '../../../src/collab-store/agentrun/model-failure';
import { freshRun } from './cc7-l2-paid-harness';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const PRIMARY = 'gemini:gemini-3.8-flash';
const BACKUP = 'gemini:gemini-3.6-flash';
// Participant de test dédié : le coupe-circuit (participant × modèle) ne doit jamais
// toucher les lignes des autres suites (spec fallback S1b), même sur une base partagée.
const PARTICIPANT = 'brk';
const routes = {
  AGENT_RUN_FAMILY_BRK: 'google',
  AGENT_RUN_MODELS_BRK: PRIMARY + ',' + BACKUP,
  LLM_KEY_GEMINI: 'fake-test-key',
  GEMINI_FREE_PROJECT_ATTESTED: 'true',
  PUBLIC_ORIGIN: GEMINI_CC3_TEST_PUBLIC_ORIGIN,
};
const AT = 2_000_000_000;
const message = { messages: [{ role: 'user' as const, content: 'ping' }], tools: [], task_kind: 'review' };
const TRANSIENT = 'Fournisseur sans réponse après 60000 ms.';
const GEMINI_OK = { candidates: [{ content: { role: 'model', parts: [{ text: 'repli réussi' }] } }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 } };

function client(runId: string, fetchImpl: typeof fetch, nowFn: () => number = () => AT * 1000) {
  const ctx: ProviderModelContext = {
    env: routes, db, runId, envelope: { dayCents: 0, cycleCents: 0, dayTokens: 0, dayRequests: 0 },
    schemas: () => [], system: 'test', maxOutputTokens: 4096,
    now: () => new Date(nowFn()), fetchImpl,
  };
  return createRoutedModel(routes, ctx);
}

async function breakerRow(ref: string) {
  return db.prepare('SELECT consecutive_transient_failures, last_failure_at, circuit_open_until, probe_until FROM agent_model_breaker WHERE participant_id = ?1 AND ref = ?2')
    .bind(PARTICIPANT, ref).first<{ consecutive_transient_failures: number; last_failure_at: number | null; circuit_open_until: number; probe_until: number | null }>();
}

/** Trois échecs transitoires consécutifs depuis at : le maillon passe en pause (ouvert à at + 2 + BREAKER_PAUSE_S). */
async function seedTransientFailures(ref: string, at: number) {
  for (let i = 0; i < 3; i++) {
    await recordModelCallWithBreaker(db, PARTICIPANT, ref, { ok: false, at: at + i, latencyMs: 5, error: TRANSIENT });
  }
}

/** fetch de test (D12 #255) : répond OK au maillon de repli okRef, refuse tout autre maillon (refusedLabel dans l'erreur). */
function backupOnlyFetch(seen: string[], okRef: string, refusedLabel: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.includes(okRef)) {
      return new Response(JSON.stringify(GEMINI_OK), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('Modèle ' + refusedLabel + ' appelé : ' + url);
  }) as typeof fetch;
}

describe('CC8 S1b-2 — coupe-circuit participant × modèle (option B, plan seq 1376)', () => {
  beforeEach(async () => {
    // Schéma AVANT purge : sur une base vierge, la table n'existe pas encore au premier rejeu.
    await ensureModelPolicySchema(db);
    await db.prepare('DELETE FROM agent_model_breaker WHERE participant_id = ?1').bind(PARTICIPANT).run();
  });
  afterEach(async () => {
    await ensureModelPolicySchema(db);
    await db.prepare('DELETE FROM agent_model_breaker WHERE participant_id = ?1').bind(PARTICIPANT).run();
  });

  it('trois échecs transitoires consécutifs → pause 30 min ; succès → série à zéro ; cumul global intact', async () => {
    await seedTransientFailures(PRIMARY, AT);
    const row = await breakerRow(PRIMARY);
    expect(row?.consecutive_transient_failures).toBe(3);
    expect(row?.circuit_open_until).toBe(AT + 2 + 1_800);
    const open = await breakerOpenUntil(db, PARTICIPANT, [PRIMARY, BACKUP]);
    expect(open.get(PRIMARY)).toBe(AT + 2 + 1_800);
    expect(open.has(BACKUP)).toBe(false);
    // Succès : reset (pause fermée, série à zéro).
    await recordModelCallWithBreaker(db, PARTICIPANT, PRIMARY, { ok: true, at: AT + 10, latencyMs: 3 });
    const reset = await breakerRow(PRIMARY);
    expect(reset?.consecutive_transient_failures).toBe(0);
    expect(reset?.circuit_open_until).toBe(0);
    // Le registre comptable historique reste exact (3 err puis 1 ok au moins).
    const calls = await db.prepare('SELECT ok, err FROM agent_model_calls WHERE ref = ?1').bind(PRIMARY).first<{ ok: number; err: number }>();
    expect(calls?.err).toBeGreaterThanOrEqual(3);
    expect(calls?.ok).toBeGreaterThanOrEqual(1);
  });

  it('maillon en pause écarté : le repli est servi, le maillon en pause n’est pas appelé', async () => {
    const run = await freshRun(db, 's1b2-brk-b', AT, 10_000, PARTICIPANT);
    await seedTransientFailures(PRIMARY, AT);
    const seen: string[] = [];
    const fetchImpl = backupOnlyFetch(seen, 'gemini-3.6-flash', 'en pause');
    const result = await client(run.runId, fetchImpl).complete(message);
    expect(result.output.text).toBe('repli réussi');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('gemini-3.6-flash');
  });

  it('tous les maillons en pause : CIRCUIT_OPEN transitoire, AUCUN appel', async () => {
    const run = await freshRun(db, 's1b2-brk-c', AT, 10_000, PARTICIPANT);
    await seedTransientFailures(PRIMARY, AT);
    await seedTransientFailures(BACKUP, AT);
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => { seen.push(String(input)); throw new Error('aucun appel attendu'); }) as typeof fetch;
    let thrown: unknown;
    try { await client(run.runId, fetchImpl).complete(message); } catch (error) { thrown = error; }
    expect(seen).toHaveLength(0);
    expect((thrown as Error).message).toContain('CIRCUIT_OPEN');
    expect(modelFailureKind(thrown)).toBe('transient');
  });

  it('sonde (task_kind probe) exemptée : le maillon en pause est re-testé, coupe-circuit inchangé', async () => {
    const run = await freshRun(db, 's1b2-brk-d', AT, 10_000, PARTICIPANT);
    await seedTransientFailures(PRIMARY, AT);
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify(GEMINI_OK), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const result = await client(run.runId, fetchImpl).complete({ ...message, task_kind: 'probe' });
    expect(result.output.text).toBe('repli réussi');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('gemini-3.8-flash'); // la sonde teste bien le maillon en pause
    const row = await breakerRow(PRIMARY);
    expect(row?.consecutive_transient_failures).toBe(3); // exemption : jamais reset ni compté
    expect(row?.circuit_open_until).toBeGreaterThan(0); // pause toujours en cours
  });

  it('échec PERMANENT : cumul seul, le coupe-circuit ne compte jamais', async () => {
    const run = await freshRun(db, 's1b2-brk-e', AT, 10_000, PARTICIPANT);
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ error: { message: 'Bad request' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    let thrown: unknown;
    try { await client(run.runId, fetchImpl).complete(message); } catch (error) { thrown = error; }
    expect(seen).toHaveLength(1); // pas de repli : erreur permanente
    expect(modelFailureKind(thrown)).toBe('permanent');
    expect(await breakerRow(PRIMARY)).toBeNull(); // jamais compté par le coupe-circuit
  });

  it('budget d’étape : décompté entre maillons, arrêt propre transitoire sous le plancher de 30 s', async () => {
    const run = await freshRun(db, 's1b2-brk-f', AT, 10_000, PARTICIPANT);
    let clockMs = AT * 1000;
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      clockMs += 100_000; // le maillon a consommé 100 s (simulés) avant d’échouer
      if (url.includes('gemini-3.8-flash')) {
        return new Response(JSON.stringify({ error: { message: 'Service unavailable' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('le repli ne doit pas être appelé : budget épuisé');
    }) as typeof fetch;
    let thrown: unknown;
    try {
      await client(run.runId, fetchImpl, () => clockMs).complete({ ...message, budget_left_ms: 120_000 });
    } catch (error) { thrown = error; }
    expect(seen).toHaveLength(1); // primaire seul : 120 s − 100 s consommés < plancher 30 s
    expect((thrown as Error).message).toContain('STEP_MODEL_BUDGET_EXHAUSTED');
    expect(modelFailureKind(thrown)).toBe('transient');
  });

  it('concurrence CAS (bloquant 3, D12 #255) : deux échecs simultanés comptent DEUX unités, la série converge', async () => {
    await Promise.all([
      recordModelCallWithBreaker(db, PARTICIPANT, PRIMARY, { ok: false, at: AT, latencyMs: 5, error: TRANSIENT }),
      recordModelCallWithBreaker(db, PARTICIPANT, PRIMARY, { ok: false, at: AT, latencyMs: 5, error: TRANSIENT }),
    ]);
    const row = await breakerRow(PRIMARY);
    expect(row?.consecutive_transient_failures).toBe(2);
    expect(row?.circuit_open_until).toBe(0); // deux échecs : pas encore de pause
  });

  it('bail de sonde post-pause (bloquant 2, D12 #255) : un seul essai à la fois, fenêtre bornée, issue libérée', async () => {
    // Pause EXPIRÉE sur PRIMARY : la ligne reste en ré-qualification (open_until > 0, passée).
    await seedTransientFailures(PRIMARY, AT - 2_000);
    const seeded = await breakerRow(PRIMARY);
    expect(seeded?.circuit_open_until).toBe(AT - 2_000 + 2 + BREAKER_PAUSE_S);
    expect(seeded!.circuit_open_until).toBeLessThan(AT);
    // Premier preneur : bail ; second, même seconde : refusé (single probe).
    expect(await acquireBreakerProbeLease(db, PARTICIPANT, PRIMARY, AT, BREAKER_PROBE_LEASE_S)).toBe(true);
    expect(await acquireBreakerProbeLease(db, PARTICIPANT, PRIMARY, AT, BREAKER_PROBE_LEASE_S)).toBe(false);
    // Écrivain disparu : après la fenêtre, ré-acquérable.
    expect(await acquireBreakerProbeLease(db, PARTICIPANT, PRIMARY, AT + BREAKER_PROBE_LEASE_S + 1, BREAKER_PROBE_LEASE_S)).toBe(true);
    // L'issue de la sonde libère le bail ET remet la série à zéro.
    await recordModelCallWithBreaker(db, PARTICIPANT, PRIMARY, { ok: true, at: AT + BREAKER_PROBE_LEASE_S + 10, latencyMs: 3 });
    const healed = await breakerRow(PRIMARY);
    expect(healed?.consecutive_transient_failures).toBe(0);
    expect(healed?.probe_until).toBe(0);
    expect(breakerSkipping({ circuit_open_until: healed?.circuit_open_until ?? 0 }, AT + BREAKER_PROBE_LEASE_S + 20)).toBe(false);
    // Maillon sain : plus de bail nécessaire (ni écarté, ni en ré-qualification).
    expect(await acquireBreakerProbeLease(db, PARTICIPANT, PRIMARY, AT + BREAKER_PROBE_LEASE_S + 20, BREAKER_PROBE_LEASE_S)).toBe(false);
  });

  it('maillon post-pause dont le bail est tenu par un autre run : écarté, le repli est servi (bloquant 2)', async () => {
    const run = await freshRun(db, 's1b2-brk-g', AT, 10_000, PARTICIPANT);
    await seedTransientFailures(PRIMARY, AT - 2_000);
    expect(await acquireBreakerProbeLease(db, PARTICIPANT, PRIMARY, AT, BREAKER_PROBE_LEASE_S)).toBe(true);
    const seen: string[] = [];
    const fetchImpl = backupOnlyFetch(seen, 'gemini-3.6-flash', 'en ré-qualification');
    const result = await client(run.runId, fetchImpl).complete(message);
    expect(result.output.text).toBe('repli réussi');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('gemini-3.6-flash');
  });
});
