/**
 * CC-8 S6 (CC-PLAN-8 §5 paliers de bêta) — paliers du suivi : avance
 * secours → bêta, retour arrière automatique, fermeture, et garde de la
 * fenêtre bêta avant la promotion principal (acte owner).
 *
 * L’exposition automatique est LIMITÉE au statut beta : la promotion vers
 * primary reste un acte owner (set_agent_models sur /owner) qui DOIT passer
 * par assertBetaPrimaryWindow — fenêtre bêta >= 20 exécutions ET >= 48 h
 * depuis l’exposition (relecture GPT-6 : le caractère manuel de l’acte ne
 * prouve pas le seuil). Le retour arrière automatique restaure la chaîne
 * d’AVANT l’exposition (instantané pre_beta_version de l’audit append-only
 * S3) : même une version retirée par l’owner y est restaurée via la sentinelle —
 * mais il REFUSE si l’owner a modifié la chaîne depuis l’exposition
 * (BETA_CHAIN_DIVERGED : jamais d’écrasement de son acte). Chaque écriture passe
 * par la garde transactionnelle C2 (CAS suivi + version de chaîne + HALT) :
 * une course ou un arrêt d’urgence annule TOUT le lot, jamais
 * last-write-wins.
 */
import { CollabStoreError } from '../../store/collab-store';
import { assertAutomationRunning, HALT_ACTIVE_SQL } from '../../owner/automation';
import { loadChainSnapshot, loadModelChain } from '../model-policy';
import {
  BETA_GUARD_CLEAR,
  betaEventInsert,
  betaGuard,
  betaGuardRefused,
  betaHours,
  ensureBetaSchema,
  loadBetaTrack,
  stageMetrics,
} from './store';

export interface BetaTrackStepInput {
  readonly participant_id: string;
  readonly candidate_ref: string;
  readonly expected_track_version: number;
  readonly now: number;
}

export interface BetaStepResult {
  readonly status: 'applied' | 'duplicate';
  readonly chain_version: number;
  readonly track_version: number;
}

function versionRow(db: D1Database, participantId: string, version: number, chainJson: string, action: 'set' | 'rollback',
  reason: string, at: number): D1PreparedStatement {
  return db.prepare([
    'INSERT INTO agent_model_chain_versions (participant_id, version, chain_json, set_by, action, reason, event_seq, at)',
    "VALUES (?1, ?2, ?3, 'system:beta-track', ?4, ?5, NULL, ?6)",
  ].join(' ')).bind(participantId, version, chainJson, action, reason, at);
}

/**
 * Avance le suivi de secours à la bêta : paliers préenregistrés atteints
 * (>= 20 exécutions comptées ET >= 48 h) → le maillon passe au statut beta
 * dans une NOUVELLE version de chaîne (audit append-only, CAS). Rejeu
 * idempotent ; course CAS, chaîne modifiée par l'owner ou arrêt d'urgence =
 * refus typé SANS écriture.
 */
export async function advanceSecoursToBeta(db: D1Database, input: BetaTrackStepInput): Promise<BetaStepResult> {
  await ensureBetaSchema(db);
  const track = await loadBetaTrack(db, input.participant_id, input.candidate_ref);
  if (!track) throw new CollabStoreError('BETA_TRACK_UNKNOWN', 'Aucun suivi de bêta pour ' + input.participant_id + ' / ' + input.candidate_ref + '.');
  if (track.status === 'beta') {
    return { status: 'duplicate', chain_version: track.chain_version, track_version: track.track_version };
  }
  if (track.status !== 'secours') {
    throw new CollabStoreError('BETA_TRACK_CLOSED', 'Suivi ' + track.status + ' : l’avance ne s’applique qu’à un suivi secours ouvert.');
  }
  await assertAutomationRunning(db);
  const chain = await loadModelChain(db, input.participant_id);
  if (!chain || !chain.active) {
    throw new CollabStoreError('BETA_CHAIN_ABSENT', 'Chaîne absente ou retirée pour ' + input.participant_id + ' : rien n’est écrit.');
  }
  if (chain.version !== track.chain_version) {
    throw new CollabStoreError('BETA_CHAIN_STALE',
      'La chaîne de ' + input.participant_id + ' est à la version ' + chain.version + ', le suivi a été ouvert à la v' + track.chain_version + ' : suivi périmé, rien n’est écrit.');
  }
  const entry = chain.chain.find(item => item.ref === input.candidate_ref);
  if (!entry) {
    throw new CollabStoreError('BETA_CANDIDATE_ABSENT', input.candidate_ref + ' n’est plus un maillon de la chaîne de ' + input.participant_id + '.');
  }
  if (entry.status !== 'rollback') {
    throw new CollabStoreError('BETA_ENTRY_NOT_SECOURS', input.candidate_ref + ' porte le statut ' + entry.status + ' : seule une candidate secours passe en bêta.');
  }
  const secours = await stageMetrics(db, input.participant_id, input.candidate_ref, track.opened_at, track.advanced_at);
  const blockers: string[] = [];
  if (secours.executions < track.thresholds.advance.min_executions) {
    blockers.push(secours.executions + ' exécutions < ' + track.thresholds.advance.min_executions + ' requises');
  }
  if (input.now - track.opened_at < track.thresholds.advance.min_duration_s) {
    blockers.push(betaHours(input.now - track.opened_at) + ' h < ' + betaHours(track.thresholds.advance.min_duration_s) + ' h requises');
  }
  if (blockers.length > 0) {
    throw new CollabStoreError('BETA_THRESHOLDS_NOT_MET', 'Paliers préenregistrés non atteints : ' + blockers.join(', ') + '.');
  }
  const newChain = chain.chain.map(item => item.ref === input.candidate_ref ? { ...item, status: 'beta' as const } : item);
  const newJson = JSON.stringify(newChain);
  const reason = 'bêta : paliers atteints (' + secours.executions + ' exécutions, ' + betaHours(input.now - track.opened_at) + ' h)';
  try {
    await db.batch([
      betaGuard(db,
        '(SELECT version FROM agent_model_chains WHERE participant_id = ?1) = ?2'
        + ' AND (SELECT track_version FROM agent_model_beta WHERE participant_id = ?1 AND candidate_ref = ?3) = ?4'
        + " AND (SELECT status FROM agent_model_beta WHERE participant_id = ?1 AND candidate_ref = ?3) = 'secours'"
        + ' AND NOT ' + HALT_ACTIVE_SQL,
        [input.participant_id, track.chain_version, input.candidate_ref, input.expected_track_version]),
      versionRow(db, input.participant_id, track.chain_version + 1, newJson, 'set', reason, input.now),
      db.prepare('UPDATE agent_model_chains SET version = ?2, chain_json = ?3, updated_at = ?4, event_seq = NULL WHERE participant_id = ?1')
        .bind(input.participant_id, track.chain_version + 1, newJson, input.now),
      db.prepare([
        "UPDATE agent_model_beta SET status = 'beta', track_version = track_version + 1, pre_beta_version = ?3, advanced_at = ?4",
        "WHERE participant_id = ?1 AND candidate_ref = ?2 AND track_version = ?5 AND status = 'secours'",
      ].join(' ')).bind(input.participant_id, input.candidate_ref, track.chain_version, input.now, input.expected_track_version),
      betaEventInsert(db, input.now, input.participant_id, input.candidate_ref, 'advance',
        reason + ', chaîne v' + track.chain_version + ' → v' + (track.chain_version + 1)),
      db.prepare(BETA_GUARD_CLEAR),
    ]);
  } catch (error) {
    await betaGuardRefused(db, error, {
      participant_id: input.participant_id,
      candidate_ref: input.candidate_ref,
      expected_track_version: input.expected_track_version,
      expected_chain_version: track.chain_version,
    });
  }
  return { status: 'applied', chain_version: track.chain_version + 1, track_version: input.expected_track_version + 1 };
}

/**
 * Retour arrière AUTOMATIQUE d’une bêta qui casse ses seuils préenregistrés
 * (>= 5 exécutions en bêta ET taux d’échec > 5 %) : la chaîne d’AVANT
 * l’exposition (instantané pre_beta_version) est republiée dans une nouvelle
 * version (action rollback, audit append-only), le suivi passe à rolled_back
 * avec son motif. Une bêta saine ne produit RIEN (BETA_CRITERIA_INTACT).
 * Contre-exemple relecture GPT-6 : si l’owner a modifié la chaîne APRÈS
 * l’exposition (autre maillon, candidate gardée en bêta), la chaîne live n’est
 * plus celle que le module a exposée — restaurer l’instantané entier
 * effacerait son acte : refus typé BETA_CHAIN_DIVERGED sans écriture,
 * arbitrage owner (set_agent_models manuel). L’arrêt d’urgence coupe AUSSI ce
 * chemin (fail-safe) : l’owner peut toujours rouler manuellement via /owner.
 */
export async function autoRollbackBeta(db: D1Database, input: BetaTrackStepInput): Promise<BetaStepResult> {
  await ensureBetaSchema(db);
  const track = await loadBetaTrack(db, input.participant_id, input.candidate_ref);
  if (!track) throw new CollabStoreError('BETA_TRACK_UNKNOWN', 'Aucun suivi de bêta pour ' + input.participant_id + ' / ' + input.candidate_ref + '.');
  if (track.status === 'rolled_back') {
    return { status: 'duplicate', chain_version: track.chain_version, track_version: track.track_version };
  }
  if (track.status === 'stale') {
    throw new CollabStoreError('BETA_TRACK_CLOSED', 'Suivi fermé : aucun retour arrière à appliquer.');
  }
  if (track.status !== 'beta') {
    throw new CollabStoreError('BETA_NOT_IN_BETA', 'Le suivi est en ' + track.status + ' : le retour arrière automatique ne s’applique qu’à une bêta exposée.');
  }
  await assertAutomationRunning(db);
  const chain = await loadModelChain(db, input.participant_id);
  if (!chain || !chain.active) {
    throw new CollabStoreError('BETA_CHAIN_ABSENT', 'Chaîne absente ou retirée pour ' + input.participant_id + ' : rien n’est écrit.');
  }
  const entry = chain.chain.find(item => item.ref === input.candidate_ref);
  if (!entry || entry.status !== 'beta') {
    throw new CollabStoreError('BETA_CHAIN_STALE',
      'La chaîne de ' + input.participant_id + ' ne route plus ' + input.candidate_ref + ' en bêta (owner retracté ?) : retour automatique refusé, arbitrage owner.');
  }
  if (chain.version !== track.chain_version + 1) {
    throw new CollabStoreError("BETA_CHAIN_DIVERGED",
      "La chaîne de " + input.participant_id + " est à la version " + chain.version + ", l’exposition bêta a créé la v" + (track.chain_version + 1)
      + " : la chaîne a été modifiée depuis l’exposition (owner). Le retour arrière automatique refuse d’effacer cette modification — arbitrage owner via set_agent_models, rien n’est écrit.");
  }
  if (track.pre_beta_version === null) {
    throw new CollabStoreError('BETA_SNAPSHOT_MISSING', 'Le suivi ne porte pas la version d’avant exposition : retour arrière impossible sans arbitrage owner.');
  }
  const snapshot = await loadChainSnapshot(db, input.participant_id, track.pre_beta_version);
  if (!snapshot) {
    throw new CollabStoreError('BETA_SNAPSHOT_MISSING', 'Instantané v' + track.pre_beta_version + ' introuvable dans l’audit : retour arrière impossible.');
  }
  const beta = await stageMetrics(db, input.participant_id, input.candidate_ref, track.advanced_at ?? track.opened_at, track.closed_at);
  if (beta.executions < track.thresholds.rollback.min_executions) {
    throw new CollabStoreError('BETA_THRESHOLDS_NOT_MET',
      'Bêta insuffisamment observée : ' + beta.executions + ' exécutions < ' + track.thresholds.rollback.min_executions + ' requises.');
  }
  if (beta.failure_rate === null || beta.failure_rate <= track.thresholds.rollback.max_failure_rate) {
    throw new CollabStoreError('BETA_CRITERIA_INTACT',
      'Seuils de bêta intacts (' + beta.failures + '/' + beta.executions + ' échecs) : aucun retour arrière.');
  }
  const restoredJson = snapshot.chain === null ? 'null' : JSON.stringify(snapshot.chain);
  const reason = 'bêta cassée : ' + beta.failures + '/' + beta.executions + ' échecs ('
    + Math.round(beta.failure_rate * 100) + ' % > ' + Math.round(track.thresholds.rollback.max_failure_rate * 100)
    + ' %), retour à la chaîne v' + track.pre_beta_version;
  try {
    await db.batch([
      betaGuard(db,
        '(SELECT track_version FROM agent_model_beta WHERE participant_id = ?1 AND candidate_ref = ?2) = ?4'
        + " AND (SELECT status FROM agent_model_beta WHERE participant_id = ?1 AND candidate_ref = ?2) = 'beta'"
        + ' AND (SELECT version FROM agent_model_chains WHERE participant_id = ?1) = ?3'
        + ' AND NOT ' + HALT_ACTIVE_SQL,
        [input.participant_id, input.candidate_ref, chain.version, input.expected_track_version]),
      versionRow(db, input.participant_id, chain.version + 1, restoredJson, 'rollback', reason, input.now),
      db.prepare('UPDATE agent_model_chains SET version = ?2, chain_json = ?3, updated_at = ?4, event_seq = NULL WHERE participant_id = ?1')
        .bind(input.participant_id, chain.version + 1, restoredJson, input.now),
      db.prepare([
        "UPDATE agent_model_beta SET status = 'rolled_back', track_version = track_version + 1, closed_at = ?3, close_reason = ?4",
        "WHERE participant_id = ?1 AND candidate_ref = ?2 AND track_version = ?5 AND status = 'beta'",
      ].join(' ')).bind(input.participant_id, input.candidate_ref, input.now, reason, input.expected_track_version),
      betaEventInsert(db, input.now, input.participant_id, input.candidate_ref, 'rollback', reason),
      db.prepare(BETA_GUARD_CLEAR),
    ]);
  } catch (error) {
    await betaGuardRefused(db, error, {
      participant_id: input.participant_id,
      candidate_ref: input.candidate_ref,
      expected_track_version: input.expected_track_version,
      expected_chain_version: chain.version,
    });
  }
  return { status: 'applied', chain_version: chain.version + 1, track_version: input.expected_track_version + 1 };
}

/**
 * Fermeture du suivi (bookkeeping : le maillon garde le statut que la chaîne
 * lui donne). Pas de garde HALT — aucune exposition ne bouge ; CAS sur le
 * suivi seul. Réouverture possible par openBetaTrack avec une nouvelle preuve.
 */
export async function closeBetaTrack(db: D1Database, input: BetaTrackStepInput & { reason: string }): Promise<BetaStepResult> {
  await ensureBetaSchema(db);
  const track = await loadBetaTrack(db, input.participant_id, input.candidate_ref);
  if (!track) throw new CollabStoreError('BETA_TRACK_UNKNOWN', 'Aucun suivi de bêta pour ' + input.participant_id + ' / ' + input.candidate_ref + '.');
  if (track.status === 'stale') {
    return { status: 'duplicate', chain_version: track.chain_version, track_version: track.track_version };
  }
  if (track.status === 'rolled_back') {
    throw new CollabStoreError('BETA_TRACK_CLOSED', 'Suivi déjà roulé : fermeture sans objet.');
  }
  const reason = input.reason.slice(0, 500);
  try {
    await db.batch([
      betaGuard(db,
        '(SELECT track_version FROM agent_model_beta WHERE participant_id = ?1 AND candidate_ref = ?2) = ?3'
        + " AND (SELECT status FROM agent_model_beta WHERE participant_id = ?1 AND candidate_ref = ?2) IN ('secours','beta')",
        [input.participant_id, input.candidate_ref, input.expected_track_version]),
      db.prepare([
        "UPDATE agent_model_beta SET status = 'stale', track_version = track_version + 1, closed_at = ?3, close_reason = ?4",
        'WHERE participant_id = ?1 AND candidate_ref = ?2',
      ].join(' ')).bind(input.participant_id, input.candidate_ref, input.now, reason),
      betaEventInsert(db, input.now, input.participant_id, input.candidate_ref, 'close', 'fermeture : ' + reason),
      db.prepare(BETA_GUARD_CLEAR),
    ]);
  } catch (error) {
    await betaGuardRefused(db, error, {
      participant_id: input.participant_id,
      candidate_ref: input.candidate_ref,
      expected_track_version: input.expected_track_version,
      expected_chain_version: null,
    });
  }
  return { status: 'applied', chain_version: track.chain_version, track_version: input.expected_track_version + 1 };
}

// ── Fenêtre bêta avant principal (garde de l’acte owner) ───────────────────────

export interface BetaPrimaryWindow {
  readonly participant_id: string;
  readonly candidate_ref: string;
  readonly since: number;
  readonly executions: number;
  readonly ok: number;
  readonly failures: number;
  readonly failure_rate: number | null;
  readonly hours: number;
}

/**
 * Garde de la promotion bêta → principal (plan 1262/1270 : « puis bêta
 * >= 20 exécutions ET >= 48 h, puis principal par /owner »). L’acte owner
 * (set_agent_models sur /owner) DOIT appeler cette fonction avant de
 * promouvoir le maillon bêta en primary et refuser sur erreur : le caractère
 * manuel de l’acte ne prouve pas le seuil (relecture GPT-6). La fenêtre se
 * juge aux seuils PRÉENREGISTRÉS à l’ouverture du suivi : >= 20 exécutions
 * réelles DEPUIS l’exposition (advanced_at) ET >= 48 h. Lecture seule :
 * aucune écriture, aucun compteur modifié ; HALT ne s’applique pas — l’acte
 * owner reste maître, seule l’automatisation est coupée.
 */
export async function assertBetaPrimaryWindow(db: D1Database, participantId: string, candidateRef: string,
  now: number): Promise<BetaPrimaryWindow> {
  await ensureBetaSchema(db);
  const track = await loadBetaTrack(db, participantId, candidateRef);
  if (!track) throw new CollabStoreError("BETA_TRACK_UNKNOWN", "Aucun suivi de bêta pour " + participantId + " / " + candidateRef + ".");
  if (track.status !== "beta") {
    throw new CollabStoreError("BETA_NOT_IN_BETA", "Le suivi est en " + track.status + " : la fenêtre bêta ne se juge que sur une bêta exposée.");
  }
  const chain = await loadModelChain(db, participantId);
  const entry = chain && chain.active ? chain.chain.find(item => item.ref === candidateRef) : undefined;
  if (!chain || !chain.active || !entry || entry.status !== "beta") {
    throw new CollabStoreError("BETA_NOT_IN_BETA", "La chaîne de " + participantId + " ne route plus " + candidateRef + " en bêta : promotion refusée, arbitrage owner.");
  }
  const advancedAt = track.advanced_at;
  if (advancedAt === null) {
    throw new CollabStoreError("BETA_NOT_IN_BETA", "Bêta sans date d’exposition : suivi incohérent, promotion refusée.");
  }
  const window = await stageMetrics(db, participantId, candidateRef, advancedAt, null);
  const blockers: string[] = [];
  if (window.executions < track.thresholds.advance.min_executions) {
    blockers.push(window.executions + " exécutions < " + track.thresholds.advance.min_executions + " requises");
  }
  if (now - advancedAt < track.thresholds.advance.min_duration_s) {
    blockers.push(betaHours(now - advancedAt) + " h < " + betaHours(track.thresholds.advance.min_duration_s) + " h requises");
  }
  if (blockers.length > 0) {
    throw new CollabStoreError("BETA_PRIMARY_WINDOW_NOT_MET",
      "Fenêtre bêta non atteinte : " + blockers.join(", ") + " — la promotion principal attend les paliers préenregistrés, rien n’est écrit.");
  }
  return {
    participant_id: participantId,
    candidate_ref: candidateRef,
    since: advancedAt,
    executions: window.executions,
    ok: window.ok,
    failures: window.failures,
    failure_rate: window.failure_rate,
    hours: betaHours(now - advancedAt),
  };
}
