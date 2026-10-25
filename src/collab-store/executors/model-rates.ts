/**
 * CC-7 L2 (S2/S3 de CC-PLAN-7 v0.2) — registre des tarifs des API payantes
 * par participant, daté et versionné en code (comme PAID_MODEL_RATES de l7d).
 *
 * Relevé du 2026-10-25 sur les pages tarifaires officielles ouvertes :
 * - Z.ai : https://docs.z.ai/guides/overview/pricing (GLM-5.3, Flash, FlashX) ;
 * - xAI : https://docs.x.ai/developers/models (grok-4.7, grok-4.20-0309,
 *   grok-build-0.1) — prix « court contexte » (< 200k jetons de prompt) ;
 * - Anthropic : https://platform.claude.com/docs/en/about-claude/pricing
 *   (claude-sonnet-5-5, claude-haiku-5-5 — Haiku au tarif « prompts ≤ 100k »).
 *
 * Deny-by-default : une référence absente est refusée (PAID_MODEL_UNSUPPORTED),
 * y compris les modèles gratuits et grok-4.1-fast, retiré de la page officielle
 * xAI. Les prix des propositions (S16) ne font pas foi ; ce registre prime (S3).
 * À relire et revalider sur la documentation officielle avant toute enveloppe
 * financée : un tarif périmé se corrige par une nouvelle date de relevé.
 *
 * Unités : cents de dollars US par million de jetons. Les tarifs long contexte
 * (xAI ≥ 200k jetons, Haiku > 100k) et le cache d’entrée facturé séparément ne
 * sont pas utilisés : les prompts du canal API restent loin de ces seuils.
 */
export type ApiProviderName = 'zai' | 'xai' | 'anthropic';

/** Taux d’un modèle d’API payante (cents par million de jetons, entrée et sortie). */
export interface ApiModelRate {
  readonly provider: ApiProviderName;
  readonly input_cents_per_m: number;
  readonly output_cents_per_m: number;
  /** Page tarifaire officielle du relevé ; jamais une URL appelée en production. */
  readonly source_url: string;
}

/** Date du relevé officiel (S3) ; une revalidation = une nouvelle date. */
export const API_MODEL_RATES_DATE = '2026-10-25';

export const API_MODEL_RATES: Readonly<Record<string, ApiModelRate>> = {
  'zai:glm-5.3': { provider: 'zai', input_cents_per_m: 140, output_cents_per_m: 440, source_url: 'https://docs.z.ai/guides/overview/pricing' },
  'zai:glm-5.3-flash': { provider: 'zai', input_cents_per_m: 15, output_cents_per_m: 50, source_url: 'https://docs.z.ai/guides/overview/pricing' },
  'zai:glm-5.3-flashx': { provider: 'zai', input_cents_per_m: 37, output_cents_per_m: 125, source_url: 'https://docs.z.ai/guides/overview/pricing' },
  'xai:grok-4.7': { provider: 'xai', input_cents_per_m: 200, output_cents_per_m: 600, source_url: 'https://docs.x.ai/developers/models' },
  'xai:grok-4.20-0309-non-reasoning': { provider: 'xai', input_cents_per_m: 125, output_cents_per_m: 250, source_url: 'https://docs.x.ai/developers/models' },
  'xai:grok-build-0.1': { provider: 'xai', input_cents_per_m: 100, output_cents_per_m: 200, source_url: 'https://docs.x.ai/developers/models' },
  'anthropic:claude-sonnet-5-5': { provider: 'anthropic', input_cents_per_m: 200, output_cents_per_m: 1000, source_url: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  'anthropic:claude-haiku-5-5': { provider: 'anthropic', input_cents_per_m: 10, output_cents_per_m: 50, source_url: 'https://platform.claude.com/docs/en/about-claude/pricing' },
};

export interface ParsedApiModelRef {
  readonly provider: ApiProviderName;
  readonly model: string;
  readonly rate: ApiModelRate;
}

/** Référence <fournisseur>:<modèle> du registre daté : deny-by-default, tout le reste est refusé à la construction. */
export function parseApiModelRef(ref: string): ParsedApiModelRef {
  const colon = ref.indexOf(':');
  if (colon <= 0) {
    throw new Error('PAID_MODEL_UNSUPPORTED : référence de modèle illisible : ' + ref + '.');
  }
  const provider = ref.slice(0, colon);
  if (provider !== 'zai' && provider !== 'xai' && provider !== 'anthropic') {
    throw new Error('PAID_MODEL_UNSUPPORTED : fournisseur non pris en charge pour le chemin payant API : ' + provider + '.');
  }
  const rate = API_MODEL_RATES[ref];
  if (!rate) {
    throw new Error('PAID_MODEL_UNSUPPORTED : ' + ref + ' hors du registre daté ' + API_MODEL_RATES_DATE + ' (deny-by-default).');
  }
  return { provider, model: ref.slice(colon + 1), rate };
}

/** Coût d’un appel en cents, arrondi au cent supérieur, jamais sous-évalué. */
export function apiModelCents(rate: ApiModelRate, inputTokens: number, outputTokens: number): number {
  const input = Math.max(0, Math.floor(inputTokens));
  const output = Math.max(0, Math.floor(outputTokens));
  return Math.ceil((input * rate.input_cents_per_m + output * rate.output_cents_per_m) / 1_000_000);
}
