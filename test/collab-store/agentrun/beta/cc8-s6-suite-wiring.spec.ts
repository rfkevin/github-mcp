import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BETA_ADVANCE_MIN_DURATION_S,
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
const proof = (hash = 'a'): BetaCanaryProof =>
  ({ cycle_id: 'cc8-systeme-unique', report_hash: hash.repeat(64), calls: 20, verdict: 'propose', next: 'beta' });

async function seedChain(participant: string): Promise<void> {
  await ensureSchema(db);
  await ensureModelChainSchema(db);
  const chainJson = JSON.stringify([{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
  await db.batch([
    db.prepare([
      'INSERT INTO agent_model_chains (participant_id, version, chain_json, updated_at, event_seq) VALUES (?1, ?2, ?3, ?4, NULL)',
      'ON CONFLICT(participant_id) DO UPDATE SET version = excluded.version, chain_json = excluded.chain_json,',
      '  updated_at = excluded.updated_at, event_seq = NULL',
    ].join(' ')).bind(participant, 1, chainJson, NOW),
    db.prepare([
      'INSERT OR REPLACE INTO agent_model_chain_versions (participant_id, version, chain_json, set_by, action, reason, event_seq, at)',
      "VALUES (?1, ?2, ?3, 'owner:rfkevin', 'set', 'seed test', NULL, ?4)",
    ].join(' ')).bind(participant, 1, chainJson, NOW),
  ]);
}

async function openTrack(participant: string, hash = 'a'): Promise<void> {
  await openBetaTrack(db, { participant_id: participant, candidate_ref: CANDIDATE,
    canary: proof(hash), expected_chain_version: 1, now: NOW });
}

async function executions(participant: string, count: number, at: number, failures = 0): Promise<void> {
  for (let i = 0; i < count; i++) {
    const row = await recordBetaExecution(db, { participant_id: participant, ref: CANDIDATE,
      run_id: 's6w-seed-' + (++n), at: at + i, ok: i >= failures });
    expect(row.open_track).toBe(true);
  }
}

async function betaRows(participant: string, ref = CANDIDATE): Promise<Array<{ run_id: string; ok: number }>> {
  const { results } = await db.prepare('SELECT run_id, ok FROM agent_model_beta_executions WHERE participant_id = ?1 AND ref = ?2')
    .bind(participant, ref).all<{ run_id: string; ok: number }>();
  return results;
}

/** Parcours complet jusqu’à la bêta : chaîne v2 exposée, suivi statut beta. */
async function advancedTrack(hash = 'a'): Promise<string> {
  const participant = pid();
  await seedChain(participant);
  await openTrack(participant, hash);
  await executions(participant, 20, NOW + 3600);
  const result = await betaMaintenance(db, { now: ADVANCE_AT });
  expect(result.advanced).toBeGreaterThanOrEqual(1);
  expect((await loadBetaTrack(db, participant, CANDIDATE))!.status).toBe('beta');
  return participant;
}

beforeAll(async () => {
  await ensureModelChainSchema(db);
  await db.prepare("DELETE FROM agent_model_beta WHERE participant_id LIKE 'vibe-s6%'").run();
  await db.prepare("DELETE FROM agent_model_beta_executions WHERE participant_id LIKE 'vibe-s6%'").run();
});

afterEach(async () => {
  await ensureModelChainSchema(db);
  await ensureModelPolicySchema(db);
  await db.prepare("DELETE FROM agent_model_beta WHERE participant_id LIKE 'vibe-s6%'").run();
  await db.prepare("DELETE FROM agent_model_beta_executions WHERE participant_id LIKE 'vibe-s6%'").run();
  await db.prepare("DELETE FROM agent_model_breaker WHERE participant_id LIKE 'vibe-s6%'").run();
  await db.prepare("DELETE FROM agent_model_chains WHERE participant_id LIKE 'vibe-s6%'").run();
  await db.prepare("DELETE FROM agent_model_chain_versions WHERE participant_id LIKE 'vibe-s6%'").run();
});

describe('CC-8 S6 suite — maintenance périodique (orchestrateur)', () => {
  it('avance secours → bêta aux paliers atteints : suivi et chaîne exposés', async () => {
    const participant = pid();
    await seedChain(participant);
    await openTrack(participant);
    await executions(participant, 20, NOW + 3600);
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
    await openTrack(p1, 'b');
    await executions(p1, 19, NOW + 3600);
    const notReady = await betaMaintenance(db, { now: ADVANCE_AT });
    expect(notReady.advanced).toBe(0);
    expect((await loadBetaTrack(db, p1, CANDIDATE))!.status).toBe('secours');
    const p2 = await advancedTrack('c');
    await executions(p2, 5, ADVANCE_AT + 100);
    const healthy = await betaMaintenance(db, { now: ADVANCE_AT + 7200 });
    expect(healthy.rolledBack).toBe(0);
    expect((await loadBetaTrack(db, p2, CANDIDATE))!.status).toBe('beta');
  });

  it('retour arrière automatique d’une bêta cassée : instantané d’avant exposition restauré', async () => {
    const participant = await advancedTrack('d');
    await executions(participant, 5, ADVANCE_AT + 600, 5);
    const result = await betaMaintenance(db, { now: ADVANCE_AT + 7200 });
    expect(result.rolledBack).toBe(1);
    const track = (await loadBetaTrack(db, participant, CANDIDATE))!;
    expect(track.status).toBe('rolled_back');
    const chain = await loadModelChain(db, participant);
    expect(chain!.version).toBe(3);
    expect(chain!.chain.find(item => item.ref === CANDIDATE)!.status).toBe('rollback');
  });

  it('agentRunPass exécute la maintenance bêta dans son passage', async () => {
    const participant = pid();
    await seedChain(participant);
    await openTrack(participant, 'e');
    await executions(participant, 20, NOW + 3600);
    const pass = await agentRunPass(db, { AGENT_RUNS_ENABLED: 'true' },
      { now: ADVANCE_AT, deliverer: 's6w-pass', wake: async () => ({ accepted: false, reason: 'none' }) });
    expect(pass.beta?.advanced).toBe(1);
    expect((await loadBetaTrack(db, participant, CANDIDATE))!.status).toBe('beta');
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

  async function wiredParticipant(hash: string): Promise<string> {
    const participant = pid();
    await seedChain(participant);
    await openTrack(participant, hash);
    await ensureModelPolicySchema(db);
    return participant;
  }

  it('le repli réel sur le maillon suivi compte UNE exécution réussie', async () => {
    const participant = await wiredParticipant('f');
    const run = await freshRun(db, 's6w', NOW, 10_000, participant);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      if (body.model === 'glm-4.7-flash') throw executorError('EXECUTOR_TIMEOUT', 'Fournisseur sans réponse après 60000 ms.');
      if (body.model === 'glm-5.3') return new Response(JSON.stringify({
        choices: [{ message: { content: 'repli bêta' } }], usage: { prompt_tokens: 5, completion_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new Error('modèle inattendu : ' + String(body.model));
    }) as typeof fetch;
    const result = await routedModel(run.runId, fetchImpl).complete(message);
    expect(result.output.text).toBe('repli bêta');
    expect(await betaRows(participant)).toEqual([{ run_id: run.runId, ok: 1 }]);
    expect(await betaRows(participant, PRIMARY)).toEqual([]);
  });

  it('l’échec réel du maillon suivi compte un échec (taux du retour arrière)', async () => {
    const participant = await wiredParticipant('g');
    const run = await freshRun(db, 's6w', NOW, 10_000, participant);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      throw executorError('EXECUTOR_TIMEOUT', 'Fournisseur sans réponse après 60000 ms. (' + String(body.model) + ')');
    }) as typeof fetch;
    await expect(routedModel(run.runId, fetchImpl).complete(message)).rejects.toThrow();
    expect(await betaRows(participant)).toEqual([{ run_id: run.runId, ok: 0 }]);
  });

  it('une sonde ne compte JAMAIS, même en servant le maillon suivi', async () => {
    const participant = await wiredParticipant('h');
    const run = await freshRun(db, 's6w', NOW, 10_000, participant);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      if (body.model === 'glm-4.7-flash') throw executorError('EXECUTOR_TIMEOUT', 'Fournisseur sans réponse après 60000 ms.');
      if (body.model === 'glm-5.3') return new Response(JSON.stringify({
        choices: [{ message: { content: 'sonde bêta' } }], usage: { prompt_tokens: 5, completion_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new Error('modèle inattendu : ' + String(body.model));
    }) as typeof fetch;
    const result = await routedModel(run.runId, fetchImpl).complete({ ...message, task_kind: 'probe' });
    expect(result.output.text).toBe('sonde bêta');
    expect(await betaRows(participant)).toEqual([]);
    expect(await betaRows(participant, PRIMARY)).toEqual([]);
  });
});
