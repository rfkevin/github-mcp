/**
 * CC-8 S1b-2 — politique unique de temps et d'échec des exécutions API
 * (plan de conception S1b-2 v2, store seq 1376 ; AGREE Grok 1377, Claude 1378,
 * Vibe 1379, GPT-6 1380 ; dérogation owner Gemini seq 1381).
 *
 * Tout se décide ICI : délai d'appel fournisseur (par fournisseur et par type
 * de tâche), budget de temps des appels modèle d'une étape, deadline d'exécution
 * (par type de tâche), bornes d'étape, règles du coupe-circuit (option B :
 * participant × modèle). Consommateurs : engine (budget d'étape), plan
 * (deadline), provider-models/model-policy (coupe-circuit), orchestrator
 * (réservation GB-s), puis S4/S5/S8. Aucune politique de délai ailleurs :
 * fetch-timeout.ts ne fait que ré-exporter (façade de compatibilité).
 *
 * AUCUNE valeur active ne dépasse 120 s par appel ni 900 s de run à la fusion :
 * la montée des kinds lourds (180 s) et des deadlines longues (30/45 min) est
 * différée à S7, après P95 mesurée sur le journal des durées (S1b-2 §5) — la
 * structure (kind → plafond, kind → deadline) est déjà câblée et testée.
 *
 * Le message du helper HTTP reste « Fournisseur sans réponse après N ms. » : sa
 * classification transient (S1b #254 fusionnée) ne doit jamais être cassée.
 */

/** Défaut et plafond PAR FOURNISSEUR (absorbé de fetch-timeout, CC-5 L0). Fournisseur inconnu : 30 s (historique). */
export const PROVIDER_TIMEOUT_MS: Readonly<Record<string, { default_ms: number; max_ms: number }>> = {
  groq: { default_ms: 30_000, max_ms: 60_000 },
  // S1b-2 : gemini 60 s → 120 s — le live 3.8 a dépassé 60 s (ok 1 / err 5, latence pile 60000 ms).
  gemini: { default_ms: 120_000, max_ms: 120_000 },
  zai: { default_ms: 90_000, max_ms: 120_000 },
  openrouter: { default_ms: 120_000, max_ms: 120_000 },
  deepseek: { default_ms: 120_000, max_ms: 120_000 },
  xai: { default_ms: 120_000, max_ms: 120_000 },
  anthropic: { default_ms: 120_000, max_ms: 120_000 },
  'workers-ai': { default_ms: 120_000, max_ms: 120_000 },
};

/** Signature historique conservée (chemin gratuit, tests). */
export function clampTimeoutMs(value: number | undefined, maxMs = 30_000): number {
  return Math.min(Math.max(Math.trunc(value ?? maxMs), 1), maxMs);
}

/**
 * Plafond d'appel PAR TYPE DE TÂCHE : uniforme 120 s à la fusion S1b-2 (v2 point 2).
 * S7 : les kinds lourds passent à HEAVY_TIMEOUT_MS après P95 mesurée — changement
 * de constantes uniquement, le mécanisme kind → plafond est câblé et testé ici.
 */
export const TASK_KIND_TIMEOUT_MS = 120_000;
/** Kinds à génération longue : 180 s en S7, INACTIF à la fusion. */
export const HEAVY_TASK_KINDS: readonly string[] = Object.freeze(['implement', 'code', 'planification', 'planning', 'research', 'design']);
export const HEAVY_TIMEOUT_MS = 180_000;

/**
 * Délai effectif d'un appel fournisseur : min(défaut ou valeur explicite clampée
 * au plafond fournisseur, plafond du type de tâche, budget d'étape restant).
 * taskKind et budgetLeftMs sont optionnels : chemin gratuit et tests inchangés.
 */
export function providerTimeoutMs(provider: string, value?: number, taskKind?: string, budgetLeftMs?: number): number {
  const policy = PROVIDER_TIMEOUT_MS[provider] ?? { default_ms: 30_000, max_ms: 30_000 };
  let ms = Math.min(Math.max(Math.trunc(value ?? policy.default_ms), 1), policy.max_ms);
  ms = Math.min(ms, TASK_KIND_TIMEOUT_MS);
  if (typeof budgetLeftMs === 'number' && Number.isFinite(budgetLeftMs)) ms = Math.min(ms, Math.max(1, Math.trunc(budgetLeftMs)));
  return Math.min(Math.max(ms, 1), policy.max_ms);
}

/**
 * Deadline d'exécution PAR TYPE DE TÂCHE (v2 point 5) : 900 s partout à la fusion
 * (le compromis seq 1372/1374) ; S7 : review/test 30 min, implement/design 45 min,
 * après P95 et preuve des alarmes Durable Objects.
 */
export const TASK_KIND_DEADLINE_S: Readonly<Record<string, number>> = Object.freeze({
  answer: 900, design: 900, implement: 900, review: 900, test: 900, default: 900,
});
export function runDeadlineS(kind: string | null | undefined): number {
  return TASK_KIND_DEADLINE_S[kind ?? 'default'] ?? TASK_KIND_DEADLINE_S.default;
}

/** Bornes d'une étape (source unique ; engine ré-exporte les seconds). */
export const STEP_TIMEOUT_MS = 600_000;
export const EFFECT_TIMEOUT_MS = 120_000;

/**
 * Budget TOTAL des appels modèle d'une étape (chaîne de repli incluse), DISTINCT
 * des effets d'outils (v2 point 4) : chaque appel reçoit min(son délai, budget
 * restant) ; les effets gardent EFFECT_TIMEOUT_MS chacun, sous garde du temps
 * restant avant chaque effet (engine).
 */
export const STEP_MODEL_BUDGET_MS = 480_000;
/** Marge minimale pour tenter un appel ou un effet ; en dessous : arrêt propre, classé transient. */
export const STEP_MODEL_BUDGET_FLOOR_MS = 30_000;

/**
 * Budget des appels modèle d'une étape : min(480 s, deadline d'exécution restante
 * − 30 s, marge avant le plafond d'étape : 600 s − un effet entier 120 s). Les
 * trois bornes valent 480 s à la fusion — l'invariant étape < 600 s reste
 * explicite même si une borne change en S7.
 */
export function stepModelBudgetMs(deadlineAt: number, now: number, stepTimeoutMs: number = STEP_TIMEOUT_MS): number {
  const deadlineLeftMs = deadlineAt - now - STEP_MODEL_BUDGET_FLOOR_MS;
  const stepCapMs = stepTimeoutMs - EFFECT_TIMEOUT_MS;
  return Math.max(1, Math.trunc(Math.min(STEP_MODEL_BUDGET_MS, deadlineLeftMs, stepCapMs)));
}

// ---------------------------------------------------------------- coupe-circuit (option B)

/**
 * Coupe-circuit PAR PARTICIPANT × MODÈLE (v2 point 7, option B unanime) : jamais
 * global — un agent bruyant ne coupe pas le modèle des autres. Après 3 échecs
 * transitoires consécutifs dans la fenêtre de 30 min, le maillon est écarté
 * pendant 30 min ; à l'expiration il est réessayé UNE fois ; un nouvel échec
 * rouvre la pause (au plus un essai par pause), un succès remet la série à zéro.
 * Les échecs de budget local ne comptent PAS (comptés en amont par
 * provider-models) ; les sondes S4/S5 sont exemptées (task_kind probe). Ne
 * modifie JAMAIS la chaîne du store : S6 seul change durablement une chaîne.
 */
export const BREAKER_FAILURES = 3;
export const BREAKER_WINDOW_S = 1_800;
export const BREAKER_PAUSE_S = 1_800;

/** Ligne de agent_model_breaker (une par participant × modèle). */
export interface BreakerRow {
  consecutive_transient_failures: number;
  last_failure_at: number;
  circuit_open_until: number;
}

/**
 * État du maillon APRÈS un nouvel échec transitoire (prédicat pur, horloge
 * simulée) : maillon jamais trippé → la série ne compte que si les échecs restent
 * dans la fenêtre ; maillon déjà trippé (pause en cours ou réessai post-pause) →
 * tout échec rouvre la pause immédiatement (un essai par pause, pas de rafale).
 */
export function breakerAfterFailure(row: BreakerRow | null, now: number): { consecutive: number; open_until: number } {
  if (row && row.circuit_open_until > 0) {
    return { consecutive: row.consecutive_transient_failures + 1, open_until: now + BREAKER_PAUSE_S };
  }
  const withinWindow = !!row && now - row.last_failure_at <= BREAKER_WINDOW_S;
  const consecutive = withinWindow ? row!.consecutive_transient_failures + 1 : 1;
  return { consecutive, open_until: consecutive >= BREAKER_FAILURES ? now + BREAKER_PAUSE_S : 0 };
}

/** Un succès remet la série à zéro et ferme toute pause. */
export function breakerAfterSuccess(): { consecutive: number; open_until: number } {
  return { consecutive: 0, open_until: 0 };
}

/** Le maillon doit-il être écarté à l'instant courant (pause active) ? */
export function breakerSkipping(row: Pick<BreakerRow, 'circuit_open_until'> | null | undefined, now: number): boolean {
  return !!row && row.circuit_open_until > now;
}

/**
 * Pire cas de réservation Go-s d'une étape (128 Mo, v2 point 6) : la borne
 * effective de l'étape entière (appels + effets), pas un chiffre statique —
 * orchestrator en dérive GB_S_PER_STEP au lieu du 16 historique (calibré 125 s).
 */
export const DO_MEMORY_GB = 0.128;
export function worstCaseStepGbS(stepTimeoutMs: number = STEP_TIMEOUT_MS): number {
  return Math.ceil(DO_MEMORY_GB * (stepTimeoutMs / 1000));
}
