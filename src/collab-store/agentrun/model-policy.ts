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
import { freeAllowed, isFreeApiModel, participantModelRoute, participantModelVar, type ApiProvider, type ProviderEnv } from './provider-models';

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

function credentialPresent(env: PolicyEnv, ref: string): boolean {
  const name = credentialOf(ref);
  if (!name) return false;
  const value = (env as Record<string, unknown>)[name];
  return name === 'AI' ? value !== undefined && value !== null : typeof value === 'string' && value.trim() !== '';
}

/** Gratuit, payant ou indisponible pour CET environnement, et coût estimé d'une étape pour ce type de tâche. */
export function modelOption(env: PolicyEnv, ref: string, kind: string): ModelOption {
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
  const est = centsOfApiTokens(rate, ESTIMATE_INPUT_TOKENS, resolveEffectiveMaxTokens({ task_kind: kind }));
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

export interface ModelChoice { ref: string; chosen_by: string; reason: string; est_step_cents: number; tier: 'free' | 'paid' }

/** Choix d'une étape : préférence abordable, sinon descente dans la liste, sinon règle par défaut ; rien d'abordable = refus. */
export function chooseModel(env: PolicyEnv, policy: ParticipantPolicy, kind: string, budget: BudgetState,
  preference: { ref: string; set_by: string } | null): ModelChoice {
  const options = policy.models.map(ref => modelOption(env, ref, kind));
  const pick = (option: ModelOption, chosenBy: string, reason: string): ModelChoice =>
    ({ ref: option.ref, chosen_by: chosenBy, reason, est_step_cents: option.est_step_cents ?? 0, tier: option.tier === 'free' ? 'free' : 'paid' });
  if (preference) {
    const index = options.findIndex(option => option.ref === preference.ref);
    if (index >= 0) {
      if (affordable(options[index], budget)) return pick(options[index], preference.set_by, 'préférence');
      const lower = options.slice(index + 1).find(option => affordable(option, budget));
      if (lower) return pick(lower, 'serveur', 'préférence ' + preference.ref + ' non abordable (' + (options[index].reason ?? 'budget') + ') : option suivante');
    }
  }
  const usable = options.filter(option => affordable(option, budget));
  if (!usable.length) {
    throw new CollabStoreError('MODEL_BUDGET_EXHAUSTED', 'Aucun modèle abordable pour ' + policy.participant_id + ' (' + kind + ') : '
      + options.map(option => option.ref + '=' + (option.tier === 'unavailable' ? option.reason : option.est_step_cents + 'c')).join(', ')
      + ' ; budget restant jour ' + (budget.day_limit - budget.day_spent) + 'c, cycle ' + (budget.cycle_limit - budget.cycle_spent) + 'c.');
  }
  if (STRONG_KINDS.includes(kind)) return pick(usable[0], 'serveur', 'défaut : le plus fort abordable (' + kind + ')');
  const cheapest = usable.reduce((best, option) => (option.est_step_cents ?? 0) < (best.est_step_cents ?? 0) ? option : best, usable[0]);
  return pick(cheapest, 'serveur', 'défaut : le moins cher (' + kind + ')');
}

export const MODEL_POLICY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agent_model_prefs (cycle_id TEXT NOT NULL, participant_id TEXT NOT NULL, task_id TEXT NOT NULL,
    ref TEXT NOT NULL, set_by TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (cycle_id, participant_id, task_id))`,
  `CREATE TABLE IF NOT EXISTS agent_model_choices (run_id TEXT NOT NULL, n INTEGER NOT NULL, participant_id TEXT NOT NULL,
    ref TEXT NOT NULL, chosen_by TEXT NOT NULL, reason TEXT NOT NULL, est_step_cents INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (run_id, n))`,
  `CREATE TABLE IF NOT EXISTS agent_model_calls (ref TEXT PRIMARY KEY, ok INTEGER NOT NULL DEFAULT 0, err INTEGER NOT NULL DEFAULT 0,
    last_ok_at INTEGER, last_err_at INTEGER, last_error TEXT, last_latency_ms INTEGER)`,
] as const;

export async function ensureModelPolicySchema(db: D1Database): Promise<void> {
  await db.batch(MODEL_POLICY_SCHEMA.map(statement => db.prepare(statement)));
}

/** Préférence de la tâche, sinon de l'agent pour tout le cycle (task_id ''). */
export async function modelPreference(db: D1Database, cycleId: string, participantId: string, taskId: string): Promise<{ ref: string; set_by: string } | null> {
  await ensureModelPolicySchema(db);
  return db.prepare([
    'SELECT ref, set_by FROM agent_model_prefs WHERE cycle_id = ?1 AND participant_id = ?2 AND task_id IN (?3, \'\')',
    'ORDER BY CASE WHEN task_id = ?3 THEN 0 ELSE 1 END LIMIT 1',
  ].join(' ')).bind(cycleId, participantId, taskId).first<{ ref: string; set_by: string }>();
}

/**
 * Pose (ou retire, ref null) la préférence de modèle d'un agent : l'agent pour lui-même, ou un
 * coordinateur actif pour n'importe quel agent. Le modèle doit être dans la liste de l'agent.
 */
export async function setModelPreference(db: D1Database, env: PolicyEnv, input: {
  actor: string; actorIsCoordinator: boolean; cycleId: string; participantId: string; taskId?: string; ref: string | null; reason?: string; now: number;
}): Promise<{ status: 'set' | 'cleared'; ref: string | null; task_id: string }> {
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
  const policy = participantPolicy(env, input.participantId);
  if (!policy || !policy.models.includes(input.ref)) {
    throw new CollabStoreError('MODEL_NOT_ALLOWED', input.ref + ' n’est pas dans les modèles autorisés de ' + input.participantId
      + (policy ? ' (' + policy.models.join(', ') + ')' : ' (aucune liste AGENT_RUN_MODELS_' + suffix(input.participantId) + ')') + '.');
  }
  const reason = (input.reason ?? '').slice(0, 500);
  await db.prepare([
    'INSERT INTO agent_model_prefs (cycle_id, participant_id, task_id, ref, set_by, reason, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    'ON CONFLICT(cycle_id, participant_id, task_id) DO UPDATE SET ref = excluded.ref, set_by = excluded.set_by, reason = excluded.reason, at = excluded.at',
  ].join(' ')).bind(input.cycleId, input.participantId, taskId, input.ref, input.actor, reason, input.now).run();
  return { status: 'set', ref: input.ref, task_id: taskId };
}

/** Journal du choix d'une étape (une ligne par étape, rejeu idempotent). */
export async function recordModelChoice(db: D1Database, runId: string, n: number, participantId: string, choice: ModelChoice, at: number): Promise<void> {
  await ensureModelPolicySchema(db);
  await db.prepare('INSERT OR IGNORE INTO agent_model_choices (run_id, n, participant_id, ref, chosen_by, reason, est_step_cents, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(runId, n, participantId, choice.ref, choice.chosen_by, choice.reason.slice(0, 500), choice.est_step_cents, at).run();
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

export interface CatalogueEntry {
  participant_id: string;
  mode: 'policy' | 'single' | 'none';
  family: ModelFamily | null;
  default_ref: string | null;
  budget: BudgetState;
  models: Array<ModelOption & { family: ModelFamily | null; rate: { input_per_m: number; output_per_m: number; as_of: string; stale: boolean } | null;
    calls: { ok: number; err: number; last_ok_at: number | null; last_err_at: number | null; last_error: string | null; last_latency_ms: number | null } | null }>;
  rejected: Array<{ ref: string; reason: string }>;
  /** Option retenue par défaut pour chaque type de tâche (null = rien d'abordable). */
  default_by_kind: Record<string, string | null>;
  preferences: Array<{ task_id: string; ref: string; set_by: string; reason: string }>;
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
    try { policy = participantPolicy(env, pid); } catch (error) { policyError = error instanceof Error ? error.message : String(error); }
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
      models.push({ ...modelOption(env, ref, 'review'), family: familyOf(ref),
        rate: rate ? { input_per_m: rate.input_per_m, output_per_m: rate.output_per_m, as_of: asOf,
          stale: now.getTime() - Date.parse(asOf + 'T00:00:00Z') > RATE_STALE_DAYS * 86_400_000 } : null,
        calls: calls ?? null });
    }
    const defaults: Record<string, string | null> = {};
    for (const kind of CATALOGUE_KINDS) {
      if (!policy) { defaults[kind] = route?.ref ?? null; continue; }
      try { defaults[kind] = chooseModel(env, policy, kind, budget, null).ref; } catch { defaults[kind] = null; }
    }
    const preferences = cycleId ? (await db.prepare('SELECT task_id, ref, set_by, reason FROM agent_model_prefs WHERE cycle_id = ?1 AND participant_id = ?2 ORDER BY task_id')
      .bind(cycleId, pid).all<{ task_id: string; ref: string; set_by: string; reason: string }>()).results : [];
    out.push({ participant_id: pid, mode: policy ? 'policy' : route ? 'single' : 'none', family: policy?.family ?? (route ? familyOf(route.ref) : null),
      default_ref: route?.ref ?? null, budget, models,
      rejected: policy?.rejected ?? (policyError ? [{ ref: '*', reason: policyError }] : []), default_by_kind: defaults, preferences });
  }
  return out;
}
