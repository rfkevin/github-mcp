/**
 * CC-7 L9b — niveaux de réflexion (faible, moyen, élevé, très élevé) traduits par fournisseur.
 * Relevés du 2026-10-27 sur la documentation officielle de chaque fournisseur :
 * - Anthropic (Opus / Sonnet / Haiku 5.5) : thinking {type: 'adaptive'} + output_config.effort
 *   low | medium | high | xhigh (les cinq niveaux, max compris, sont pris en charge sur ces modèles) ;
 * - xAI : reasoning_effort low | medium | high | xhigh sur grok-4.7 et grok-4.6 (grok-4.5 traite xhigh
 *   comme high) ; les autres modèles (non-reasoning, build) ne reçoivent rien ;
 * - Groq gpt-oss : reasoning_effort low | medium | high (xhigh → high) ;
 * - OpenRouter : reasoning.effort low | medium | high (xhigh → high) ;
 * - Z.ai : thinking enabled / disabled seulement ; glm-5.3* pense toujours (rien n'est envoyé) ;
 * - Gemini 3.x : thinkingLevel minimal | low | medium | high ;
 * - Workers AI et DeepSeek : aucun réglage (options historiques inchangées).
 * La réflexion consomme des jetons de SORTIE : le plafond de sortie de l'étape est multiplié
 * (borné à 8192) et l'estimation de coût suit ce plafond — le budget de l'agent voit le vrai pire cas.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type Effort = typeof EFFORTS[number];
export const EFFORT_LABELS: Readonly<Record<Effort, string>> = { low: 'faible', medium: 'moyen', high: 'élevé', xhigh: 'très élevé' };
/** Plafond de sortie absolu d'une étape (contrat du noyau payant). */
export const MAX_STEP_OUTPUT_TOKENS = 8192;
const OUTPUT_FACTOR: Readonly<Record<Effort, number>> = { low: 1, medium: 1.5, high: 2, xhigh: 3 };

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

/** Réflexion par défaut d'un type de tâche quand personne ne l'a choisie. */
export function defaultEffort(kind: string): Effort {
  if (kind === 'review' || kind === 'test') return 'high';
  if (kind === 'implement' || kind === 'design') return 'medium';
  return 'low';
}

/** Niveaux plus légers, du demandé jusqu'à faible (descente quand le budget est serré). */
export function effortsDownFrom(effort: Effort): Effort[] {
  return EFFORTS.slice(0, EFFORTS.indexOf(effort) + 1).reverse();
}

/** Plafond de sortie d'une étape pour ce niveau (borné à MAX_STEP_OUTPUT_TOKENS). */
export function effortMaxTokens(base: number, effort: Effort | null): number {
  return Math.min(MAX_STEP_OUTPUT_TOKENS, Math.ceil(base * OUTPUT_FACTOR[effort ?? 'low']));
}

/** Le fournisseur de cette référence accepte-t-il un réglage de réflexion ? */
export function effortSupported(ref: string): boolean {
  return effortOptions(ref, 'high') !== null;
}

/** Options de corps propres au fournisseur pour ce niveau ; null = aucun réglage pris en charge (rien n'est envoyé). */
export function effortOptions(ref: string, effort: Effort): Record<string, unknown> | null {
  const colon = ref.indexOf(':');
  const provider = ref.slice(0, colon);
  const model = ref.slice(colon + 1);
  const capped = effort === 'xhigh' ? 'high' : effort;
  switch (provider) {
    case 'anthropic':
      return { thinking: { type: 'adaptive' }, output_config: { effort } };
    case 'xai':
      return /^grok-4\.[5-9]/.test(model) && !/non-reasoning/.test(model) ? { reasoning_effort: effort } : null;
    case 'groq':
      return model.startsWith('openai/gpt-oss') ? { reasoning_effort: capped } : null;
    case 'openrouter':
      return { reasoning: { effort: capped } };
    case 'zai':
      return /^glm-5\.3/.test(model) ? null : { thinking: { type: effort === 'low' ? 'disabled' : 'enabled' } };
    case 'gemini':
      return { thinkingLevel: effort === 'xhigh' ? 'high' : effort === 'low' ? 'minimal' : effort === 'medium' ? 'low' : 'medium' };
    default:
      return null;
  }
}
