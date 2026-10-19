/**
 * CC-5 L1 — profils modèle × tâche, plafonds de jetons, fenêtres de débit.
 *
 * Ordre imposé par le plan : poser les bornes par type de tâche PUIS retirer
 * le plafond global fixe 2048. Le plafond effectif est
 * min(plafond modèle, borne task_kind, plafond endpoint, demandé).
 *
 * task_kind : fourni exclusivement par le code serveur de confiance
 * (dispatchFreeInvocation n'est pas exposé aux agents). Absent / inconnu →
 * 'default' (2048) est une politique volontaire, pas un trou de sécurité.
 *
 * thinking (off/low/medium) : table déclarative pour un câblage futur par
 * adaptateur. L1 n'applique que les plafonds de jetons ; le contrôle de
 * raisonnement reste fixe par modèle (MODEL_CALL_OPTIONS / MODEL_REQUEST_OPTIONS).
 *
 * Les chiffres externes (RPM/RPD) sont des instantanés datés 2026-10-18,
 * à revalider le jour d'activation (X12). Aucune dépense.
 */

/** Types de tâche du chemin gratuit (extensible). */
export type TaskKind =
  | 'probe'
  | 'classify'
  | 'review'
  | 'design'
  | 'diagnose'
  | 'default';

export interface TaskProfile {
  /** Plafond de jetons de sortie pour ce type de tâche. */
  max_tokens: number;
  /** Effort de réflexion demandé quand l'API le supporte. */
  thinking: 'off' | 'low' | 'medium';
}

/**
 * Bornes par type de tâche (valeurs initiales L1 ; Kevin peut resserrer via
 * budget coordinateur, le code refuse toute hausse au-dessus du plafond modèle).
 */
export const TASK_KIND_BOUNDS: Readonly<Record<TaskKind, TaskProfile>> = {
  probe: { max_tokens: 256, thinking: 'off' },
  classify: { max_tokens: 512, thinking: 'off' },
  review: { max_tokens: 2_048, thinking: 'low' },
  design: { max_tokens: 4_096, thinking: 'low' },
  diagnose: { max_tokens: 1_024, thinking: 'low' },
  default: { max_tokens: 2_048, thinking: 'off' },
};

/**
 * Plafond absolu de sécurité (après retrait du 2048 global). Au-delà : refus
 * local, aucun appel fournisseur.
 */
export const ABSOLUTE_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Plafonds de sortie par modèle (allowlist free). Absent → ABSOLUTE_MAX.
 * Instantané 2026-10-18 ; ne pas confondre avec le context window complet.
 */
export const MODEL_TOKEN_CEILING: Readonly<Record<string, number>> = {
  '@cf/zai-org/glm-4.7-flash': 4_096,
  '@cf/google/gemma-4-26b-a4b-it': 4_096,
  'openai/gpt-oss-20b': 4_096,
  'glm-4.7-flash': 4_096,
};

/**
 * Fenêtres de débit documentées (soft). Le code applique déjà daily_cap (50)
 * et neuron_budget ; ces constantes servent de référence L0/L1 et de base
 * pour de futurs compteurs RPM si mesurés.
 */
export const PROVIDER_RATE_WINDOWS: Readonly<Record<string, {
  rpm?: number;
  rpd?: number;
  notes: string;
}>> = {
  groq: { rpm: 30, rpd: 1_000, notes: 'Free tier openai/gpt-oss-20b — snapshot 2026-10-18 console.groq.com' },
  gemini: { notes: 'gemini-3.5-flash-lite free-of-charge ; RPD non publié — snapshot 2026-10-18' },
  'workers-ai': { notes: '10 000 neurons/j partagés ; daily_cap serveur 50 appels/endpoint' },
  zai: { notes: 'glm-4.7-flash free path ; timeouts L0 90 s' },
  openrouter: { notes: 'suffixe :free uniquement' },
  deepseek: { notes: 'paid dormant' },
  xai: { notes: '100 % paid dormant' },
};

export function normalizeTaskKind(value: string | undefined | null): TaskKind {
  if (value === 'probe' || value === 'classify' || value === 'review'
    || value === 'design' || value === 'diagnose') {
    return value;
  }
  return 'default';
}

/**
 * Plafond effectif d'un appel : min(absolu, modèle, task_kind, endpoint, demandé).
 * Si `requested` est omis, utilise la borne task_kind.
 */
export function resolveEffectiveMaxTokens(input: {
  task_kind?: string | null;
  model?: string | null;
  endpoint_ceiling?: number | null;
  requested?: number | null;
}): number {
  const kind = normalizeTaskKind(input.task_kind);
  const taskBound = TASK_KIND_BOUNDS[kind].max_tokens;
  const modelCeiling = (input.model && MODEL_TOKEN_CEILING[input.model])
    || ABSOLUTE_MAX_OUTPUT_TOKENS;
  const endpoint = typeof input.endpoint_ceiling === 'number'
    && Number.isSafeInteger(input.endpoint_ceiling)
    && input.endpoint_ceiling > 0
    ? input.endpoint_ceiling
    : ABSOLUTE_MAX_OUTPUT_TOKENS;
  const requested = typeof input.requested === 'number'
    && Number.isSafeInteger(input.requested)
    && input.requested > 0
    ? input.requested
    : taskBound;
  return Math.min(ABSOLUTE_MAX_OUTPUT_TOKENS, modelCeiling, taskBound, endpoint, requested);
}

export function thinkingForTaskKind(taskKind?: string | null): TaskProfile['thinking'] {
  return TASK_KIND_BOUNDS[normalizeTaskKind(taskKind)].thinking;
}

/**
 * Tronque une chaîne sur une frontière de caractère UTF-8 (pas au milieu d'un
 * code point), pour la borne output_text (L0 follow-up).
 */
export function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return '';
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= maxBytes) return text;
  let end = maxBytes;
  // UTF-8 continuation bytes are 0b10xxxxxx — back up to a lead byte.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(encoded.subarray(0, end));
}
