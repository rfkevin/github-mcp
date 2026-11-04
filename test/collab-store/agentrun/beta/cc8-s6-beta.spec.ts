import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  advanceSecoursToBeta,
  assertBetaPrimaryWindow,
  autoRollbackBeta,
  betaEvents,
  betaMetrics,
  closeBetaTrack,
  openBetaTrack,
  recordBetaExecution,
  BETA_ADVANCE_MIN_DURATION_S,
  type BetaCanaryProof,
} from '../../../../src/collab-store/agentrun/beta';
import { ensureModelChainSchema, loadChainSnapshot, loadModelChain } from '../../../../src/collab-store/agentrun/model-policy';
import { ensureSchema } from '../../../../src/collab-store/store/schema';
import { CollabStoreError } from '../../../../src/collab-store/store/collab-store';

// CC-8 S6 — paliers de bêta (CC-PLAN-8 §5) : ouverture sur preuve canary,
// avance secours → bêta aux seuils préenregistrés, retour arrière automatique
// d'une bêta cassée, fermeture, métriques. D1 réel, horloge figée, CAS.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const NOW = 1_993_200_000;
const T_ADV = NOW + BETA_ADVANCE_MIN_DURATION_S + 3600;
const PRIMARY = 'zai:glm-4.7-flash';
const CANDIDATE = 'zai:glm-5.3';
let n = 0;

const pid = () => 'vibe-s6-' + (++n);
const proof = (calls = 20, hash = 'a'): BetaCanaryProof =>
  ({ cycle_id: 'cc8-systeme-unique', report_hash: hash.repeat(64), calls, verdict: 'propose', next: 'beta' });

async function seedChain(participant: string, entries: Array<{ ref: string; status: string }>, version = 1, json?: string): Promise<void> {
  await ensureSchema(db);
  await ensureModelChainSchema(db);
  const chainJson = json ?? JSON.stringify(entries);
  await db.batch([
    db.prepare([
      'INSERT INTO agent_model_chains (participant_id, version, chain_json, updated_at, event_seq) VALUES (?1, ?2, ?3, ?4, NULL)',
      'ON CONFLICT(participant_id) DO UPDATE SET version = excluded.version, chain_json = excluded.chain_json,',
      '  updated_at = excluded.updated_at, event_seq = NULL',
    ].join(' ')).bind(participant, version, chainJson, NOW),
    db.prepare([
      'INSERT OR REPLACE INTO agent_model_chain_versions (participant_id, version, chain_json, set_by, action, reason, event_seq, at)',
      "VALUES (?1, ?2, ?3, 'owner:rfkevin', 'set', 'seed test', NULL, ?4)",
    ].join(' ')).bind(participant, version, chainJson, NOW),
  ]);
}

const openTrack = (participant: string, candidate = CANDIDATE, version = 1, canary = proof()) =>
  openBetaTrack(db, { participant_id: participant, candidate_ref: candidate, canary, expected_chain_version: version, now: NOW });

async function executions(participant: string, ref: string, count: number, at: number, failures = 0): Promise<void> {
  for (let i = 0; i < count; i++) {
    const recorded = await recordBetaExecution(db, { participant_id: participant, ref, run_id: 'run-' + (++n), at: at + i, ok: i >= failures });
    expect(recorded.open_track).toBe(true);
  }
}

/** Parcours complet jusqu'à la bêta : chaîne v2, suivi bêta (track_version 2). */
async function advancedTrack(): Promise<string> {
  const participant = pid();
  await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
  const opened = await openTrack(participant);
  expect(opened.status).toBe('applied');
  await executions(participant, CANDIDATE, 20, NOW);
  const advanced = await advanceSecoursToBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 1, now: T_ADV });
  expect(advanced.status).toBe('applied');
  return participant;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CollabStoreError);
    return (error as CollabStoreError).code;
  }
  throw new Error('un refus était attendu');
}

async function chainVersionRow(participant: string, version: number): Promise<{ set_by: string; action: string } | null> {
  return db.prepare('SELECT set_by, action FROM agent_model_chain_versions WHERE participant_id = ?1 AND version = ?2')
    .bind(participant, version).first<{ set_by: string; action: string }>();
}

const halt = () => db.prepare("INSERT OR REPLACE INTO owner_flags (name, value, event_seq, updated_at) VALUES ('halt', '1', NULL, ?1)").bind(NOW).run();
const resume = () => db.prepare("DELETE FROM owner_flags WHERE name = 'halt'").run();

describe('CC-8 S6 — suivi de bêta', () => {
  it('ouvre un suivi secours sur preuve canary et journalise', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    const opened = await openTrack(participant);
    expect(opened.status).toBe('applied');
    expect(opened.track.status).toBe('secours');
    expect(opened.track.track_version).toBe(1);
    expect(opened.track.thresholds.advance.min_executions).toBe(20);
    const events = await betaEvents(db, participant, CANDIDATE);
    expect(events.map(event => event.kind)).toEqual(['open']);
    expect(events[0]?.detail).toContain('preuve canary');
  });

  it('rejeu idempotent : la même preuve ne rouvre rien', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    await openTrack(participant);
    const replay = await openTrack(participant);
    expect(replay.status).toBe('duplicate');
    expect((await betaEvents(db, participant, CANDIDATE)).filter(event => event.kind === 'open')).toHaveLength(1);
  });

  it('une autre preuve pendant un suivi ouvert est refusée', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    await openTrack(participant);
    expect(await refusal(openTrack(participant, CANDIDATE, 1, proof(20, 'b')))).toBe('BETA_TRACK_OPEN');
  });

  it('canary insuffisant, verdict reject et cible hors bêta refusés', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    expect(await refusal(openTrack(participant, CANDIDATE, 1, proof(19)))).toBe('BETA_CANARY_INSUFFISANT');
    expect(await refusal(openTrack(participant, CANDIDATE, 1, proof(20, 'c') && { ...proof(20, 'c'), verdict: 'reject' }))).toBe('BETA_PROPOSAL_INVALID');
    expect(await refusal(openTrack(participant, CANDIDATE, 1, { ...proof(20, 'd'), next: 'primary' }))).toBe('BETA_PROPOSAL_INVALID');
  });

  it('alias latest, maillon absent et statut non secours refusés', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    expect(await refusal(openTrack(participant, 'zai:glm-latest'))).toBe('BETA_REF_INVALID');
    expect(await refusal(openTrack(participant, 'zai:glm-4.6'))).toBe('BETA_CANDIDATE_ABSENT');
    expect(await refusal(openTrack(participant, PRIMARY))).toBe('BETA_ENTRY_NOT_SECOURS');
  });

  it('version de chaîne expirée et chaîne retirée refusées', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    expect(await refusal(openTrack(participant, CANDIDATE, 5))).toBe('CHAIN_VERSION_STALE');
    await seedChain(participant, [], 1, 'null');
    expect(await refusal(openTrack(participant, CANDIDATE, 1))).toBe('BETA_CHAIN_ABSENT');
  });

  it('exécutions idempotentes par run, ignorées hors suivi ouvert', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    const first = await recordBetaExecution(db, { participant_id: participant, ref: CANDIDATE, run_id: 'x1', at: NOW, ok: true });
    expect(first.open_track).toBe(false);
    await openTrack(participant);
    const second = await recordBetaExecution(db, { participant_id: participant, ref: CANDIDATE, run_id: 'x2', at: NOW, ok: true });
    expect(second).toEqual({ recorded: true, duplicate: false, open_track: true });
    const replay = await recordBetaExecution(db, { participant_id: participant, ref: CANDIDATE, run_id: 'x2', at: NOW, ok: true });
    expect(replay.duplicate).toBe(true);
    await closeBetaTrack(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 1, reason: 'fin de test', now: NOW });
    const closed = await recordBetaExecution(db, { participant_id: participant, ref: CANDIDATE, run_id: 'x3', at: NOW, ok: true });
    expect(closed.open_track).toBe(false);
  });

  it('paliers non atteints : rien n’est écrit', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    await openTrack(participant);
    await executions(participant, CANDIDATE, 19, NOW);
    const short = await refusal(advanceSecoursToBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 1, now: T_ADV }));
    expect(short).toBe('BETA_THRESHOLDS_NOT_MET');
    await executions(participant, CANDIDATE, 1, NOW + 19);
    const tooSoon = await refusal(advanceSecoursToBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 1, now: NOW + 3600 }));
    expect(tooSoon).toBe('BETA_THRESHOLDS_NOT_MET');
    const track = await openTrack(participant);
    expect(track.track.status).toBe('secours');
    expect((await loadModelChain(db, participant))?.version).toBe(1);
  });

  it('avance secours → bêta : chaîne v2, audit, suivi bêta', async () => {
    const participant = await advancedTrack();
    const chain = await loadModelChain(db, participant);
    expect(chain?.version).toBe(2);
    expect(chain?.chain.find(item => item.ref === CANDIDATE)?.status).toBe('beta');
    expect(chain?.chain.find(item => item.ref === PRIMARY)?.status).toBe('primary');
    const version = await chainVersionRow(participant, 2);
    expect(version?.set_by).toBe('system:beta-track');
    expect(version?.action).toBe('set');
    const metrics = await betaMetrics(db, { participant_id: participant, now: T_ADV });
    expect(metrics[0]?.status).toBe('beta');
    expect(metrics[0]?.pre_beta_version).toBe(1);
    expect(metrics[0]?.advanced_at).toBe(T_ADV);
    expect(metrics[0]?.secours_metrics.executions).toBe(20);
    expect((await betaEvents(db, participant, CANDIDATE)).map(event => event.kind)).toEqual(['open', 'advance']);
  });

  it('rejeu idempotent de l’avance : pas de v3', async () => {
    const participant = await advancedTrack();
    const replay = await advanceSecoursToBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 2, now: T_ADV });
    expect(replay.status).toBe('duplicate');
    expect((await loadModelChain(db, participant))?.version).toBe(2);
  });

  it('course CAS sur le suivi refusée, rien n’est écrit', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    await openTrack(participant);
    await executions(participant, CANDIDATE, 20, NOW);
    const raced = await refusal(advanceSecoursToBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 7, now: T_ADV }));
    expect(raced).toBe('BETA_TRACK_STALE');
    expect((await loadModelChain(db, participant))?.version).toBe(1);
    const winner = await advanceSecoursToBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 1, now: T_ADV });
    expect(winner.status).toBe('applied');
  });

  it('chaîne modifiée par l’owner depuis l’ouverture : suivi périmé', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    await openTrack(participant);
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }], 2);
    await executions(participant, CANDIDATE, 20, NOW);
    expect(await refusal(advanceSecoursToBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 1, now: T_ADV }))).toBe('BETA_CHAIN_STALE');
  });

  it('halt coupe l’avance, rien n’est écrit', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    await openTrack(participant);
    await executions(participant, CANDIDATE, 20, NOW);
    try {
      await halt();
      expect(await refusal(advanceSecoursToBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 1, now: T_ADV }))).toBe('AUTOMATION_HALTED');
    } finally {
      await resume();
    }
    expect((await loadModelChain(db, participant))?.version).toBe(1);
  });

  it('retour arrière automatique : restaure la chaîne d’avant exposition', async () => {
    const participant = await advancedTrack();
    await executions(participant, CANDIDATE, 6, T_ADV, 1);
    const rolled = await autoRollbackBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 2, now: T_ADV + 3600 });
    expect(rolled.status).toBe('applied');
    expect(rolled.chain_version).toBe(3);
    const snapshot = await loadChainSnapshot(db, participant, 3);
    expect(snapshot?.chain?.find(item => item.ref === CANDIDATE)?.status).toBe('rollback');
    expect(snapshot?.chain?.find(item => item.ref === PRIMARY)?.status).toBe('primary');
    const version = await chainVersionRow(participant, 3);
    expect(version?.set_by).toBe('system:beta-track');
    expect(version?.action).toBe('rollback');
    const track = await betaMetrics(db, { participant_id: participant, now: T_ADV + 3600 });
    expect(track[0]?.status).toBe('rolled_back');
    expect(track[0]?.close_reason).toContain('échecs');
    expect(track[0]?.beta_metrics.failures).toBe(1);
    expect((await betaEvents(db, participant, CANDIDATE)).map(event => event.kind)).toEqual(['open', 'advance', 'rollback']);
  });

  it('rejeu idempotent du retour arrière', async () => {
    const participant = await advancedTrack();
    await executions(participant, CANDIDATE, 6, T_ADV, 2);
    await autoRollbackBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 2, now: T_ADV + 3600 });
    const replay = await autoRollbackBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 3, now: T_ADV + 3600 });
    expect(replay.status).toBe('duplicate');
    expect((await loadModelChain(db, participant))?.version).toBe(3);
  });

  it('bêta saine : aucun retour arrière', async () => {
    const participant = await advancedTrack();
    await executions(participant, CANDIDATE, 6, T_ADV, 0);
    expect(await refusal(autoRollbackBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 2, now: T_ADV + 3600 }))).toBe('BETA_CRITERIA_INTACT');
    expect((await loadModelChain(db, participant))?.version).toBe(2);
  });

  it('bêta insuffisamment observée : refus', async () => {
    const participant = await advancedTrack();
    await executions(participant, CANDIDATE, 4, T_ADV, 2);
    expect(await refusal(autoRollbackBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 2, now: T_ADV + 3600 }))).toBe('BETA_THRESHOLDS_NOT_MET');
    expect((await loadModelChain(db, participant))?.version).toBe(2);
  });

  it('halt coupe aussi le retour arrière automatique', async () => {
    const participant = await advancedTrack();
    await executions(participant, CANDIDATE, 6, T_ADV, 2);
    try {
      await halt();
      expect(await refusal(autoRollbackBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 2, now: T_ADV + 3600 }))).toBe('AUTOMATION_HALTED');
    } finally {
      await resume();
    }
    expect((await loadModelChain(db, participant))?.version).toBe(2);
  });

  it('maillon rétracté par l’owner : retour automatique refusé', async () => {
    const participant = await advancedTrack();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }], 3);
    await executions(participant, CANDIDATE, 6, T_ADV, 2);
    expect(await refusal(autoRollbackBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 2, now: T_ADV + 3600 }))).toBe('BETA_CHAIN_STALE');
  });

  it('fenêtre principal non atteinte : promotion refusée', async () => {
    const participant = await advancedTrack();
    expect(await refusal(assertBetaPrimaryWindow(db, participant, CANDIDATE, T_ADV + 3600))).toBe('BETA_PRIMARY_WINDOW_NOT_MET');
    await executions(participant, CANDIDATE, 20, T_ADV);
    expect(await refusal(assertBetaPrimaryWindow(db, participant, CANDIDATE, T_ADV + 3600))).toBe('BETA_PRIMARY_WINDOW_NOT_MET');
    expect((await loadModelChain(db, participant))?.version).toBe(2);
    expect((await betaEvents(db, participant, CANDIDATE)).map(event => event.kind)).toEqual(['open', 'advance']);
  });

  it('fenêtre principal atteinte : garde lecture seule, métriques rendues', async () => {
    const participant = await advancedTrack();
    await executions(participant, CANDIDATE, 20, T_ADV);
    const window = await assertBetaPrimaryWindow(db, participant, CANDIDATE, T_ADV + BETA_ADVANCE_MIN_DURATION_S + 3600);
    expect(window.executions).toBe(20);
    expect(window.failures).toBe(0);
    expect(window.hours).toBe(49);
    expect((await loadModelChain(db, participant))?.version).toBe(2);
    expect((await betaEvents(db, participant, CANDIDATE)).map(event => event.kind)).toEqual(['open', 'advance']);
  });

  it('garde principal hors bêta exposée : refus', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    await openTrack(participant);
    expect(await refusal(assertBetaPrimaryWindow(db, participant, CANDIDATE, T_ADV))).toBe('BETA_NOT_IN_BETA');
  });

  it('owner modifie un autre maillon pendant la bêta : retour arrière refusé, son acte préservé', async () => {
    const participant = await advancedTrack();
    await seedChain(participant, [{ ref: PRIMARY, status: 'inactive' }, { ref: CANDIDATE, status: 'beta' }], 3);
    await executions(participant, CANDIDATE, 6, T_ADV, 2);
    expect(await refusal(autoRollbackBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 2, now: T_ADV + 3600 }))).toBe('BETA_CHAIN_DIVERGED');
    const chain = await loadModelChain(db, participant);
    expect(chain?.version).toBe(3);
    expect(chain?.chain.find(item => item.ref === PRIMARY)?.status).toBe('inactive');
    expect((await betaMetrics(db, { participant_id: participant, now: T_ADV + 3600 }))[0]?.status).toBe('beta');
    expect(await chainVersionRow(participant, 4)).toBe(null);
    expect((await betaEvents(db, participant, CANDIDATE)).map(event => event.kind)).toEqual(['open', 'advance']);
  });

  it('fermeture puis réouverture : compteur de suivi monotone', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    await openTrack(participant);
    const closed = await closeBetaTrack(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 1, reason: 'candidature écartée', now: NOW + 60 });
    expect(closed.status).toBe('applied');
    const replay = await closeBetaTrack(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 2, reason: 'rejeu', now: NOW + 61 });
    expect(replay.status).toBe('duplicate');
    const reopened = await openTrack(participant, CANDIDATE, 1, proof(20, 'e'));
    expect(reopened.status).toBe('applied');
    expect(reopened.track.track_version).toBe(3);
    expect(reopened.track.status).toBe('secours');
  });

  it('métriques : fenêtres par étape, paliers et santé visibles', async () => {
    const participant = pid();
    await seedChain(participant, [{ ref: PRIMARY, status: 'primary' }, { ref: CANDIDATE, status: 'rollback' }]);
    await openTrack(participant);
    const early = await betaMetrics(db, { participant_id: participant, now: NOW });
    expect(early[0]?.advance_ready).toBe(false);
    expect(early[0]?.advance_blockers.length).toBe(2);
    expect(early[0]?.rollback_broken).toBe(false);
    await executions(participant, CANDIDATE, 20, NOW);
    await advanceSecoursToBeta(db, { participant_id: participant, candidate_ref: CANDIDATE, expected_track_version: 1, now: T_ADV });
    await executions(participant, CANDIDATE, 6, T_ADV, 1);
    const broken = await betaMetrics(db, { participant_id: participant, now: T_ADV + 3600 });
    expect(broken[0]?.status).toBe('beta');
    expect(broken[0]?.secours_metrics.executions).toBe(20);
    expect(broken[0]?.beta_metrics.executions).toBe(6);
    expect(broken[0]?.beta_metrics.failure_rate).toBeCloseTo(1 / 6, 5);
    expect(broken[0]?.rollback_broken).toBe(true);
    expect(broken[0]?.thresholds.rollback.max_failure_rate).toBe(0.05);
  });
});
