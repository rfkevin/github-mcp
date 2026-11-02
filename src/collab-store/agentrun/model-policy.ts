/**
 * CC-7 L9a (plan seq 1000, validé par Kevin le 2026-10-27) — choix libre du modèle,
 * à l'intérieur de la FAMILLE de chaque agent, sous son budget.
 *
 * Kevin fixe, par agent (variables du Worker) :
 * - AGENT_RUN_FAMILY_<P> : la famille (anthropic, xai, zai, google, openai, deepseek,
 *   qwen, meta, mistral) — garantit la diversité des avis ;
 * - AGENT_RUN_MODELS_<P> : les modèles autorisés, du plus fort au plus léger, en
 *   direct ou via OpenRouter (canal, pas famille : un modèle OpenRouter est classé
 *   par son fabricant) ; un modèle d'une autre famille est écarté et signalé ;
 * - AGENT_RUN_PAID_DAY_CENTS_<P> / AGENT_RUN_PAID_CYCLE_CENTS_<P> : son budget payant
 *   (prioritaire sur l'enveloppe commune AGENT_RUN_PAID_PARTICIPANT_*) ; 0 = gratuit seulement.
 *
 * À chaque étape, le serveur choisit : préférence posée (par l'agent pour lui-même ou
 * par le coordinateur) si elle est abordable, sinon l'option abordable suivante dans
 * la liste (descente journalisée, jamais cachée) ; sans préférence, le plus fort
 * abordable pour review / test / implement, le moins cher pour design / answer.
 * Abordable = gratuit permis (clé présente, attestation si exigée), ou coût estimé
 * d'une étape ≤ budget restant du jour ET du cycle. Rien d'abordable :
 * MODEL_BUDGET_EXHAUSTED, aucun appel. Chaque choix est journalisé.
 */
import { FREE_MODEL_RATES } from '../executors/adapter';
import { apiModelRate, API_RATE_SNAPSHOT_DATE, centsOfApiTokens } from '../executors/model-rates';
import { resolveEffectiveMaxTokens } from '../executors/task-profiles';
import { CollabStoreError } from '../store/collab-store';
import { MAX_PAID_CENTS, parseParticipantEnvelope, participantCycleKey, participantDayKeys,
  type ParticipantEnvelope, type ParticipantEnvelopeEnv } from './paid-model';
import { apiParticipants } from './plan';
import { defaultEffort, effortMaxTokens, effortsDownFrom, effortSupported, isEffort, type Effort } from './effort';
import { freeAllowed, isFreeApiModel, participantModelRoute, participantModelVar, type ApiProvider, type ProviderEnv } from './provider-models';
// CC-8 S3 (CC-PLAN-8 §1.6) — fiche canonique : la chaîne du store ne fait que référencer ses définitions (F1, fail-on-diff).
import { parseFiche, type Fiche } from './fiche';
import { FICHE_RAW } from './generated/agent-fiche.generated';
// CC-8 S1b-2 : règles pures du coupe-circuit (option B) — l’application SQL vit ici.
import { breakerAfterFailure, breakerAfterSuccess, type BreakerRow } from './run-policy';

export const MODEL_FAMILIES = ['anthropic', 'xai', 'zai', 'google', 'openai', 'deepseek', 'qwen', 'meta', 'mistral'] as const;
export type ModelFamily = typeof MODEL_FAMILIES[number];
/** Au plus ce nombre de modèles par agent. */
export const POLICY_MAX_MODELS = 12;
/** Jetons d'entrée supposés pour estimer une étape (borne prudente, le réel est réglé après l'appel). */
export const ESTIMATE_INPUT_TOKENS = 16_000;
/** Tarif relevé depuis plus de ce nombre de jours : signalé « à revalider » dans le catalogue. */
export const RATE_STALE_DAYS = 30;
/** Kinds où le plus fort abordable est choisi par défaut ; les autres prennent le moins cher. */
export const STRONG_KINDS: readonly string[] = Object.freeze(['review', 'test', 'implement']);

const VENDOR_FAMILY: Readonly<Record<string, ModelFamily>> = {
  anthropic: 'anthropic', 'x-ai': 'xai', xai: 'xai', 'z-ai': 'zai', 'zai-org': 'zai', google: 'google', openai: 'openai',
  deepseek: 'deepseek', 'deepseek-ai': 'deepseek', qwen: 'qwen', 'meta-llama': 'meta', meta: 'meta', mistralai: 'mistral', mistral: 'mistral',
};
const DIRECT_FAMILY: Readonly<Record<string, ModelFamily>> = { anthropic: 'anthropic', xai: 'xai', zai: 'zai', gemini: 'google', deepseek: 'deepseek' };

/** Vraie famille d'une référence, quel que soit le canal (direct, Workers AI, Groq, OpenRouter) ; null = inconnue. */
export function familyOf(ref: string): ModelFamily | null {
  const colon = ref.indexOf(':');
  if (colon <= 0) return null;
  const provider = ref.slice(0, colon);
  const model = ref.slice(colon + 1);
  if (DIRECT_FAMILY[provider]) return DIRECT_FAMILY[provider];
  if (provider === 'workers-ai') {
    const match = /^@cf\/([a-z0-9-]+)\//.exec(model);
    return match ? VENDOR_FAMILY[match[1]] ?? null : null;
  }
  if (provider === 'groq' || provider === 'openrouter') {
    const slash = model.indexOf('/');
    if (slash > 0) return VENDOR_FAMILY[model.slice(0, slash)] ?? null;
    if (provider === 'groq' && /^llama/i.test(model)) return 'meta';
    return null;
  }
  return null;
}

/** Secret ou binding exigé par le canal d'une référence (présence seulement, jamais la valeur). */
export function credentialOf(ref: string): string {
  const provider = ref.slice(0, Math.max(0, ref.indexOf(':')));
  const map: Readonly<Record<string, string>> = { anthropic: 'LLM_KEY_ANTHROPIC', xai: 'LLM_KEY_XAI', zai: 'LLM_KEY_ZAI',
    gemini: 'LLM_KEY_GEMINI', groq: 'LLM_KEY_GROQ', openrouter: 'LLM_KEY_OPENROUTER', deepseek: 'LLM_KEY_DEEPSEEK', 'workers-ai': 'AI' };
  return map[provider] ?? '';
}

/** Vue du Worker lue par la politique : variables connues plus les variables par agent (AGENT_RUN_FAMILY_<P>, AGENT_RUN_MODELS_<P>…). */
export type PolicyEnv = ProviderEnv & ParticipantEnvelopeEnv & { AGENT_RUN_PARTICIPANTS?: string; AGENT_RUN_MODEL?: string; AGENT_RUN_PAID_MODEL?: string; AI?: unknown }
  & { readonly [key: string]: unknown };

function suffix(participantId: string): string {
  return participantModelVar(participantId).slice('AGENT_RUN_MODEL_'.length);
}
function envString(env: object, key: string): string | undefined {
  const value = (env as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export interface ParticipantPolicy {
  participant_id: string;
  family: ModelFamily;
  /** Modèles retenus, dans l'ordre de Kevin (du plus fort au plus léger). */
  models: string[];
  /** Modèles écartés à la lecture, avec la raison (famille, format, doublon, nombre). */
  rejected: Array<{ ref: string; reason: string }>;
  envelope: ParticipantEnvelope;
}

/** Enveloppe d'un agent : ses variables propres, sinon l'enveloppe commune (L2). */
export function participantEnvelope(env: PolicyEnv, participantId: string): ParticipantEnvelope {
  const common = parseParticipantEnvelope(env);
  const own = (key: string) => {
    const raw = envString(env, key + '_' + suffix(participantId));
    if (raw === undefined) return null;
    const value = /^\d{1,8}$/.test(raw.trim()) ? Number(raw.trim()) : 0;
    return Math.min(value, MAX_PAID_CENTS);
  };
  const day = own('AGENT_RUN_PAID_DAY_CENTS');
  const cycle = own('AGENT_RUN_PAID_CYCLE_CENTS');
  return { ...common, dayCents: day ?? common.dayCents, cycleCents: cycle ?? common.cycleCents };
}

/** Politique d'un agent, ou null s'il n'en a pas (aiguillage L8 inchangé). */
export function participantPolicy(env: PolicyEnv, participantId: string): ParticipantPolicy | null {
  const familyRaw = envString(env, 'AGENT_RUN_FAMILY_' + suffix(participantId))?.trim().toLowerCase();
  const modelsRaw = envString(env, 'AGENT_RUN_MODELS_' + suffix(participantId));
  if (!familyRaw || !modelsRaw || !modelsRaw.trim()) return null;
  if (!(MODEL_FAMILIES as readonly string[]).includes(familyRaw)) {
    throw new CollabStoreError('MODEL_FAMILY_UNKNOWN', 'Famille inconnue pour ' + participantId + ' : ' + familyRaw + ' (' + MODEL_FAMILIES.join(', ') + ').');
  }
  const family = familyRaw as ModelFamily;
  const models: string[] = [];
  const rejected: ParticipantPolicy['rejected'] = [];
  for (const item of modelsRaw.split(',')) {
    const ref = item.trim();
    if (!ref) continue;
    if (!/^[a-z][a-z-]{1,15}:\S{1,200}$/.test(ref)) rejected.push({ ref, reason: 'format' });
    else if (familyOf(ref) !== family) rejected.push({ ref, reason: 'famille ' + (familyOf(ref) ?? 'inconnue') + ' ≠ ' + family });
    else if (models.includes(ref)) rejected.push({ ref, reason: 'doublon' });
    else if (models.length >= POLICY_MAX_MODELS) rejected.push({ ref, reason: 'plus de ' + POLICY_MAX_MODELS + ' modèles' });
    else models.push(ref);
  }
  return { participant_id: participantId, family, models, rejected, envelope: participantEnvelope(env, participantId) };
}

export interface ModelOption {
  ref: string;
  /** free : gratuit permis ; paid : tarif daté ; unavailable : ni l'un ni l'autre ici. */
  tier: 'free' | 'paid' | 'unavailable';
  credential_present: boolean;
  /** Coût estimé d'une étape (cents US, pire cas prudent) ; 0 en gratuit, null si indisponible. */
  est_step_cents: number | null;
  reason?: string;
}

export function credentialPresent(env: PolicyEnv, ref: string): boolean {
  const name = credentialOf(ref);
  if (!name) return false;
  const value = (env as Record<string, unknown>)[name];
  return name === 'AI' ? value !== undefined && value !== null : typeof value === 'string' && value.trim() !== '';
}

/** Gratuit, payant ou indisponible pour CET environnement, et coût estimé d'une étape pour ce type de tâche et ce niveau de réflexion. */
export function modelOption(env: PolicyEnv, ref: string, kind: string, effort: Effort | null = null): ModelOption {
  const provider = ref.slice(0, ref.indexOf(':')) as ApiProvider;
  const credential = credentialPresent(env, ref);
  const model = ref.slice(ref.indexOf(':') + 1);
  const free = provider === 'workers-ai' ? FREE_MODEL_RATES[model] !== undefined : isFreeApiModel(ref) && freeAllowed(provider, env);
  if (free) {
    return credential ? { ref, tier: 'free', credential_present: true, est_step_cents: 0 }
      : { ref, tier: 'unavailable', credential_present: false, est_step_cents: null, reason: 'clé ou binding absent' };
  }
  const rate = apiModelRate(ref);
  if (!rate) return { ref, tier: 'unavailable', credential_present: credential, est_step_cents: null, reason: 'ni gratuit permis ni tarif daté' };
  // CC-7 L9b : la réflexion relève le plafond de sortie de l'étape, donc le pire cas estimé.
  const base = resolveEffectiveMaxTokens({ task_kind: kind });
  const est = centsOfApiTokens(rate, ESTIMATE_INPUT_TOKENS, effort && effortSupported(ref) ? effortMaxTokens(base, effort) : base);
  return credential ? { ref, tier: 'paid', credential_present: true, est_step_cents: est }
    : { ref, tier: 'unavailable', credential_present: false, est_step_cents: est, reason: 'clé absente' };
}

export interface BudgetState { day_limit: number; day_spent: number; cycle_limit: number; cycle_spent: number }

async function counter(db: D1Database, key: string): Promise<number> {
  return (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(key).first<{ writes: number }>())?.writes ?? 0;
}

/** Budget payant restant d'un agent (registres L2 par participant). */
export async function budgetState(db: D1Database, envelope: ParticipantEnvelope, participantId: string, cycleId: string | null, now: Date): Promise<BudgetState> {
  const day = now.toISOString().slice(0, 10);
  return {
    day_limit: envelope.dayCents, day_spent: await counter(db, participantDayKeys(participantId, day).cents),
    cycle_limit: envelope.cycleCents, cycle_spent: cycleId ? await counter(db, participantCycleKey(participantId, cycleId)) : 0,
  };
}

function affordable(option: ModelOption, budget: BudgetState): boolean {
  if (option.tier === 'free') return true;
  if (option.tier !== 'paid' || option.est_step_cents === null) return false;
  return option.est_step_cents <= budget.day_limit - budget.day_spent && option.est_step_cents <= budget.cycle_limit - budget.cycle_spent;
}

export interface ModelChoice { ref: string; chosen_by: string; reason: string; est_step_cents: number; tier: 'free' | 'paid';
  /** CC-7 L9b : niveau de réflexion retenu (null = le fournisseur n'a pas de réglage). */
  effort: Effort | null }
/** Préférence posée : modèle et, depuis L9b, niveau de réflexion facultatif. */
export interface ModelPreference { ref: string; set_by: string; effort?: Effort | null }

/**
 * Choix d'une étape : préférence abordable, sinon descente dans la liste, sinon règle par défaut ; rien d'abordable = refus.
 * CC-7 L9b : pour chaque modèle, le niveau de réflexion demandé (préférence, sinon défaut du type de tâche) puis les
 * niveaux plus légers, avant de passer au modèle suivant ; une préférence hors liste est ignorée ET journalisée.
 */
export function chooseModel(env: PolicyEnv, policy: ParticipantPolicy, kind: string, budget: BudgetState,
  preference: ModelPreference | null): ModelChoice {
  const wanted: Effort = preference?.effort ?? defaultEffort(kind);
  const fit = (ref: string): { option: ModelOption; effort: Effort | null } | null => {
    if (!effortSupported(ref)) {
      const option = modelOption(env, ref, kind, null);
      return affordable(option, budget) ? { option, effort: null } : null;
    }
    for (const effort of effortsDownFrom(wanted)) {
      const option = modelOption(env, ref, kind, effort);
      if (affordable(option, budget)) return { option, effort };
    }
    return null;
  };
  const pick = (found: { option: ModelOption; effort: Effort | null }, chosenBy: string, reason: string): ModelChoice => ({
    ref: found.option.ref, chosen_by: chosenBy, est_step_cents: found.option.est_step_cents ?? 0,
    tier: found.option.tier === 'free' ? 'free' : 'paid', effort: found.effort,
    reason: reason + (found.effort && found.effort !== wanted ? ' ; réflexion ' + found.effort + ' au lieu de ' + wanted + ' (budget)' : ''),
  });
  let note = '';
  if (preference) {
    const index = policy.models.indexOf(preference.ref);
    if (index < 0) {
      note = 'préférence ' + preference.ref + ' hors liste ignorée ; ';
    } else {
      const own = fit(preference.ref);
      if (own) return pick(own, preference.set_by, 'préférence');
      for (const ref of policy.models.slice(index + 1)) {
        const lower = fit(ref);
        if (lower) return pick(lower, 'serveur', 'préférence ' + preference.ref + ' non abordable (budget) : option suivante');
      }
    }
  }
  const fits = policy.models.map(fit).filter((found): found is { option: ModelOption; effort: Effort | null } => found !== null);
  if (!fits.length) {
    const options = policy.models.map(ref => modelOption(env, ref, kind, 'low'));
    throw new CollabStoreError('MODEL_BUDGET_EXHAUSTED', 'Aucun modèle abordable pour ' + policy.participant_id + ' (' + kind + ') : '
      + options.map(option => option.ref + '=' + (option.tier === 'unavailable' ? option.reason : option.est_step_cents + 'c')).join(', ')
      + ' ; budget restant jour ' + (budget.day_limit - budget.day_spent) + 'c, cycle ' + (budget.cycle_limit - budget.cycle_spent) + 'c.');
  }
  if (STRONG_KINDS.includes(kind)) return pick(fits[0], 'serveur', note + 'défaut : le plus fort abordable (' + kind + ')');
  const cheapest = fits.reduce((best, found) => (found.option.est_step_cents ?? 0) < (best.option.est_step_cents ?? 0) ? found : best, fits[0]);
  return pick(cheapest, 'serveur', note + 'défaut : le moins cher (' + kind + ')');
}

export const MODEL_POLICY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agent_model_prefs (cycle_id TEXT NOT NULL, participant_id TEXT NOT NULL, task_id TEXT NOT NULL,
    ref TEXT NOT NULL, set_by TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, effort TEXT, PRIMARY KEY (cycle_id, participant_id, task_id))`,
  `CREATE TABLE IF NOT EXISTS agent_model_choices (run_id TEXT NOT NULL, n INTEGER NOT NULL, participant_id TEXT NOT NULL,
    ref TEXT NOT NULL, chosen_by TEXT NOT NULL, reason TEXT NOT NULL, est_step_cents INTEGER NOT NULL, at INTEGER NOT NULL, effort TEXT, PRIMARY KEY (run_id, n))`,
  `CREATE TABLE IF NOT EXISTS agent_model_calls (ref TEXT PRIMARY KEY, ok INTEGER NOT NULL DEFAULT 0, err INTEGER NOT NULL DEFAULT 0,
    last_ok_at INTEGER, last_err_at INTEGER, last_error TEXT, last_latency_ms INTEGER)`,
  // CC-8 S1b-2 (v2 point 7, option B) : coupe-circuit PAR PARTICIPANT × MODÈLE — une ligne par maillon.
  `CREATE TABLE IF NOT EXISTS agent_model_breaker (participant_id TEXT NOT NULL, ref TEXT NOT NULL,
    consecutive_transient_failures INTEGER NOT NULL DEFAULT 0, last_failure_at INTEGER, circuit_open_until INTEGER NOT NULL DEFAULT 0,
    probe_until INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (participant_id, ref))`,
] as const;

/** Colonnes ajoutées aux tables déjà créées (ALTER idempotent : colonne existante ignorée). */
const MODEL_POLICY_COLUMNS = [['agent_model_prefs', 'effort', 'TEXT'], ['agent_model_choices', 'effort', 'TEXT'],
  // CC-8 S1b-2 (relecture D12 #255, bloquant 2) : bail de sonde post-pause du coupe-circuit.
  ['agent_model_breaker', 'probe_until', 'INTEGER NOT NULL DEFAULT 0']] as const;
const migrated = new WeakSet<D1Database>();

export async function ensureModelPolicySchema(db: D1Database): Promise<void> {
  await db.batch(MODEL_POLICY_SCHEMA.map(statement => db.prepare(statement)));
  if (migrated.has(db)) return;
  for (const [table, column, type] of MODEL_POLICY_COLUMNS) {
    const columns = (await db.prepare('PRAGMA table_info(' + table + ')').all<{ name: string }>()).results;
    if (!columns.some(row => row.name === column)) await db.prepare('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type).run();
  }
  migrated.add(db);
}

/** Préférence de la tâche, sinon de l'agent pour tout le cycle (task_id ''). */
export async function modelPreference(db: D1Database, cycleId: string, participantId: string, taskId: string): Promise<ModelPreference | null> {
  await ensureModelPolicySchema(db);
  const row = await db.prepare([
    'SELECT ref, set_by, effort FROM agent_model_prefs WHERE cycle_id = ?1 AND participant_id = ?2 AND task_id IN (?3, \'\')',
    'ORDER BY CASE WHEN task_id = ?3 THEN 0 ELSE 1 END LIMIT 1',
  ].join(' ')).bind(cycleId, participantId, taskId).first<{ ref: string; set_by: string; effort: string | null }>();
  return row ? { ref: row.ref, set_by: row.set_by, effort: isEffort(row.effort) ? row.effort : null } : null;
}

/**
 * Pose (ou retire, ref null) la préférence de modèle d'un agent : l'agent pour lui-même, ou un
 * coordinateur actif pour n'importe quel agent. Le modèle doit être dans la liste de l'agent.
 */
export async function setModelPreference(db: D1Database, env: PolicyEnv, input: {
  actor: string; actorIsCoordinator: boolean; cycleId: string; participantId: string; taskId?: string; ref: string | null; reason?: string; now: number;
  /** CC-7 L9b : niveau de réflexion facultatif (low, medium, high, xhigh). */
  effort?: string | null;
}): Promise<{ status: 'set' | 'cleared'; ref: string | null; task_id: string; effort?: Effort | null }> {
  if (input.actor !== input.participantId && !input.actorIsCoordinator) {
    throw new CollabStoreError('MODEL_CHOICE_FORBIDDEN', 'Seul l’agent lui-même ou un coordinateur actif choisit le modèle de ' + input.participantId + '.');
  }
  const taskId = input.taskId ?? '';
  if (!/^[a-z0-9_-]{1,64}$/i.test(input.cycleId) || (taskId && !/^[a-z0-9_-]{1,64}$/i.test(taskId))) {
    throw new CollabStoreError('MODEL_CHOICE_INVALID', 'Cycle ou tâche invalide.');
  }
  await ensureModelPolicySchema(db);
  if (input.ref === null) {
    await db.prepare('DELETE FROM agent_model_prefs WHERE cycle_id = ?1 AND participant_id = ?2 AND task_id = ?3')
      .bind(input.cycleId, input.participantId, taskId).run();
    return { status: 'cleared', ref: null, task_id: taskId };
  }
  // CC-8 S3 : la préférence se valide contre la liste effective — chaîne du store d'abord, sinon défauts wrangler.
  const policy = (await resolveParticipantPolicy(db, env, input.participantId)).policy;
  if (!policy || !policy.models.includes(input.ref)) {
    throw new CollabStoreError('MODEL_NOT_ALLOWED', input.ref + ' n’est pas dans les modèles autorisés de ' + input.participantId
      + (policy ? ' (' + policy.models.join(', ') + ')' : ' (aucune liste AGENT_RUN_MODELS_' + suffix(input.participantId) + ')') + '.');
  }
  if (input.effort !== undefined && input.effort !== null && !isEffort(input.effort)) {
    throw new CollabStoreError('MODEL_CHOICE_INVALID', 'Niveau de réflexion invalide : ' + input.effort + ' (low, medium, high, xhigh).');
  }
  const effort = isEffort(input.effort) ? input.effort : null;
  const reason = (input.reason ?? '').slice(0, 500);
  await db.prepare([
    'INSERT INTO agent_model_prefs (cycle_id, participant_id, task_id, ref, set_by, reason, at, effort) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
    'ON CONFLICT(cycle_id, participant_id, task_id) DO UPDATE SET ref = excluded.ref, set_by = excluded.set_by, reason = excluded.reason, at = excluded.at, effort = excluded.effort',
  ].join(' ')).bind(input.cycleId, input.participantId, taskId, input.ref, input.actor, reason, input.now, effort).run();
  return { status: 'set', ref: input.ref, task_id: taskId, effort };
}

/** Journal du choix d'une étape (une ligne par étape, rejeu idempotent). */
export async function recordModelChoice(db: D1Database, runId: string, n: number, participantId: string, choice: ModelChoice, at: number): Promise<void> {
  await ensureModelPolicySchema(db);
  await db.prepare('INSERT OR IGNORE INTO agent_model_choices (run_id, n, participant_id, ref, chosen_by, reason, est_step_cents, at, effort) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
    .bind(runId, n, participantId, choice.ref, choice.chosen_by, choice.reason.slice(0, 500), choice.est_step_cents, at, choice.effort).run();
}

/** Disponibilité mesurée d'un modèle : appels réussis / en échec, dernière erreur, latence. */
export async function recordModelCall(db: D1Database, ref: string, outcome: { ok: boolean; at: number; latencyMs: number; error?: string }): Promise<void> {
  await ensureModelPolicySchema(db);
  const error = outcome.error ? outcome.error.slice(0, 200) : null;
  await db.prepare([
    'INSERT INTO agent_model_calls (ref, ok, err, last_ok_at, last_err_at, last_error, last_latency_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    'ON CONFLICT(ref) DO UPDATE SET ok = ok + excluded.ok, err = err + excluded.err,',
    '  last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at), last_err_at = COALESCE(excluded.last_err_at, last_err_at),',
    '  last_error = COALESCE(excluded.last_error, last_error), last_latency_ms = excluded.last_latency_ms',
  ].join(' ')).bind(ref, outcome.ok ? 1 : 0, outcome.ok ? 0 : 1, outcome.ok ? outcome.at : null, outcome.ok ? null : outcome.at, error, outcome.latencyMs).run();
}

/** Réessais d’écriture CAS du coupe-circuit (bloquant 3, D12 #255) — borne la boucle de conflit. */
const BREAKER_WRITE_ATTEMPTS = 4;

/**
 * CC-8 S1b-2 (v2 point 7) : cumul global (agent_model_calls, sémantique inchangée)
 * + coupe-circuit PAR PARTICIPANT × MODÈLE, écrits dans la MÊME transaction D1
 * (db.batch). L’upsert breaker porte un CAS anti-rétrogradation : un appel
 * concurrent plus frais n’est jamais écrasé (pause conservée).
 * Relecture D12 #255 (bloquant 3) : le résultat du batch est VÉRIFIÉ — si le CAS
 * conflite (0 ligne : un autre écrivain a compté plus fraîchement), on relit et
 * on réécrit (réessai borné) : la série converge vers son seuil même sous charge.
 * À l’épuisement des tentatives, au pire sous-compter d’une unité par appel
 * conflité — jamais sur-compter ni rouvrir une pause ; le registre comptable
 * reste agent_model_calls.
 */
export async function recordModelCallWithBreaker(db: D1Database, participantId: string, ref: string,
  outcome: { ok: boolean; at: number; latencyMs: number; error?: string }): Promise<void> {
  await ensureModelPolicySchema(db);
  const error = outcome.error ? outcome.error.slice(0, 200) : null;
  const cumulative = db.prepare([
    'INSERT INTO agent_model_calls (ref, ok, err, last_ok_at, last_err_at, last_error, last_latency_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    'ON CONFLICT(ref) DO UPDATE SET ok = ok + excluded.ok, err = err + excluded.err,',
    '  last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at), last_err_at = COALESCE(excluded.last_err_at, last_err_at),',
    '  last_error = COALESCE(excluded.last_error, last_error), last_latency_ms = excluded.last_latency_ms',
  ].join(' ')).bind(ref, outcome.ok ? 1 : 0, outcome.ok ? 0 : 1, outcome.ok ? outcome.at : null, outcome.ok ? null : outcome.at, error, outcome.latencyMs);
  const selectBreaker = 'SELECT consecutive_transient_failures, last_failure_at, circuit_open_until FROM agent_model_breaker WHERE participant_id = ?1 AND ref = ?2';
  // L’issue d’un appel libère le bail de sonde de ré-qualification (bloquant 2, D12 #255).
  const upsertBreaker = [
    'INSERT INTO agent_model_breaker (participant_id, ref, consecutive_transient_failures, last_failure_at, circuit_open_until, probe_until)',
    'VALUES (?1, ?2, ?3, ?4, ?5, 0)',
    'ON CONFLICT(participant_id, ref) DO UPDATE SET consecutive_transient_failures = excluded.consecutive_transient_failures,',
    '  last_failure_at = excluded.last_failure_at, circuit_open_until = excluded.circuit_open_until, probe_until = 0',
    // CAS anti-rétrogradation : n’écraser que l’état que l’on vient de lire.
    'WHERE agent_model_breaker.consecutive_transient_failures IS ?6 AND agent_model_breaker.last_failure_at IS ?7',
    '  AND agent_model_breaker.circuit_open_until IS ?8',
  ].join(' ');
  // L'upsert CAS est TOUJOURS construit depuis un état fraîchement lu : d'abord dans le
  // même batch que le cumul (atomicité), puis en réessai borné si le CAS conflite.
  const breakerStatement = (current: BreakerRow | null) => {
    const next = outcome.ok ? breakerAfterSuccess() : breakerAfterFailure(current ?? null, outcome.at);
    return db.prepare(upsertBreaker).bind(participantId, ref, next.consecutive,
      outcome.ok ? (current?.last_failure_at ?? null) : outcome.at,
      next.open_until,
      current?.consecutive_transient_failures ?? null, current?.last_failure_at ?? null, current?.circuit_open_until ?? 0);
  };
  const readBreaker = () => db.prepare(selectBreaker).bind(participantId, ref).first<BreakerRow>();
  const row = await readBreaker();
  const [, savedBreaker] = await db.batch([cumulative, breakerStatement(row)]);
  if ((savedBreaker.meta.changes ?? 0) >= 1) return;
  // Bloquant 3 (D12 #255) : le CAS a conflité (0 ligne) — relire et réécrire, réessai borné.
  for (let attempt = 1; attempt < BREAKER_WRITE_ATTEMPTS; attempt++) {
    const saved = await breakerStatement(await readBreaker()).run();
    if ((saved.meta.changes ?? 0) >= 1) return;
  }
  // Conflit persistant (≥ BREAKER_WRITE_ATTEMPTS courses simultanées) : sous-comptage borné,
  // jamais sur-comptage ni réouverture (CAS anti-rétrogradation inchangé).
}

/**
 * CC-8 S1b-2 (relecture D12 #255, bloquant 2) : bail de sonde post-pause — après
 * l’expiration d’une pause, UN SEUL essai à la fois par maillon (participant × modèle).
 * CAS atomique : seul un maillon en ré-qualification (pause trippée, expirée) sans bail
 * vivant est acquérable ; l’issue de l’appel (recordModelCallWithBreaker) libère le bail,
 * l’expiration de la fenêtre couvre un écrivain disparu.
 */
export async function acquireBreakerProbeLease(db: D1Database, participantId: string, ref: string,
  nowSec: number, leaseS: number): Promise<boolean> {
  await ensureModelPolicySchema(db);
  const saved = await db.prepare(
    'UPDATE agent_model_breaker SET probe_until = ?3 WHERE participant_id = ?1 AND ref = ?2'
    + ' AND circuit_open_until > 0 AND circuit_open_until <= ?4 AND (probe_until IS NULL OR probe_until <= ?4)')
    .bind(participantId, ref, nowSec + leaseS, nowSec).run();
  return (saved.meta.changes ?? 0) === 1;
}

/** CC-8 S1b-2 : fins de pause des maillons d’un participant (lecture seule, au plus POLICY_MAX_MODELS refs). */
export async function breakerOpenUntil(db: D1Database, participantId: string, refs: readonly string[]): Promise<Map<string, number>> {
  await ensureModelPolicySchema(db);
  const out = new Map<string, number>();
  if (!refs.length) return out;
  const placeholders = refs.map((_, index) => '?' + (index + 2)).join(', ');
  const rows = await db.prepare('SELECT ref, circuit_open_until FROM agent_model_breaker WHERE participant_id = ?1 AND ref IN (' + placeholders + ')')
    .bind(participantId, ...refs).all<{ ref: string; circuit_open_until: number }>();
  for (const row of rows.results) out.set(row.ref, row.circuit_open_until);
  return out;
}

export interface CatalogueEntry {
  participant_id: string;
  mode: 'policy' | 'single' | 'none';
  family: ModelFamily | null;
  default_ref: string | null;
  budget: BudgetState;
  models: Array<ModelOption & { family: ModelFamily | null; effort_supported: boolean; rate: { input_per_m: number; output_per_m: number; as_of: string; stale: boolean } | null;
    calls: { ok: number; err: number; last_ok_at: number | null; last_err_at: number | null; last_error: string | null; last_latency_ms: number | null } | null }>;
  rejected: Array<{ ref: string; reason: string }>;
  /** Option retenue par défaut pour chaque type de tâche (null = rien d'abordable) et, depuis L9b, son niveau de réflexion. */
  default_by_kind: Record<string, string | null>;
  default_effort_by_kind: Record<string, Effort | null>;
  preferences: Array<{ task_id: string; ref: string; set_by: string; reason: string; effort: string | null }>;
  /** CC-8 S3 : chaîne effective — source store (version, maillons, alias ep-*) ou défauts wrangler ; null = aucun modèle. */
  chain?: { source: 'store' | 'env'; version: number | null; entries: Array<{ ref: string; status: string; endpoint_id: string | null }> | null } | null;
}

const CATALOGUE_KINDS = ['answer', 'design', 'implement', 'review', 'test'] as const;

/**
 * Catalogue des modèles des agents API (AGENT_RUN_PARTICIPANTS) : famille, modèles autorisés,
 * gratuit / payant / indisponible, tarif daté (périmé > 30 jours), clé présente (oui / non,
 * jamais la valeur), disponibilité mesurée, budget restant, choix par défaut par type de tâche.
 */
export async function modelCatalog(db: D1Database, env: PolicyEnv, options: { cycleId?: string | null; now?: Date } = {}): Promise<CatalogueEntry[]> {
  await ensureModelPolicySchema(db);
  const now = options.now ?? new Date();
  const cycleId = options.cycleId ?? null;
  const out: CatalogueEntry[] = [];
  for (const pid of apiParticipants(env.AGENT_RUN_PARTICIPANTS)) {
    let policy: ParticipantPolicy | null = null;
    let policyError: string | null = null;
    let chain: CatalogueEntry['chain'] = null;
    try {
      // CC-8 S3 : résolution store d'abord puis wrangler (défauts) — la vue suit la même source que le routage.
      const resolved = await resolveParticipantPolicy(db, env, pid);
      policy = resolved.policy;
      chain = resolved.chain
        ? { source: 'store', version: resolved.chain_version,
            entries: resolved.chain.map(entry => ({ ref: entry.ref, status: entry.status, endpoint_id: chainEndpointAlias(pid, entry.ref) })) }
        : policy ? { source: 'env', version: null, entries: null } : null;
    } catch (error) { policyError = error instanceof Error ? error.message : String(error); }
    const route = participantModelRoute(env, pid);
    const refs = policy ? policy.models : route ? [route.ref] : [];
    const envelope = policy?.envelope ?? participantEnvelope(env, pid);
    const budget = await budgetState(db, envelope, pid, cycleId, now);
    const models: CatalogueEntry['models'] = [];
    for (const ref of refs) {
      const rate = apiModelRate(ref);
      const asOf = rate?.as_of ?? API_RATE_SNAPSHOT_DATE;
      const calls = await db.prepare('SELECT ok, err, last_ok_at, last_err_at, last_error, last_latency_ms FROM agent_model_calls WHERE ref = ?1').bind(ref)
        .first<NonNullable<CatalogueEntry['models'][number]['calls']>>();
      models.push({ ...modelOption(env, ref, 'review'), family: familyOf(ref), effort_supported: effortSupported(ref),
        rate: rate ? { input_per_m: rate.input_per_m, output_per_m: rate.output_per_m, as_of: asOf,
          stale: now.getTime() - Date.parse(asOf + 'T00:00:00Z') > RATE_STALE_DAYS * 86_400_000 } : null,
        calls: calls ?? null });
    }
    const defaults: Record<string, string | null> = {};
    const efforts: Record<string, Effort | null> = {};
    for (const kind of CATALOGUE_KINDS) {
      if (!policy) { defaults[kind] = route?.ref ?? null; efforts[kind] = null; continue; }
      try {
        const choice = chooseModel(env, policy, kind, budget, null);
        defaults[kind] = choice.ref;
        efforts[kind] = choice.effort;
      } catch { defaults[kind] = null; efforts[kind] = null; }
    }
    const preferences = cycleId ? (await db.prepare('SELECT task_id, ref, set_by, reason, effort FROM agent_model_prefs WHERE cycle_id = ?1 AND participant_id = ?2 ORDER BY task_id')
      .bind(cycleId, pid).all<{ task_id: string; ref: string; set_by: string; reason: string; effort: string | null }>()).results : [];
    out.push({ participant_id: pid, mode: policy ? 'policy' : route ? 'single' : 'none', family: policy?.family ?? (route ? familyOf(route.ref) : null),
      default_ref: route?.ref ?? null, budget, models,
      rejected: policy?.rejected ?? (policyError ? [{ ref: '*', reason: policyError }] : []), default_by_kind: defaults,
      default_effort_by_kind: efforts, preferences, ...(chain ? { chain } : {}) });
  }
  return out;
}


// ──────────────────────────────────────────────────────────────────────────────
// CC-8 S3 (CC-PLAN-8 §1.6, unanimité, validé par Kevin) — chaînes de modèles
// dans le store. La chaîne d'un agent vit dans le store (acte owner
// set_agent_models, owner/model-chains.ts) : elle remplace sa liste de
// modèles SANS PR ; les variables wrangler restent les DÉFAUTS, jamais
// réécrites, et la fiche canonique reste la source des DÉFINITIONS (F1) :
// chaque maillon doit y exister pour l'agent (modèle ou cible d'alias ep-*),
// dans sa famille — fail-on-diff, jamais une seconde définition.
// ─────────────────────────────────────────────────────────────────────────────

/** Statuts d'un maillon (CC-PLAN-8 §1.6) ; l'ORDRE du tableau de la chaîne porte l'ordre de routage. */
export const CHAIN_STATUSES = ['inactive', 'candidate', 'beta', 'primary', 'rollback'] as const;
export type ChainStatus = (typeof CHAIN_STATUSES)[number];
/**
 * Maillons routés : primary (courant), beta (essai) et rollback (secours de
 * dernier recours, cible désignée d'un retour arrière), dans l'ordre du
 * tableau. candidate (observé, pas encore routé) et inactive (jamais routé,
 * ex. payant sans budget) restent visibles dans les vues, jamais routés.
 */
export const ROUTED_CHAIN_STATUSES: readonly ChainStatus[] = ['primary', 'beta', 'rollback'];
const CHAIN_REF_RE = /^[a-z][a-z-]{1,15}:\S{1,200}$/;

export interface ChainEntry { readonly ref: string; readonly status: ChainStatus }

/** Chaîne courante : active = chaîne posée ; inactive = version RETIRÉE (sentinelle 'null', compteur monotone, défauts wrangler). */
export interface StoredChain { participant_id: string; version: number; active: boolean; chain: ChainEntry[]; updated_at: number }

/**
 * Tables internes au store (jamais dans le schéma canonique gelé), portables
 * (CREATE IF NOT EXISTS, aucune option moteur). agent_model_chains porte la
 * chaîne COURANTE par agent (CAS sur version) ; agent_model_chain_versions
 * est l'historique APPEND-ONLY des versions posées — instantanés immuables,
 * une ligne par acte set / rollback, jamais réécrite ni supprimée.
 */
export const MODEL_CHAIN_SCHEMA = [
  [
    'CREATE TABLE IF NOT EXISTS agent_model_chains (',
    '  participant_id TEXT PRIMARY KEY,',
    '  version INTEGER NOT NULL,',
    '  chain_json TEXT NOT NULL,',
    '  updated_at INTEGER NOT NULL,',
    '  event_seq INTEGER',
    ')',
  ].join(' '),
  [
    'CREATE TABLE IF NOT EXISTS agent_model_chain_versions (',
    '  participant_id TEXT NOT NULL,',
    '  version INTEGER NOT NULL,',
    '  chain_json TEXT NOT NULL,',
    '  set_by TEXT NOT NULL,',
    "  action TEXT NOT NULL CHECK (action IN ('set', 'rollback')),",
    "  reason TEXT NOT NULL DEFAULT '',",
    '  event_seq INTEGER,',
    '  at INTEGER NOT NULL,',
    '  PRIMARY KEY (participant_id, version)',
    ')',
  ].join(' '),
] as const;

const chainSchemaEnsured = new WeakSet<object>();

export async function ensureModelChainSchema(db: D1Database): Promise<void> {
  if (chainSchemaEnsured.has(db as unknown as object)) return;
  await db.batch(MODEL_CHAIN_SCHEMA.map(statement => db.prepare(statement)));
  chainSchemaEnsured.add(db as unknown as object);
}

/** Fiche canonique parsée une fois par isolate (F1 : source unique des définitions). */
let cachedFiche: Fiche | null = null;

function canonicalFiche(): Fiche {
  cachedFiche ??= parseFiche(FICHE_RAW);
  return cachedFiche;
}

/** Alias ep-* de l'agent pointant cette référence (vue catalogue), ou null. */
export function chainEndpointAlias(participantId: string, ref: string): string | null {
  const agent = canonicalFiche().agents.find(item => item.participant_id === participantId);
  return agent?.endpoints.find(endpoint => endpoint.ref === ref)?.endpoint_id ?? null;
}

/**
 * F1 — fail-on-diff : une chaîne ne référence QUE des définitions de la fiche
 * de l'agent (modèles ou cibles de ses alias ep-*), toutes dans SA famille, et
 * porte au moins un maillon primary ; toute divergence est refusée — la fiche
 * et wrangler ne sont jamais réécrites.
 */
export function validateModelChain(participantId: string, input: unknown): { family: ModelFamily; entries: ChainEntry[] } {
  if (!Array.isArray(input) || input.length === 0) {
    throw new CollabStoreError('CHAIN_INVALID', 'Chaîne vide : 1 à ' + POLICY_MAX_MODELS + ' maillon(s) {ref, status} requis.');
  }
  if (input.length > POLICY_MAX_MODELS) {
    throw new CollabStoreError('CHAIN_INVALID', 'Au plus ' + POLICY_MAX_MODELS + ' maillons par agent.');
  }
  const agent = canonicalFiche().agents.find(item => item.participant_id === participantId);
  if (!agent) {
    throw new CollabStoreError('CHAIN_FICHE_UNKNOWN', participantId + ' est absent de la fiche canonique (F1) : aucune définition à référencer.');
  }
  if (!(MODEL_FAMILIES as readonly string[]).includes(agent.family)) {
    throw new CollabStoreError('CHAIN_FICHE_DIFF', 'Famille de fiche inconnue pour ' + participantId + ' : ' + agent.family + '.');
  }
  const universe = new Set<string>([...agent.models.map(model => model.ref), ...agent.endpoints.map(endpoint => endpoint.ref)]);
  const entries: ChainEntry[] = [];
  const seen = new Set<string>();
  let primary = 0;
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new CollabStoreError('CHAIN_INVALID', 'Maillon de chaîne invalide : {ref, status} requis.');
    }
    const { ref, status } = item as Record<string, unknown>;
    if (typeof ref !== 'string' || !CHAIN_REF_RE.test(ref)) {
      throw new CollabStoreError('CHAIN_INVALID', 'Référence de maillon invalide : ' + String(ref) + '.');
    }
    if (typeof status !== 'string' || !(CHAIN_STATUSES as readonly string[]).includes(status)) {
      throw new CollabStoreError('CHAIN_STATUS_UNKNOWN', 'Statut de maillon inconnu : ' + String(status) + ' (' + CHAIN_STATUSES.join(', ') + ').');
    }
    if (seen.has(ref)) throw new CollabStoreError('CHAIN_INVALID', 'Maillon en double : ' + ref + '.');
    if (!universe.has(ref)) {
      throw new CollabStoreError('CHAIN_FICHE_DIFF', ref + ' n’est pas défini par la fiche de ' + participantId + ' (F1 : la chaîne référence des définitions, elle n’en crée jamais).');
    }
    const family = familyOf(ref);
    if (family !== agent.family) {
      throw new CollabStoreError('CHAIN_FAMILY_DIFF', ref + ' est de famille ' + (family ?? 'inconnue') + ' ≠ ' + agent.family + ' (famille de ' + participantId + ').');
    }
    seen.add(ref);
    if (status === 'primary') primary += 1;
    entries.push({ ref, status: status as ChainStatus });
  }
  if (primary === 0) {
    throw new CollabStoreError('CHAIN_NO_PRIMARY', 'Aucun maillon primary : la chaîne de ' + participantId + ' ne pourrait rien router.');
  }
  return { family: agent.family as ModelFamily, entries };
}

/**
 * Chaîne courante d'un agent, ou null si aucune ligne. Une ligne RETIRÉE
 * (sentinelle 'null', posée par un rollback vers la version 0) est rendue
 * avec active = false : le compteur de version reste MONOTONE (CAS), le
 * routage retombe sur les défauts wrangler.
 */
export async function loadModelChain(db: D1Database, participantId: string): Promise<StoredChain | null> {
  await ensureModelChainSchema(db);
  const row = await db.prepare('SELECT participant_id, version, chain_json, updated_at FROM agent_model_chains WHERE participant_id = ?1')
    .bind(participantId).first<{ participant_id: string; version: number; chain_json: string; updated_at: number }>();
  if (!row) return null;
  return {
    participant_id: row.participant_id, version: row.version, active: !chainIsRetired(row.chain_json),
    chain: parseChainEntries(row.chain_json), updated_at: row.updated_at,
  };
}

/** Instantané immuable d'une version posée (null : introuvable ; chain null : version RETIRÉE, défauts wrangler). */
export interface ChainSnapshot { version: number; chain: ChainEntry[] | null }

export async function loadChainSnapshot(db: D1Database, participantId: string, version: number): Promise<ChainSnapshot | null> {
  await ensureModelChainSchema(db);
  const row = await db.prepare('SELECT chain_json FROM agent_model_chain_versions WHERE participant_id = ?1 AND version = ?2')
    .bind(participantId, version).first<{ chain_json: string }>();
  if (!row) return null;
  return { version, chain: chainIsRetired(row.chain_json) ? null : parseChainEntries(row.chain_json) };
}

/** Sentinelle de retrait : 'null' = chaîne retirée (défauts wrangler) — la ligne et le compteur de version restent. */
function chainIsRetired(raw: string): boolean {
  return raw === 'null';
}

/** Maillons lisibles d'un JSON stocké (fail-fermé : illisible = aucun maillon). */
function parseChainEntries(raw: string): ChainEntry[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ChainEntry[] = [];
    for (const item of parsed) {
      if (item && typeof item === 'object' && typeof (item as ChainEntry).ref === 'string'
        && typeof (item as ChainEntry).status === 'string' && (CHAIN_STATUSES as readonly string[]).includes((item as ChainEntry).status)) {
        out.push({ ref: (item as ChainEntry).ref, status: (item as ChainEntry).status });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface ResolvedPolicy {
  policy: ParticipantPolicy | null;
  /** store : chaîne du store (S3) ; env : listes wrangler (défauts, comportement inchangé). */
  source: 'store' | 'env';
  chain_version: number | null;
  chain: ChainEntry[] | null;
}

/**
 * CC-8 S3 — résolution STORE D'ABORD puis wrangler (CC-PLAN-8 §1.6) : la
 * chaîne posée dans le store remplace la liste de modèles de l'agent (mêmes
 * règles de choix, même enveloppe, maillons non routés signalés) ; sans
 * chaîne, la politique des variables d'environnement est rendue TELLE QUELLE
 * — routage identique à l'existant. Les enveloppes et budgets restent
 * wrangler : la chaîne ne finance rien.
 */
export async function resolveParticipantPolicy(db: D1Database, env: PolicyEnv, participantId: string): Promise<ResolvedPolicy> {
  const stored = await loadModelChain(db, participantId);
  // Ligne absente OU chaîne retirée (sentinelle 'null') : défauts wrangler TELLE QU'ELLE (AC4) — le compteur de version reste monotone pour le CAS.
  if (!stored || !stored.active) return { policy: participantPolicy(env, participantId), source: 'env', chain_version: null, chain: null };
  const models: string[] = [];
  const rejected: ParticipantPolicy['rejected'] = [];
  for (const entry of stored.chain) {
    if ((ROUTED_CHAIN_STATUSES as readonly string[]).includes(entry.status)) models.push(entry.ref);
    else rejected.push({ ref: entry.ref, reason: 'statut ' + entry.status + ' non routé' });
  }
  const agent = canonicalFiche().agents.find(item => item.participant_id === participantId);
  const family = (agent && (MODEL_FAMILIES as readonly string[]).includes(agent.family)
    ? agent.family : familyOf(models[0] ?? stored.chain[0]?.ref ?? '')) as ModelFamily;
  return {
    policy: { participant_id: participantId, family, models, rejected, envelope: participantEnvelope(env, participantId) },
    source: 'store', chain_version: stored.version, chain: stored.chain,
  };
}
