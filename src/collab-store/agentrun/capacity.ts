/**
 * CC-8 S1a (CC-PLAN-8, synthèse seq 1262, validée par Kevin) — capacité réelle d'un agent API.
 *
 * Constat du 2026-11-01 (cc8-systeme-unique) : le planificateur créait des exécutions pour des agents
 * qui ne pouvaient pas tourner (Claude, Grok : aucune clé ni budget dans leur famille). Elles échouaient
 * aussitôt en MODEL_BUDGET_EXHAUSTED mais occupaient les places du passage (PLAN_LIMIT), si bien que
 * Gemini, dernier de la liste, n'était jamais servi.
 *
 * `runCapacity` répond AVANT toute création : l'agent a-t-il, maintenant, un modèle abordable pour ce
 * type d'exécution ? Lecture seule, aucun appel réseau.
 * - Avec politique par agent : même calcul que le choix réel d'une étape (participantPolicy +
 *   budgetState + chooseModel, sans préférence : un modèle abordable existe-t-il dans la chaîne ?).
 * - Sans politique (référence unique participantModelRoute et son palier auto / free / paid) : la
 *   résolution PURE partagée avec la fabrique (resolveProviderRoute : fournisseur, liste gratuite ou
 *   payante, palier forcé, attestation, tarif daté), puis clé ou binding présent, puis, pour un canal
 *   payant, l'enveloppe de l'agent financée et le coût estimé d'une étape dans le budget restant.
 * - Ni politique ni référence : refus typé NO_MODEL.
 */
import { apiModelRate, centsOfApiTokens } from '../executors/model-rates';
import { resolveEffectiveMaxTokens } from '../executors/task-profiles';
import { budgetState, chooseModel, credentialPresent, ESTIMATE_INPUT_TOKENS, participantEnvelope, resolveParticipantPolicy,
  type PolicyEnv } from './model-policy';
import { centsOfNeurons, envelopeFunded, PAID_MODEL_RATES } from './paid-model';
import { breakerOpenUntil } from './model-policy';
import { breakerSkipping } from './run-policy';
import { participantModelRoute, resolveProviderRoute, type ProviderRoute } from './provider-models';
// CC-8 S8a : pause serveur réversible (acte owner set_agent_run_status) — garde AVANT toute résolution.
import { agentRunPaused } from '../owner/agent-run-status';

export interface RunCapacity {
  capable: boolean;
  /** Modèle qui serait choisi (capable) ou refus typé `CODE : détail` (incapable). */
  reason: string;
}

function errorText(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  return (typeof code === 'string' ? code + ' : ' : '') + message;
}

export async function runCapacity(db: D1Database, env: object, participantId: string, cycleId: string | null,
  kind: string, now: Date): Promise<RunCapacity> {
  // CC-8 S8a : pause serveur réversible (acte owner set_agent_run_status) — AVANT toute politique,
  // route ou sonde : un participant en pause ne reçoit AUCUN réveil, aucune exécution n'est créée
  // pour lui. Fail-closed sur les deux axes : sans ligne dans agent_run_status, le participant est
  // actif (jamais de pause implicite) ; une lecture IMPOSSIBLE ne le déclare pas actif pour autant —
  // refus typé RUN_STATUS_UNAVAILABLE, aucune exécution ni sonde (reprise au passage suivant).
  let paused: boolean;
  try {
    paused = await agentRunPaused(db, participantId);
  } catch (error) {
    return { capable: false, reason: 'RUN_STATUS_UNAVAILABLE : statut de réveil de ' + participantId
      + ' illisible (' + errorText(error) + ') ; aucune exécution ni sonde ne lui est confiée' };
  }
  if (paused) {
    return { capable: false, reason: 'AGENT_PAUSED : ' + participantId + ' est en pause serveur (acte owner set_agent_run_status) ; aucun réveil ne lui est confié' };
  }
  const policyEnv = env as PolicyEnv;
  let policy;
  try {
    // CC-8 S3 : chaîne du store d'abord, sinon défauts wrangler — même résolution que le choix réel d'une étape.
    policy = (await resolveParticipantPolicy(db, policyEnv, participantId)).policy;
  } catch (error) {
    return { capable: false, reason: 'MODEL_POLICY_INVALID : ' + errorText(error) };
  }
  if (policy) {
    // CC-8 S1a 2/3 : refus anticipé — mêmes maillons que le routage réel après coupe-circuit
    // S1b-2 (option B, participant × modèle). Tous en pause → CIRCUIT_OPEN, aucune exécution
    // créée (le routage échouerait aussitôt). Les sondes (probe) restent exemptées.
    const nowSec = Math.floor(now.getTime() / 1000);
    let models = policy.models;
    if (kind !== 'probe' && models.length) {
      const open = await breakerOpenUntil(db, participantId, models);
      models = models.filter(ref => !breakerSkipping({ circuit_open_until: open.get(ref) ?? 0 }, nowSec));
      if (!models.length) {
        return { capable: false, reason: 'CIRCUIT_OPEN : tous les maillons de ' + participantId + ' sont en pause coupe-circuit ('
          + policy.models.map(ref => ref + ' jusqu’à ' + (open.get(ref) ?? 0)).join(', ') + ')' };
      }
    }
    const budget = await budgetState(db, policy.envelope, participantId, cycleId, now);
    try {
      return { capable: true, reason: chooseModel(policyEnv, { ...policy, models }, kind, budget, null).ref };
    } catch (error) {
      return { capable: false, reason: errorText(error) };
    }
  }
  const route = participantModelRoute(env as Parameters<typeof participantModelRoute>[0], participantId);
  if (!route) return { capable: false, reason: 'NO_MODEL : aucune politique ni modèle global' };
  let resolved: ProviderRoute;
  try {
    resolved = resolveProviderRoute(route.ref, route.tier, policyEnv, policyEnv.AI !== undefined && policyEnv.AI !== null);
  } catch (error) {
    return { capable: false, reason: 'MODEL_ROUTE_REFUSED : ' + route.ref + ' (palier ' + route.tier + ') — ' + errorText(error) };
  }
  if (!credentialPresent(policyEnv, route.ref)) {
    return { capable: false, reason: 'MODEL_ROUTE_REFUSED : ' + route.ref + ' — clé ou binding absent' };
  }
  if (kind !== 'probe') {
    const open = (await breakerOpenUntil(db, participantId, [route.ref])).get(route.ref) ?? 0;
    if (breakerSkipping({ circuit_open_until: open }, Math.floor(now.getTime() / 1000))) {
      return { capable: false, reason: 'CIRCUIT_OPEN : ' + route.ref + ' en pause coupe-circuit jusqu’à ' + open };
    }
  }
  if (resolved.free) return { capable: true, reason: route.ref };
  // Canal payant : enveloppe de l'agent financée (refus de la fabrique sinon) et une étape dans le budget restant.
  const envelope = participantEnvelope(policyEnv, participantId);
  const budget = await budgetState(db, envelope, participantId, cycleId, now);
  const cost = paidStepCents(resolved, route.ref, kind);
  if (!envelopeFunded(envelope) || cost > budget.day_limit - budget.day_spent || cost > budget.cycle_limit - budget.cycle_spent) {
    return { capable: false, reason: 'MODEL_BUDGET_EXHAUSTED : ' + route.ref + ' (palier ' + route.tier + ', ' + cost + 'c par étape) ; budget restant jour '
      + (budget.day_limit - budget.day_spent) + 'c, cycle ' + (budget.cycle_limit - budget.cycle_spent) + 'c' };
  }
  return { capable: true, reason: route.ref };
}

/** Coût estimé prudent d'une étape payante (même entrée estimée que la politique, sortie plafonnée du type de tâche). */
function paidStepCents(resolved: ProviderRoute, ref: string, kind: string): number {
  const output = resolveEffectiveMaxTokens({ task_kind: kind });
  if (resolved.provider === 'workers-ai') {
    const rates = PAID_MODEL_RATES[resolved.model];
    return centsOfNeurons(Math.ceil((ESTIMATE_INPUT_TOKENS * rates.input_per_m + output * rates.output_per_m) / 1_000_000));
  }
  const rate = apiModelRate(ref);
  return rate ? centsOfApiTokens(rate, ESTIMATE_INPUT_TOKENS, output) : Number.POSITIVE_INFINITY;
}

// ──────────────────────────────────────────────────────────────────────────────
// CC-8 S1a 2/3 — capacité JOURNALISÉE et vue du coordinateur sur les exécutions.
// Le planificateur consigne, à chaque passage, le verdict de capacité de chaque
// (agent, cycle, type) qu'il évalue : refus typé ou modèle retenu. La vue du
// coordinateur lit ce journal, les exécutions et le coupe-circuit — jamais de
// contenu privé (ni consigne, ni résumé, ni sortie de modèle).
// ──────────────────────────────────────────────────────────────────────────────

/** Table interne (hors schéma canonique gelé) : dernier verdict de capacité par agent, cycle et type. */
const CAPACITY_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS agent_run_capacity (',
  '  participant_id TEXT NOT NULL,',
  '  cycle_id TEXT NOT NULL,',
  '  task_kind TEXT NOT NULL,',
  '  capable INTEGER NOT NULL,',
  '  reason TEXT NOT NULL,',
  '  checked_at INTEGER NOT NULL,',
  '  PRIMARY KEY (participant_id, cycle_id, task_kind)',
  ')',
].join(' ');

const capacitySchemaEnsured = new WeakSet<object>();

export async function ensureCapacitySchema(db: D1Database): Promise<void> {
  if (capacitySchemaEnsured.has(db as unknown as object)) return;
  await db.prepare(CAPACITY_SCHEMA).run();
  capacitySchemaEnsured.add(db as unknown as object);
}

/** Motif typé borné : jamais de contenu libre au-delà de 300 caractères. */
export const CAPACITY_REASON_MAX = 300;

/** Consigne le verdict (upsert : une ligne par agent, cycle et type). Une panne d'écriture n'arrête jamais le passage. */
export async function recordCapacity(db: D1Database, input: { participant_id: string; cycle_id: string; kind: string;
  capacity: RunCapacity; now: number }): Promise<void> {
  try {
    await ensureCapacitySchema(db);
    await db.prepare([
      'INSERT INTO agent_run_capacity (participant_id, cycle_id, task_kind, capable, reason, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      'ON CONFLICT(participant_id, cycle_id, task_kind) DO UPDATE SET capable = excluded.capable, reason = excluded.reason, checked_at = excluded.checked_at',
    ].join(' ')).bind(input.participant_id, input.cycle_id, input.kind, input.capacity.capable ? 1 : 0,
      input.capacity.reason.slice(0, CAPACITY_REASON_MAX), input.now).run();
  } catch {
    // journal de capacité best-effort : la décision du passage (créer ou non) ne dépend pas de lui
  }
}

/** Code typé d'une raison d'arrêt (« model_error: MODEL_BUDGET_EXHAUSTED : … » → model_error / MODEL_BUDGET_EXHAUSTED), sans détail. */
export function stopReasonCode(stopReason: string): string {
  const trimmed = stopReason.trim();
  if (!trimmed) return '';
  const prefix = /^([a-z_]+):\s*/.exec(trimmed);
  const rest = prefix ? trimmed.slice(prefix[0].length) : trimmed;
  const code = /^([A-Z][A-Z0-9_]{2,})\b/.exec(rest)?.[1];
  return [prefix?.[1], code].filter(Boolean).join(':') || trimmed.slice(0, 40);
}

export interface RunOverviewRow {
  run_id: string; participant_id: string; task_id: string; task_kind: string; status: string;
  stop_code: string; steps_done: number; tokens_used: number; cost_cents: number; created_at: number; updated_at: number;
}

export interface CoordinatorRunOverview {
  cycle_id: string;
  generated_at: number;
  /** Comptes par agent et par statut d'exécution (tout le cycle). */
  counts: Array<{ participant_id: string; status: string; runs: number }>;
  /** Exécutions les plus récentes du cycle (métadonnées seulement). */
  runs: RunOverviewRow[];
  /** Dernier verdict de capacité du planificateur, par agent et type. */
  capacity: Array<{ participant_id: string; task_kind: string; capable: boolean; reason: string; checked_at: number }>;
  /** Maillons en pause coupe-circuit S1b-2 (agents du cycle). */
  breaker: Array<{ participant_id: string; ref: string; consecutive_failures: number; open_until: number }>;
}

/**
 * Vue du coordinateur (lecture seule) : état des exécutions de TOUS les agents d'un cycle,
 * verdicts de capacité et coupe-circuit. Métadonnées seulement — la consigne (prompt), le
 * résumé et toute sortie de modèle ne sont jamais lus ; la raison d'arrêt est réduite à son code.
 */
export async function coordinatorRunOverview(db: D1Database, cycleId: string, input: { now: number; limit?: number }): Promise<CoordinatorRunOverview> {
  await ensureCapacitySchema(db);
  const limit = Math.max(1, Math.min(input.limit ?? 40, 100));
  const runsTable = await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'").first<{ ok: number }>();
  let counts: CoordinatorRunOverview['counts'] = [];
  let runs: RunOverviewRow[] = [];
  if (runsTable) {
    counts = (await db.prepare('SELECT participant_id, status, COUNT(*) AS runs FROM agent_runs WHERE cycle_id = ?1 GROUP BY participant_id, status ORDER BY participant_id, status')
      .bind(cycleId).all<{ participant_id: string; status: string; runs: number }>()).results ?? [];
    const rows = (await db.prepare([
      'SELECT run_id, participant_id, task_id, task_kind, status, stop_reason, steps_done, tokens_used, cost_cents, created_at, updated_at',
      'FROM agent_runs WHERE cycle_id = ?1 ORDER BY updated_at DESC, run_id LIMIT ?2',
    ].join(' ')).bind(cycleId, limit).all<RunOverviewRow & { stop_reason: string }>()).results ?? [];
    runs = rows.map(({ stop_reason, ...row }) => ({ ...row, stop_code: stopReasonCode(stop_reason ?? '') }));
  }
  const capacity = ((await db.prepare('SELECT participant_id, task_kind, capable, reason, checked_at FROM agent_run_capacity WHERE cycle_id = ?1 ORDER BY participant_id, task_kind')
    .bind(cycleId).all<{ participant_id: string; task_kind: string; capable: number; reason: string; checked_at: number }>()).results ?? [])
    .map(row => ({ ...row, capable: row.capable === 1 }));
  const participants = [...new Set([...counts.map(row => row.participant_id), ...capacity.map(row => row.participant_id)])];
  let breaker: CoordinatorRunOverview['breaker'] = [];
  const breakerTable = await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'agent_model_breaker'").first<{ ok: number }>();
  if (breakerTable && participants.length) {
    const placeholders = participants.map((_, index) => '?' + (index + 2)).join(', ');
    breaker = ((await db.prepare('SELECT participant_id, ref, consecutive_transient_failures AS consecutive_failures, circuit_open_until AS open_until FROM agent_model_breaker'
      + ' WHERE circuit_open_until > ?1 AND participant_id IN (' + placeholders + ') ORDER BY participant_id, ref')
      .bind(input.now, ...participants).all<CoordinatorRunOverview['breaker'][number]>()).results ?? []);
  }
  return { cycle_id: cycleId, generated_at: input.now, counts, runs, capacity, breaker };
}
