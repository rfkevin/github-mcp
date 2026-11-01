/**
 * CC-7 F2 (P3 #1138 §2, rôles #1139, GO Kevin promotion auto sous conditions) —
 * décision pure : candidate épinglée + sonde + tarifs → reject | propose | auto_apply.
 *
 * Aucune écriture réseau, fiche ni env ici. La bascule durable de la fiche reste une PR
 * (F1) ; auto_apply signale seulement que la politique autorise une promotion immédiate
 * du modèle de travail (ex. override session / journal), jamais un rewrite silencieux
 * de config/agents.fiche.json.
 */

export type PromoteVerdict = 'reject' | 'propose' | 'auto_apply';

/** Tarif unitaire (cents US / million de jetons). */
export interface PromoteRate {
  readonly input_per_m: number;
  readonly output_per_m: number;
  /** Coût raisonnement / cache / outils par million, 0 si inconnu et non facturé. */
  readonly other_per_m?: number;
}

export interface ProbeResult {
  /** HTTP / API OK et corps utilisable. */
  readonly ok: boolean;
  /** Tool calling / JSON structuré vérifié si exigé. */
  readonly tools_ok: boolean;
  /** Niveaux d'effort réellement acceptés (ex. low|medium|high). */
  readonly efforts_ok: readonly string[];
  /** Coût mesuré de la sonde en micro-cents (optionnel). */
  readonly cost_micro_cents?: number;
  /** Message d'échec court. */
  readonly error?: string;
}

/** Types de tâche exigés par le canary F2 (P3 C2). */
export const CANARY_TASK_KINDS = ['answer', 'review', 'test', 'implement'] as const;
export type CanaryTaskKind = typeof CANARY_TASK_KINDS[number];

/** Minimum d'appels canary avant auto_apply (P3 C2). */
export const CANARY_MIN_CALLS = 20;

export interface CanaryResult {
  readonly calls: number;
  readonly failures: number;
  /** Coût moyen panier vs baseline (ratio, 1.0 = égal). */
  readonly cost_ratio: number;
  readonly identity_leak: boolean;
  readonly critical_error: boolean;
  /**
   * Répartition par type. auto_apply : chaque CANARY_TASK_KINDS avec calls >= 1
   * et somme des calls_by_kind === calls.
   */
  readonly calls_by_kind: Readonly<Partial<Record<CanaryTaskKind, number>>>;
}

export interface PromoteInput {
  /** Référence actuelle épinglée provider:model. */
  readonly current_ref: string;
  /** Candidate épinglée (jamais un alias latest flottant). */
  readonly candidate_ref: string;
  /** Même famille fournisseur (ex. gemini, xai). */
  readonly same_family: boolean;
  readonly current_rate: PromoteRate | null;
  readonly candidate_rate: PromoteRate | null;
  /** true si la candidate est encore gratuite au palier attendu. */
  readonly candidate_still_free: boolean;
  /** true si le modèle actuel est gratuit. */
  readonly current_is_free: boolean;
  readonly probe: ProbeResult;
  readonly canary: CanaryResult | null;
  /** Kevin a autorisé la politique auto (AGENT_RUN_PROMOTE_AUTO=true). */
  readonly auto_policy_enabled: boolean;
  /** Plafond owner présent pour tout appel non gratuit. */
  readonly paid_ceiling_ok: boolean;
}

export interface PromoteDecision {
  readonly verdict: PromoteVerdict;
  readonly reasons: readonly string[];
}

const REF_RE = /^[a-z][a-z-]{1,15}:\S{1,200}$/;
/** Niveaux d'effort reconnus (sonde). */
export const EFFORT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

/** Ref épinglée : forme provider:model et pas d'alias flottant (*latest*). */
export function isPinnedRef(ref: string): boolean {
  if (!REF_RE.test(ref)) return false;
  const model = ref.slice(ref.indexOf(':') + 1).toLowerCase();
  if (!model || model === 'latest') return false;
  if (model.endsWith('-latest') || model.endsWith('/latest') || model.includes(':latest')) return false;
  if (/(^|[\/_-])latest([\/_-]|$)/.test(model)) return false;
  return true;
}

function finiteNonNeg(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** Tarif utilisable pour comparaison (nombres finis ≥ 0). */
export function rateValid(rate: PromoteRate): boolean {
  if (!finiteNonNeg(rate.input_per_m) || !finiteNonNeg(rate.output_per_m)) return false;
  if (rate.other_per_m !== undefined && !finiteNonNeg(rate.other_per_m)) return false;
  return true;
}

/** Compteurs canary cohérents avant ratio. */
export function canaryStatsValid(canary: CanaryResult): boolean {
  if (!Number.isSafeInteger(canary.calls) || canary.calls < 0) return false;
  if (!Number.isSafeInteger(canary.failures) || canary.failures < 0 || canary.failures > canary.calls) return false;
  if (!Number.isFinite(canary.cost_ratio) || canary.cost_ratio < 0) return false;
  return true;
}

/** efforts_ok : non vide et chaque entrée dans EFFORT_LEVELS. */
export function effortsValid(efforts: readonly string[]): boolean {
  if (!efforts.length) return false;
  return efforts.every((e) => EFFORT_LEVELS.has(e));
}

/** Prix non supérieur : entrée ≤ et sortie ≤ et other ≤ (si fourni des deux côtés). */
export function priceNotHigher(current: PromoteRate, candidate: PromoteRate): boolean {
  if (!rateValid(current) || !rateValid(candidate)) return false;
  if (candidate.input_per_m > current.input_per_m) return false;
  if (candidate.output_per_m > current.output_per_m) return false;
  const cOther = current.other_per_m ?? 0;
  const nOther = candidate.other_per_m ?? 0;
  if (nOther > cOther) return false;
  return true;
}

/** Gratuit devenu payant : interdit en auto ; propose gel/repli seulement. */
export function freeBecamePaid(input: PromoteInput): boolean {
  return input.current_is_free && !input.candidate_still_free;
}

/**
 * Décision de promotion. Ordre fail-closed.
 * Canary absent => jamais auto_apply (seulement propose si le reste passe).
 */
export function decidePromotion(input: PromoteInput): PromoteDecision {
  const reasons: string[] = [];
  if (!isPinnedRef(input.current_ref) || !isPinnedRef(input.candidate_ref)) {
    return { verdict: 'reject', reasons: ['ref_non_epinglee'] };
  }
  if (input.current_ref === input.candidate_ref) {
    return { verdict: 'reject', reasons: ['meme_modele'] };
  }
  if (!input.same_family) {
    return { verdict: 'reject', reasons: ['famille_differente'] };
  }
  if (!input.candidate_rate || !rateValid(input.candidate_rate)) {
    return { verdict: 'reject', reasons: ['tarif_candidat_invalide'] };
  }
  if (!input.current_rate || !rateValid(input.current_rate)) {
    return { verdict: 'reject', reasons: ['tarif_actuel_invalide'] };
  }
  if (freeBecamePaid(input)) {
    return { verdict: 'propose', reasons: ['gratuit_devenu_payant_gel_ou_repli'] };
  }
  if (!priceNotHigher(input.current_rate, input.candidate_rate)) {
    return { verdict: 'propose', reasons: ['prix_superieur'] };
  }
  if (!input.probe.ok) {
    return { verdict: 'reject', reasons: ['sonde_echec', input.probe.error ?? ''] };
  }
  if (!input.probe.tools_ok) {
    return { verdict: 'reject', reasons: ['sonde_outils'] };
  }
  if (!effortsValid(input.probe.efforts_ok)) {
    return { verdict: 'reject', reasons: ['sonde_efforts_invalides'] };
  }
  if (!input.candidate_still_free && !input.paid_ceiling_ok) {
    return { verdict: 'reject', reasons: ['plafond_payant_absent'] };
  }

  const canary = input.canary;
  if (!canary) {
    reasons.push('canary_absent');
    return { verdict: 'propose', reasons: [...reasons, 'sonde_ok_prix_ok'] };
  }
  if (!canaryStatsValid(canary)) {
    return { verdict: 'reject', reasons: ['canary_stats_invalides'] };
  }
  if (canary.critical_error || canary.identity_leak) {
    return { verdict: 'reject', reasons: ['canary_critique'] };
  }
  if (canary.calls < 1) {
    return { verdict: 'reject', reasons: ['canary_vide'] };
  }
  const failRate = canary.failures / canary.calls;
  if (failRate > 0.05) {
    return { verdict: 'reject', reasons: ['canary_taux_echec'] };
  }
  if (canary.cost_ratio > 1.0) {
    return { verdict: 'propose', reasons: ['canary_cout_superieur'] };
  }

  // auto_apply exige canary P3 C2 complet ; sinon propose même si le reste est vert.
  if (!canaryReadyForAuto(canary)) {
    return { verdict: 'propose', reasons: ['canary_incomplet', 'sonde_ok', 'prix_ok'] };
  }

  if (input.auto_policy_enabled) {
    return { verdict: 'auto_apply', reasons: ['politique_auto', 'sonde_ok', 'canary_ok', 'prix_ok'] };
  }
  return { verdict: 'propose', reasons: ['auto_desactivee', 'sonde_ok', 'canary_ok', 'prix_ok'] };
}

/** Canary complet pour auto_apply : >= 20, 4 types, somme cohérente. */
export function canaryReadyForAuto(canary: CanaryResult): boolean {
  if (canary.calls < CANARY_MIN_CALLS) return false;
  let sum = 0;
  for (const kind of CANARY_TASK_KINDS) {
    const n = canary.calls_by_kind[kind];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return false;
    sum += n;
  }
  return sum === canary.calls;
}

/** Env : promotion auto uniquement si chaîne exacte « true ». */
export function promoteAutoEnabled(env: { AGENT_RUN_PROMOTE_AUTO?: string }): boolean {
  return env.AGENT_RUN_PROMOTE_AUTO === 'true';
}
