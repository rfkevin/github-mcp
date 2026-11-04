/**
 * CC-8 S6 (CC-PLAN-8 v0.1 §« Paliers de bêta », v0.2 seq 1270) — suivi de
 * bêta d'un maillon de chaîne de modèles : secours → bêta → principal.
 *
 * Paliers votés (valeurs PROVISOIRES, recalibrées après les mesures du lot
 * S1) : la candidate entre dans la chaîne comme SECOURS (statut rollback,
 * dernier recours routé, posé par l'owner via set_agent_models) ; le passage
 * secours → bêta exige >= 20 exécutions réelles ET >= 48 h, à des seuils
 * PRÉENREGISTRÉS à l'ouverture du suivi ; la promotion bêta → principal reste
 * un ACTE OWNER (set_agent_models sur /owner, jamais automatique — aucun
 * chemin auto vers primary n'existe dans ce module) ; le retour arrière est
 * AUTOMATIQUE pour une bêta qui casse ses seuils (advance.ts : CAS/version,
 * retour à la chaîne d'avant l'exposition, audit append-only).
 *
 * Module AUTONOME (v0, préparation/mock) : tables internes portables, aucune
 * modification de model-policy.ts, du moteur, des actes owner ni du schéma
 * canonique. Raccordements (comptage par le moteur, vues /owner, appel du
 * contrôleur) documentés dans docs/collaboration/cc8/s6-beta.md, à poser après
 * intégration S4/S5 avec extension de périmètre approuvée par Kevin.
 */
import { CollabStoreError } from '../../store/collab-store';
import { assertAutomationRunning, HALT_ACTIVE_SQL, isAutomationHalted } from '../../owner/automation';
import { CANARY_MIN_CALLS, isPinnedRef } from '../promote';
import { ensureModelChainSchema, loadModelChain } from '../model-policy';

// ── Seuils préenregistrés (paliers votés, PROVISOIRES — recalibrage S1) ──────

export const BETA_ADVANCE_MIN_EXECUTIONS = 20;
export const BETA_ADVANCE_MIN_DURATION_S = 48 * 3600;
export const BETA_ROLLBACK_MIN_EXECUTIONS = 5;
export const BETA_ROLLBACK_MAX_FAILURE_RATE = 0.05;

export interface BetaThresholds {
  readonly advance: { readonly min_executions: number; readonly min_duration_s: number };
  readonly rollback: { readonly min_executions: number; readonly max_failure_rate: number };
}

export const DEFAULT_BETA_THRESHOLDS: BetaThresholds = Object.freeze({
  advance: Object.freeze({ min_executions: BETA_ADVANCE_MIN_EXECUTIONS, min_duration_s: BETA_ADVANCE_MIN_DURATION_S }),
  rollback: Object.freeze({ min_executions: BETA_ROLLBACK_MIN_EXECUTIONS, max_failure_rate: BETA_ROLLBACK_MAX_FAILURE_RATE }),
});

const PARTICIPANT_RE = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
const HASH_RE = /^[a-f0-9]{64}$/;

// ── Tables internes au module (portables, jamais dans le schéma canonique) ───

export const BETA_SCHEMA = [
  [
    'CREATE TABLE IF NOT EXISTS agent_model_beta (',
    '  participant_id TEXT NOT NULL,',
    '  candidate_ref TEXT NOT NULL,',
    "  status TEXT NOT NULL CHECK (status IN ('secours','beta','rolled_back','stale')),",
    '  track_version INTEGER NOT NULL,',
    '  chain_version INTEGER NOT NULL,',
    '  pre_beta_version INTEGER,',
    '  canary_report_hash TEXT NOT NULL,',
    '  canary_cycle_id TEXT NOT NULL,',
    '  canary_calls INTEGER NOT NULL,',
    '  thresholds_json TEXT NOT NULL,',
    '  opened_at INTEGER NOT NULL,',
    '  advanced_at INTEGER,',
    '  closed_at INTEGER,',
    "  close_reason TEXT NOT NULL DEFAULT '',",
    '  PRIMARY KEY (participant_id, candidate_ref)',
    ')',
  ].join(' '),
  [
    'CREATE TABLE IF NOT EXISTS agent_model_beta_executions (',
    '  participant_id TEXT NOT NULL,',
    '  ref TEXT NOT NULL,',
    '  run_id TEXT NOT NULL,',
    '  at INTEGER NOT NULL,',
    '  ok INTEGER NOT NULL CHECK (ok IN (0,1)),',
    '  latency_ms INTEGER NOT NULL DEFAULT 0,',
    '  cost_micro_cents INTEGER NOT NULL DEFAULT 0,',
    '  PRIMARY KEY (participant_id, ref, run_id)',
    ')',
  ].join(' '),
  [
    'CREATE TABLE IF NOT EXISTS agent_model_beta_events (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  at INTEGER NOT NULL,',
    '  participant_id TEXT NOT NULL,',
    '  candidate_ref TEXT NOT NULL,',
    '  kind TEXT NOT NULL,',
    "  detail TEXT NOT NULL DEFAULT ''",
    ')',
  ].join(' '),
  // Garde transactionnelle (modèle C2) : le premier statement du lot insère
  // ok=1, sinon le CHECK fait échouer ET annuler tout le lot (jamais
  // last-write-wins). La ligne est retirée dans le même lot.
  'CREATE TABLE IF NOT EXISTS agent_beta_guard (ok INTEGER NOT NULL CHECK (ok = 1))',
] as const;

const NO_DELETE = ['agent_model_beta_executions', 'agent_model_beta_events'].map(table =>
  'CREATE TRIGGER IF NOT EXISTS ' + table + '_no_delete BEFORE DELETE ON ' + table
  + " BEGIN SELECT RAISE(ABORT, 'append-only'); END");
const EVENTS_NO_UPDATE = 'CREATE TRIGGER IF NOT EXISTS agent_model_beta_events_no_update BEFORE UPDATE ON agent_model_beta_events'
  + " BEGIN SELECT RAISE(ABORT, 'append-only'); END";

const schemaEnsured = new WeakSet<object>();

export async function ensureBetaSchema(db: D1Database): Promise<void> {
  if (schemaEnsured.has(db as unknown as object)) return;
  await db.batch([...BETA_SCHEMA, ...NO_DELETE, EVENTS_NO_UPDATE].map(statement => db.prepare(statement)));
  schemaEnsured.add(db as unknown as object);
}

/** Garde transactionnelle : ok=1 ou le CHECK annule tout le lot. */
export function betaGuard(db: D1Database, conditions: string, binds: readonly unknown[]): D1PreparedStatement {
  return db.prepare('INSERT INTO agent_beta_guard (ok) SELECT CASE WHEN ' + conditions + ' THEN 1 ELSE 0 END')
    .bind(...binds);
}

export const BETA_GUARD_CLEAR = 'DELETE FROM agent_beta_guard';

export function betaEventInsert(db: D1Database, at: number, participantId: string, candidateRef: string,
  kind: string, detail: string): D1PreparedStatement {
  return db.prepare('INSERT INTO agent_model_beta_events (at, participant_id, candidate_ref, kind, detail) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(at, participantId, candidateRef, kind, detail.slice(0, 500));
}

/** Journal append-only du suivi (lecture ; l'ordre suit l'identifiant). */
export async function betaEvents(db: D1Database, participantId: string, candidateRef: string): Promise<Array<{ id: number; at: number; kind: string; detail: string }>> {
  await ensureBetaSchema(db);
  const rows = await db.prepare('SELECT id, at, kind, detail FROM agent_model_beta_events WHERE participant_id = ?1 AND candidate_ref = ?2 ORDER BY id')
    .bind(participantId, candidateRef).all<{ id: number; at: number; kind: string; detail: string }>();
  return rows.results;
}

// ── Suivi courant ────────────────────────────────────────────────────────────

export type BetaTrackStatus = 'secours' | 'beta' | 'rolled_back' | 'stale';

export interface BetaTrack {
  readonly participant_id: string;
  readonly candidate_ref: string;
  readonly status: BetaTrackStatus;
  readonly track_version: number;
  readonly chain_version: number;
  readonly pre_beta_version: number | null;
  readonly canary_report_hash: string;
  readonly canary_cycle_id: string;
  readonly canary_calls: number;
  readonly thresholds: BetaThresholds;
  readonly opened_at: number;
  readonly advanced_at: number | null;
  readonly closed_at: number | null;
  readonly close_reason: string;
}

interface TrackRow {
  participant_id: string;
  candidate_ref: string;
  status: BetaTrackStatus;
  track_version: number;
  chain_version: number;
  pre_beta_version: number | null;
  canary_report_hash: string;
  canary_cycle_id: string;
  canary_calls: number;
  thresholds_json: string;
  opened_at: number;
  advanced_at: number | null;
  closed_at: number | null;
  close_reason: string;
}

function thresholdsOf(raw: string): BetaThresholds {
  try {
    const parsed = JSON.parse(raw) as Partial<BetaThresholds>;
    if (parsed && typeof parsed === 'object' && parsed.advance && parsed.rollback
      && Number.isFinite(parsed.advance.min_executions) && Number.isFinite(parsed.advance.min_duration_s)
      && Number.isFinite(parsed.rollback.min_executions) && Number.isFinite(parsed.rollback.max_failure_rate)) {
      return {
        advance: { min_executions: parsed.advance.min_executions, min_duration_s: parsed.advance.min_duration_s },
        rollback: { min_executions: parsed.rollback.min_executions, max_failure_rate: parsed.rollback.max_failure_rate },
      };
    }
  } catch {
    // fail-closed : seuils préenregistrés illisibles = défauts votés.
  }
  return DEFAULT_BETA_THRESHOLDS;
}

function trackOf(row: TrackRow): BetaTrack {
  return {
    participant_id: row.participant_id,
    candidate_ref: row.candidate_ref,
    status: row.status,
    track_version: row.track_version,
    chain_version: row.chain_version,
    pre_beta_version: row.pre_beta_version,
    canary_report_hash: row.canary_report_hash,
    canary_cycle_id: row.canary_cycle_id,
    canary_calls: row.canary_calls,
    thresholds: thresholdsOf(row.thresholds_json),
    opened_at: row.opened_at,
    advanced_at: row.advanced_at,
    closed_at: row.closed_at,
    close_reason: row.close_reason,
  };
}

const TRACK_COLUMNS = 'SELECT participant_id, candidate_ref, status, track_version, chain_version, pre_beta_version,'
  + ' canary_report_hash, canary_cycle_id, canary_calls, thresholds_json, opened_at, advanced_at, closed_at, close_reason'
  + ' FROM agent_model_beta';
const TRACK_BY_KEY = TRACK_COLUMNS + ' WHERE participant_id = ?1 AND candidate_ref = ?2';
const TRACK_BY_PARTICIPANT = TRACK_COLUMNS + ' WHERE participant_id = ?1 ORDER BY candidate_ref';
const TRACK_ALL = TRACK_COLUMNS + ' ORDER BY participant_id, candidate_ref';

export async function loadBetaTrack(db: D1Database, participantId: string, candidateRef: string): Promise<BetaTrack | null> {
  await ensureBetaSchema(db);
  const row = await db.prepare(TRACK_BY_KEY).bind(participantId, candidateRef).first<TrackRow>();
  return row ? trackOf(row) : null;
}

async function loadBetaTracks(db: D1Database, participantId?: string): Promise<BetaTrack[]> {
  await ensureBetaSchema(db);
  const rows = participantId !== undefined
    ? await db.prepare(TRACK_BY_PARTICIPANT).bind(participantId).all<TrackRow>()
    : await db.prepare(TRACK_ALL).all<TrackRow>();
  return rows.results.map(trackOf);
}

/**
 * Re-diagnostic typé d'un lot annulé par la garde (course CAS, halt posé entre
 * les lectures et le lot — revue #115 R1) : rien n'a été écrit, l'appelant
 * relit et rejoue. Jamais last-write-wins.
 */
export async function betaGuardRefused(db: D1Database, error: unknown, context: {
  participant_id: string;
  candidate_ref: string;
  expected_track_version: number | null;
  expected_chain_version: number | null;
  open_conflict?: boolean;
}): Promise<never> {
  if (error instanceof CollabStoreError) throw error;
  if (await isAutomationHalted(db)) {
    throw new CollabStoreError('AUTOMATION_HALTED', 'Arrêt d’urgence posé par le propriétaire : le lot a été annulé, rien n’est écrit.');
  }
  const track = await loadBetaTrack(db, context.participant_id, context.candidate_ref);
  if (context.expected_track_version !== null && (!track || track.track_version !== context.expected_track_version)) {
    throw new CollabStoreError('BETA_TRACK_STALE', 'Le suivi de bêta a changé entre-temps : rien n’est écrit, relisez et rejouez.');
  }
  if (context.open_conflict && track && (track.status === 'secours' || track.status === 'beta')) {
    throw new CollabStoreError('BETA_TRACK_OPEN', 'Un suivi de bêta est déjà ouvert pour ' + context.participant_id + ' / ' + context.candidate_ref + '.');
  }
  const chain = await loadModelChain(db, context.participant_id);
  if (context.expected_chain_version !== null && (!chain || chain.version !== context.expected_chain_version)) {
    throw new CollabStoreError('BETA_CHAIN_STALE', 'La chaîne de ' + context.participant_id + ' a changé : le suivi est périmé, rien n’est écrit.');
  }
  throw error instanceof Error ? error : new Error(String(error));
}

// ── Ouverture du suivi (preuve canary + chaîne porteuse) ─────────────────────

/** Preuve d'entrée : la tâche de promotion du lot S5 (branchCanaryToF2). */
export interface BetaCanaryProof {
  readonly cycle_id: string;
  /** Empreinte canonique du rapport canary (reportHashOf). */
  readonly report_hash: string;
  readonly calls: number;
  readonly verdict: string;
  readonly next?: string;
}

export interface OpenBetaTrackInput {
  readonly participant_id: string;
  readonly candidate_ref: string;
  readonly canary: BetaCanaryProof;
  /** Version de la chaîne lue par l'appelant (CAS : périmée = refus). */
  readonly expected_chain_version: number;
  readonly now: number;
}

export interface OpenBetaTrackResult {
  readonly status: 'applied' | 'duplicate';
  readonly track: BetaTrack;
  readonly chain_version: number;
}

/**
 * Ouvre le suivi de bêta d'une candidate que l'owner a posée en SECOURS
 * (statut rollback) dans sa chaîne : la preuve canary doit être une tâche de
 * promotion (verdict propose/auto_apply, next beta) d'au moins 20 appels, du
 * même cycle et la même candidate ; les seuils sont préenregistrés à
 * l'ouverture (recalibrables par lot ultérieur, jamais par ce chemin).
 * Rejeu idempotent (même empreinte) ; réouverture après fermeture autorisée
 * (nouvelle preuve, compteur de suivi monotone).
 */
export async function openBetaTrack(db: D1Database, input: OpenBetaTrackInput): Promise<OpenBetaTrackResult> {
  if (!PARTICIPANT_RE.test(input.participant_id)) {
    throw new CollabStoreError('BETA_PARTICIPANT_INVALID', 'Identifiant de participant invalide : ' + input.participant_id + '.');
  }
  if (!isPinnedRef(input.candidate_ref)) {
    throw new CollabStoreError('BETA_REF_INVALID', 'Candidate non épinglée : ' + input.candidate_ref + ' (jamais d’alias latest).');
  }
  if (input.canary.verdict !== 'propose' && input.canary.verdict !== 'auto_apply') {
    throw new CollabStoreError('BETA_PROPOSAL_INVALID', 'Un verdict ' + input.canary.verdict + ' ne produit rien : seules les tâches de promotion ouvrent un suivi.');
  }
  if (input.canary.next !== undefined && input.canary.next !== 'beta') {
    throw new CollabStoreError('BETA_PROPOSAL_INVALID', 'La tâche de promotion vise ' + input.canary.next + ' : seule la bêta ouvre un suivi.');
  }
  if (input.canary.calls < CANARY_MIN_CALLS) {
    throw new CollabStoreError('BETA_CANARY_INSUFFISANT', 'Canary insuffisant : ' + input.canary.calls + ' appels < ' + CANARY_MIN_CALLS + '.');
  }
  if (!HASH_RE.test(input.canary.report_hash) || !input.canary.cycle_id.trim()) {
    throw new CollabStoreError('BETA_PROOF_INVALID', 'Preuve canary invalide : empreinte (64 hex) et cycle requis.');
  }
  await ensureBetaSchema(db);
  await ensureModelChainSchema(db);
  await assertAutomationRunning(db);
  const chain = await loadModelChain(db, input.participant_id);
  if (!chain || !chain.active) {
    throw new CollabStoreError('BETA_CHAIN_ABSENT', 'Aucune chaîne active dans le store pour ' + input.participant_id + '.');
  }
  if (chain.version !== input.expected_chain_version) {
    throw new CollabStoreError('CHAIN_VERSION_STALE',
      'La chaîne de ' + input.participant_id + ' est à la version ' + chain.version + ', la demande en attendait ' + input.expected_chain_version + ' : rien n’est écrit.');
  }
  const entry = chain.chain.find(item => item.ref === input.candidate_ref);
  if (!entry) {
    throw new CollabStoreError('BETA_CANDIDATE_ABSENT', input.candidate_ref + ' n’est pas un maillon de la chaîne de ' + input.participant_id + '.');
  }
  if (entry.status !== 'rollback') {
    throw new CollabStoreError('BETA_ENTRY_NOT_SECOURS',
      input.candidate_ref + ' porte le statut ' + entry.status + ' : la bêta se mérite d’abord comme secours (rollback), posé par l’owner.');
  }
  const existing = await loadBetaTrack(db, input.participant_id, input.candidate_ref);
  if (existing && (existing.status === 'secours' || existing.status === 'beta')) {
    if (existing.canary_report_hash === input.canary.report_hash) {
      return { status: 'duplicate', track: existing, chain_version: chain.version };
    }
    throw new CollabStoreError('BETA_TRACK_OPEN', 'Un suivi est déjà ouvert pour ' + input.participant_id + ' / ' + input.candidate_ref + '.');
  }
  const thresholdsJson = JSON.stringify(DEFAULT_BETA_THRESHOLDS);
  const detail = 'preuve canary ' + input.canary.report_hash.slice(0, 12) + ' (' + input.canary.calls
    + ' appels, cycle ' + input.canary.cycle_id + '), chaîne v' + chain.version;
  try {
    await db.batch([
      betaGuard(db,
        '(SELECT version FROM agent_model_chains WHERE participant_id = ?1) = ?2'
        + " AND NOT EXISTS (SELECT 1 FROM agent_model_beta WHERE participant_id = ?1 AND candidate_ref = ?3 AND status IN ('secours','beta'))"
        + ' AND NOT ' + HALT_ACTIVE_SQL,
        [input.participant_id, chain.version, input.candidate_ref]),
      db.prepare([
        'INSERT INTO agent_model_beta (participant_id, candidate_ref, status, track_version, chain_version,',
        '  canary_report_hash, canary_cycle_id, canary_calls, thresholds_json, opened_at)',
        "VALUES (?1, ?2, 'secours', 1, ?3, ?4, ?5, ?6, ?7, ?8)",
        'ON CONFLICT(participant_id, candidate_ref) DO UPDATE SET',
        "  status = 'secours', track_version = agent_model_beta.track_version + 1, chain_version = excluded.chain_version,",
        '  canary_report_hash = excluded.canary_report_hash, canary_cycle_id = excluded.canary_cycle_id,',
        '  canary_calls = excluded.canary_calls, thresholds_json = excluded.thresholds_json,',
        "  opened_at = excluded.opened_at, pre_beta_version = NULL, advanced_at = NULL, closed_at = NULL, close_reason = ''",
        "WHERE agent_model_beta.status IN ('rolled_back','stale')",
      ].join(' ')).bind(input.participant_id, input.candidate_ref, chain.version,
        input.canary.report_hash, input.canary.cycle_id, input.canary.calls, thresholdsJson, input.now),
      betaEventInsert(db, input.now, input.participant_id, input.candidate_ref, 'open', detail),
      db.prepare(BETA_GUARD_CLEAR),
    ]);
  } catch (error) {
    await betaGuardRefused(db, error, {
      participant_id: input.participant_id,
      candidate_ref: input.candidate_ref,
      expected_track_version: null,
      expected_chain_version: chain.version,
      open_conflict: true,
    });
  }
  const track = await loadBetaTrack(db, input.participant_id, input.candidate_ref);
  if (!track) throw new CollabStoreError('BETA_TRACK_UNKNOWN', 'Suivi invisible après ouverture : lot annulé, rien n’est écrit.');
  return { status: 'applied', track, chain_version: chain.version };
}

// ── Exécutions comptées (append-only, idempotentes par run) ─────────────────

export interface BetaExecutionInput {
  readonly participant_id: string;
  readonly ref: string;
  readonly run_id: string;
  readonly at: number;
  readonly ok: boolean;
  readonly latency_ms?: number;
  readonly cost_micro_cents?: number;
}

export interface BetaExecutionResult {
  readonly recorded: boolean;
  readonly duplicate: boolean;
  readonly open_track: boolean;
}

/**
 * Compte une exécution du maillon suivi (une ligne par run, rejeu idempotent :
 * la même exécution ne compte jamais deux fois). Seuls les suivis ouverts
 * (secours ou bêta) enregistrent ; ce comptage est propre au suivi — distinct
 * du cumul global agent_model_calls et du coupe-circuit S1b-2, inchangés.
 */
export async function recordBetaExecution(db: D1Database, input: BetaExecutionInput): Promise<BetaExecutionResult> {
  await ensureBetaSchema(db);
  const track = await loadBetaTrack(db, input.participant_id, input.ref);
  if (!track || (track.status !== 'secours' && track.status !== 'beta')) {
    return { recorded: false, duplicate: false, open_track: false };
  }
  const saved = await db.prepare([
    'INSERT OR IGNORE INTO agent_model_beta_executions (participant_id, ref, run_id, at, ok, latency_ms, cost_micro_cents)',
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  ].join(' ')).bind(input.participant_id, input.ref, input.run_id, input.at, input.ok ? 1 : 0,
    input.latency_ms ?? 0, input.cost_micro_cents ?? 0).run();
  const recorded = (saved.meta.changes ?? 0) === 1;
  return { recorded, duplicate: !recorded, open_track: true };
}

// ── Métriques (lecture seule : vues /owner, contrôleur) ──────────────────────

export interface BetaStageMetrics {
  readonly executions: number;
  readonly ok: number;
  readonly failures: number;
  readonly failure_rate: number | null;
}

const ZERO_METRICS: BetaStageMetrics = Object.freeze({ executions: 0, ok: 0, failures: 0, failure_rate: null });

/** Métriques d'une fenêtre du suivi (borne haute nulle = jusqu'à maintenant). */
export async function stageMetrics(db: D1Database, participantId: string, ref: string, from: number, to: number | null): Promise<BetaStageMetrics> {
  const row = await db.prepare([
    'SELECT COUNT(*) AS executions, COALESCE(SUM(ok), 0) AS ok FROM agent_model_beta_executions',
    'WHERE participant_id = ?1 AND ref = ?2 AND at >= ?3 AND (?4 IS NULL OR at < ?4)',
  ].join(' ')).bind(participantId, ref, from, to).first<{ executions: number; ok: number }>();
  const executions = row?.executions ?? 0;
  const ok = row?.ok ?? 0;
  const failures = executions - ok;
  return { executions, ok, failures, failure_rate: executions > 0 ? failures / executions : null };
}

export interface BetaTrackMetrics extends BetaTrack {
  readonly secours_metrics: BetaStageMetrics;
  readonly beta_metrics: BetaStageMetrics;
  readonly advance_ready: boolean;
  readonly advance_blockers: readonly string[];
  readonly rollback_broken: boolean;
}

/** Heures arrondies, pour les messages de paliers. */
export function betaHours(seconds: number): number {
  return Math.round(seconds / 3600);
}

/**
 * Métriques des suivis de bêta (tous, ou un participant) : fenêtres par étape
 * (secours avant l'exposition, bêta depuis), seuils préenregistrés visibles,
 * paliers d'avance atteints ou non, santé de la bêta (rollback_broken).
 */
export async function betaMetrics(db: D1Database, options: { participant_id?: string; now?: number } = {}): Promise<BetaTrackMetrics[]> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tracks = await loadBetaTracks(db, options.participant_id);
  const out: BetaTrackMetrics[] = [];
  for (const track of tracks) {
    const secours = await stageMetrics(db, track.participant_id, track.candidate_ref, track.opened_at, track.advanced_at);
    const beta = track.advanced_at !== null
      ? await stageMetrics(db, track.participant_id, track.candidate_ref, track.advanced_at, track.closed_at)
      : ZERO_METRICS;
    const blockers: string[] = [];
    if (track.status === 'secours') {
      if (secours.executions < track.thresholds.advance.min_executions) {
        blockers.push(secours.executions + ' exécutions < ' + track.thresholds.advance.min_executions + ' requises');
      }
      if (now - track.opened_at < track.thresholds.advance.min_duration_s) {
        blockers.push(betaHours(now - track.opened_at) + ' h < ' + betaHours(track.thresholds.advance.min_duration_s) + ' h requises');
      }
    }
    const rollback_broken = track.status === 'beta' && beta.executions >= track.thresholds.rollback.min_executions
      && beta.failure_rate !== null && beta.failure_rate > track.thresholds.rollback.max_failure_rate;
    out.push({
      ...track,
      secours_metrics: secours,
      beta_metrics: beta,
      advance_ready: track.status === 'secours' && blockers.length === 0,
      advance_blockers: blockers,
      rollback_broken,
    });
  }
  return out;
}
