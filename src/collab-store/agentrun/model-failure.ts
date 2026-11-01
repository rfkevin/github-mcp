/** CC8 S1b : seules les erreurs de transport explicitement transitoires autorisent un repli. */
export type FailureKind = 'transient' | 'permanent';
export function modelFailureKind(error: unknown): FailureKind {
  const value = error instanceof Error ? error.message : String(error);
  if (/MODEL_ROUTE_REFUSED|MODEL_BUDGET_EXHAUSTED|PAID_ENVELOPE_NOT_FUNDED|MODEL_ROUTE_NONE|MODEL_PROVIDER_UNSUPPORTED|MODEL_.*UNSUPPORTED|\b(?:400|401|403|404)\b/i.test(value)) return 'permanent';
  // CC-8 S1b-2 : CIRCUIT_OPEN (tous les maillons du participant en pause coupe-circuit) = indisponibilité
  // temporaire → la relance d’exécution S1b recrée l’exécution une fois la pause expirée.
  // CC-8 S1b-2 : CIRCUIT_OPEN (tous les maillons du participant en pause coupe-circuit) et
  // STEP_MODEL_BUDGET_EXHAUSTED (budget d'appels de l'étape épuisé) = indisponibilité
  // temporaire → la relance d’exécution S1b recrée l’exécution proprement.
  if (/\b(?:429|502|503|504)\b|timeout|timed out|network|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|AbortError|circuit_open|step_model_budget/i.test(value)) return 'transient';
  // fetchWithTimeout produit ce message français ; les wrappers ModelCallError conservent le message, pas le code EXECUTOR_TIMEOUT.
  if (/Fournisseur sans réponse après \d+ ms\./i.test(value)) return 'transient';
  return 'permanent';
}
