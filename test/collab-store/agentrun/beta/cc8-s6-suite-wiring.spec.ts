import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BETA_ADVANCE_MIN_DURATION_S,
  ensureBetaSchema,
  loadBetaTrack,
  openBetaTrack,
  recordBetaExecution,
  type BetaCanaryProof,
} from '../../../../src/collab-store/agentrun/beta';
import { agentRunPass, betaMaintenance } from '../../../../src/collab-store/agentrun/orchestrator';
import { createRoutedModel, type ProviderModelContext } from '../../../../src/collab-store/agentrun';
import { ensureModelChainSchema, ensureModelPolicySchema, loadModelChain } from '../../../../src/collab-store/agentrun/model-policy';
import { executorError } from '../../../../src/collab-store/executors/fetch-timeout';
import { ensureSchema } from '../../../../src/collab-store/store/schema';
import { freshRun } from '../cc7-l2-paid-harness';

// CC-8 S6 (raccordements rev4) : le comptage vient des appels RÉELLEMENT routés
// (createRoutedModel — succès et échec, sondes exclues), la maintenance (avance
// secours → bêta, retour arrière automatique) passe par betaMaintenance et le
// passage du planificateur ; les refus typés attendus (paliers non atteints,
// bêta saine) n’écrivent rien.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const NOW = 1_994_000_000;
const ADVANCE_AT = NOW + BETA_ADVANCE_MIN_DURATION_S + 3600;
const PRIMARY = 'zai:glm-4.7-flash';
const CANDIDATE = 'zai:glm-5.3';
let n = 0;

const pid = () => 'vibe-s6w-' + (++n);

const proof = (hash = 'a'): BetaCanaryProof => ({
  verdict: 'propose', next: 'beta', calls: 20, cycle_id: 'cc8-systeme-unique', report_hash: hash.repeat(64),
});

/** Chaîne v1 posée en une écriture versionnée : primaire + maillon suivi en repli. */
async function seedChain(participant: string): Promise<void> {
  await ensureSchema(db);
  await ensureModelChainSchema(db);
  const snapshot = JSON.stringify([{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
  await db.batch([
    db.prepare("insert into agent_model_chains (participant_id, version, chain_json, updated_at, event_seq) values (?1, 1, ?2, ?3, null) on conflict (participant_id) do update set version = 1, chain_json = excluded.chain_json, updated_at = excluded.updated_at, event_seq = null").bind(participant, snapshot, NOW),
    db.prepare("insert or replace into agent_model_chain_versions (participant_id, version, chain_json, set_by, action, reason, event_seq, at) values (?1, 1, ?2, 'owner:rfkevin', 'set', 'seed test', null, ?3)").bind(participant, snapshot, NOW),
  ]);
}

/** Expose le maillon suivi en secours (suivi v1) sur la chaîne v1 du participant. */
async function exposeSecours(participant: string, hash = 'a'): Promise<void> {
  await openBetaTrack(db, {
    canary: proof(hash), now: NOW, expected_chain_version: 1,
    participant_id: participant, candidate_ref: CANDIDATE,
  });
}

/** Enregistre `count` appels du maillon suivi (les `failures` premiers en échec). */
async function seedExecutions(participant: string, count: number, at: number, failures = 0): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const row = await recordBetaExecution(db, {
      participant_id: participant, ref: CANDIDATE, ok: i >= failures,
      run_id: 's6w-' + participant + '-' + i, at: at + i,
    });
    expect(row.open_track).toBe(true);
  }
}

/** Lignes de comptage d'une référence pour le participant, triées par run. */
async function countedRuns(participant: string, ref = CANDIDATE): Promise<Array<{ run_id: string; ok: number }>> {
  const { results } = await db.prepare(
    'select run_id, ok from agent_model_beta_executions where participant_id = ?1 and ref = ?2 order by run_id',
  ).bind(participant, ref).all<{ run_id: string; ok: number }>();
  return results;
}

const betaStatus = async (participant: string): Promise<string> =>
  (await loadBetaTrack(db, participant, CANDIDATE))!.status;

/** Participant prêt à l'avance : suivi exposé en secours + 20 exécutions de fenêtre. */
async function readyTrack(hash = 'a'): Promise<string> {
  const participant = pid();
  await seedChain(participant);
  await exposeSecours(participant, hash);
  await seedExecutions(participant, 20, NOW + 3600);
  return participant;
}

/** Parcours complet jusqu’à la bêta : fenêtre écoulée, paliers atteints, avance appliquée. */
async function advancedTrack(hash = 'a'): Promise<string> {
  const participant = await readyTrack(hash);
  const result = await betaMaintenance(db, { now: ADVANCE_AT });
  expect(result.advanced).toBeGreaterThanOrEqual(1);
  expect(await betaStatus(participant)).toBe('beta');
  return participant;
}

/** Purge du harnais : participants vibe-s6w-* dans les tables des chaînes et suivis de bêta. */
async function purgeHarness(): Promise<void> {
  await ensureBetaSchema(db);
  await ensureModelChainSchema(db);
  await ensureModelPolicySchema(db);
  await db.batch([
    db.prepare("delete from agent_model_beta where participant_id like 'vibe-s6w-%'"),
    db.prepare("delete from agent_model_beta_executions where participant_id like 'vibe-s6w-%'"),
    db.prepare("delete from agent_model_breaker where participant_id like 'vibe-s6w-%'"),
    db.prepare("delete from agent_model_chains where participant_id like 'vibe-s6w-%'"),
    db.prepare("delete from agent_model_chain_versions where participant_id like 'vibe-s6w-%'"),
  ]);
}

beforeAll(purgeHarness);
afterEach(purgeHarness);

describe('CC-8 S6 suite — maintenance périodique (orchestrateur)', () => {
  it('avance secours → bêta aux paliers atteints : suivi et chaîne exposés', async () => {
    const participant = await readyTrack();
    const result = await betaMaintenance(db, { now: ADVANCE_AT });
    expect(result.advanced).toBe(1);
    expect(result.rolledBack).toBe(0);
    const track = (await loadBetaTrack(db, participant, CANDIDATE))!;
    expect(track.status).toBe('beta');
    expect(track.pre_beta_version).toBe(1);
    const chain = await loadModelChain(db, participant);
    expect(chain!.version).toBe(2);
    expect(chain!.chain.find(item => item.ref === CANDIDATE)!.status).toBe('beta');
  });

  it('paliers non atteints ou bêta saine : refus typés attendus, rien d’écrit', async () => {
    const p1 = pid();
    await seedChain(p1);
    await exposeSecours(p1, 'b');
    await seedExecutions(p1, 19, NOW + 3600);
    const notReady = await betaMaintenance(db, { now: ADVANCE_AT });
    expect(notReady.advanced).toBe(0);
    expect(await betaStatus(p1)).toBe('secours');
    const p2 = await advancedTrack('c');
    await seedExecutions(p2, 5, ADVANCE_AT + 100);
    const healthy = await betaMaintenance(db, { now: ADVANCE_AT + 7200 });
    expect(healthy.rolledBack).toBe(0);
    expect(await betaStatus(p2)).toBe('beta');
  });

  it('retour arrière automatique d’une bêta cassée : instantané d’avant exposition restauré', async () => {
    const participant = await advancedTrack('d');
    await seedExecutions(participant, 5, ADVANCE_AT + 600, 5);
    const result = await betaMaintenance(db, { now: ADVANCE_AT + 7200 });
    expect(result.rolledBack).toBe(1);
    expect(await betaStatus(participant)).toBe('rolled_back');
    const chain = await loadModelChain(db, participant);
    expect(chain!.version).toBe(3);
    expect(chain!.chain.find(item => item.ref === CANDIDATE)!.status).toBe('rollback');
  });

  it('agentRunPass exécute la maintenance bêta dans son passage', async () => {
    const participant = await readyTrack('e');
    const pass = await agentRunPass(db, { AGENT_RUNS_ENABLED: 'true' },
      { now: ADVANCE_AT, deliverer: 's6w-pass', wake: async () => ({ accepted: false, reason: 'none' }) });
    expect(pass.beta?.advanced).toBe(1);
    expect(await betaStatus(participant)).toBe('beta');
  });
});

describe('CC-8 S6 suite — comptage des appels réellement routés (provider)', () => {
  const routes = { LLM_KEY_ZAI: 'fake-test-key' };
  const message = { messages: [{ role: 'user' as const, content: 'ping' }], tools: [], task_kind: 'answer' };

  function routedModel(runId: string, fetchImpl: typeof fetch) {
    const ctx: ProviderModelContext = { env: routes, db, runId,
      envelope: { dayCents: 200, cycleCents: 1_000, dayTokens: 0, dayRequests: 0 },
      schemas: () => [], system: 'test', maxOutputTokens: 4096,
      now: () => new Date(NOW * 1000), fetchImpl };
    return createRoutedModel(routes, ctx);
  }

  /** Routeur branché sur un participant dont le maillon suivi est exposé en secours. */
  async function wiredRun(hash: string): Promise<{ participant: string; runId: string }> {
    const participant = pid();
    await seedChain(participant);
    await exposeSecours(participant, hash);
    await ensureModelPolicySchema(db);
    const run = await freshRun(db, 's6w', NOW, 10_000, participant);
    return { participant, runId: run.runId };
  }

  /** fetch zai : le primaire expire toujours, le maillon suivi répond `candidateContent`. */
  function zaiFetch(candidateContent: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      if (body.model === 'glm-4.7-flash') throw executorError('EXECUTOR_TIMEOUT', 'Fournisseur sans réponse après 60000 ms.');
      if (body.model === 'glm-5.3') return new Response(JSON.stringify({
        choices: [{ message: { content: candidateContent } }], usage: { prompt_tokens: 5, completion_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new Error('modèle inattendu : ' + String(body.model));
    }) as typeof fetch;
  }

  /** fetch zai : primaire ET maillon suivi expirent (échec réel de bout en bout). */
  const zaiFetchAllFail: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    throw executorError('EXECUTOR_TIMEOUT', 'Fournisseur sans réponse après 60000 ms. (' + String(body.model) + ')');
  }) as typeof fetch;

  it('le repli réel sur le maillon suivi compte UNE exécution réussie', async () => {
    const { participant, runId } = await wiredRun('f');
    const result = await routedModel(runId, zaiFetch('repli bêta')).complete(message);
    expect(result.output.text).toBe('repli bêta');
    expect(await countedRuns(participant)).toEqual([{ run_id: runId, ok: 1 }]);
    expect(await countedRuns(participant, PRIMARY)).toEqual([]);
  });

  it('l’échec réel du maillon suivi compte un échec (taux du retour arrière)', async () => {
    const { participant, runId } = await wiredRun('g');
    await expect(routedModel(runId, zaiFetchAllFail).complete(message)).rejects.toThrow();
    expect(await countedRuns(participant)).toEqual([{ run_id: runId, ok: 0 }]);
  });

  it('une sonde ne compte JAMAIS, même en servant le maillon suivi', async () => {
    const { participant, runId } = await wiredRun('h');
    const result = await routedModel(runId, zaiFetch('sonde bêta')).complete({ ...message, task_kind: 'probe' });
    expect(result.output.text).toBe('sonde bêta');
    expect(await countedRuns(participant)).toEqual([]);
    expect(await countedRuns(participant, PRIMARY)).toEqual([]);
  });
});
