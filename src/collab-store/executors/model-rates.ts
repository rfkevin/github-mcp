/**
 * CC-7 L2 (PR 2.1, plan CC-PLAN-7 v0.2 S2) — registre des tarifs des modèles
 * par API fournisseur, daté en code.
 *
 * Instantané relevé le 2026-10-25 sur les pages tarifaires officielles
 * (source_url par entrée), en cents US par million de jetons. Deny-by-default :
 * une référence absente est refusée avant tout appel ; aucun modèle n'est
 * ajouté sans relevé daté. grok-4.1-fast est absent de la page xAI au moment
 * du relevé : il n'est PAS listé (aucune exécution possible).
 *
 * Ce registre est un garde-fou de coût, pas une autorisation d'exécution :
 * l'enveloppe PAR PARTICIPANT (agentrun/paid-model.ts) reste à 0 tant que
 * Kevin n'a pas posé les variables, et les secrets (LLM_KEY_*) sont posés par
 * Kevin seul sur le Worker. À revalider avant tout financement réel.
 */

/** Tarif d'un modèle par API : cents US par million de jetons, source du relevé. */
export interface ApiModelRate {
  /** Cents US par million de jetons d'entrée. */
  readonly input_per_m: number;
  /** Cents US par million de jetons de sortie. */
  readonly output_per_m: number;
  /** Page tarifaire officielle du relevé ; jamais une URL de dispatch. */
  readonly source_url: string;
  /** CC-7 L9a : date (UTC) du relevé de CETTE entrée ; absente = API_RATE_SNAPSHOT_DATE. */
  readonly as_of?: string;
}

/** Date (UTC) du relevé ; à revalider avant tout financement réel. */
export const API_RATE_SNAPSHOT_DATE = '2026-10-25';

const ZAI_PRICING = 'https://docs.z.ai/guides/overview/pricing';
const XAI_PRICING = 'https://docs.x.ai/docs/models';
const ANTHROPIC_PRICING = 'https://www.anthropic.com/pricing';
// CC-7 L8 : relevés du 2026-10-27 sur les pages officielles (Gemini : palier Standard payant ;
// gemini-3.6-flash passe à 150 / 750 le 2027-01-01 — à revalider avant cette date).
const GEMINI_PRICING = 'https://ai.google.dev/gemini-api/docs/pricing';
const GROQ_GPT_OSS_120B_PRICING = 'https://console.groq.com/docs/model/openai/gpt-oss-120b';

/**
 * Tarifs relevés le 2026-10-25 (cents US / million de jetons), deny-by-default.
 * anthropic:claude-haiku-5-5 : tarif des prompts <= 100k jetons (palier
 * long-contexte non relevé, donc non couvert par cette entrée).
 */
export const API_MODEL_RATES: Readonly<Record<string, ApiModelRate>> = {
  'zai:glm-5.3': { input_per_m: 140, output_per_m: 440, source_url: ZAI_PRICING },
  'zai:glm-5.3-flash': { input_per_m: 15, output_per_m: 50, source_url: ZAI_PRICING },
  'zai:glm-5.3-flashx': { input_per_m: 37, output_per_m: 125, source_url: ZAI_PRICING },
  'xai:grok-4.7': { input_per_m: 200, output_per_m: 600, source_url: XAI_PRICING },
  'xai:grok-4.20-0309-non-reasoning': { input_per_m: 125, output_per_m: 250, source_url: XAI_PRICING },
  'xai:grok-build-0.1': { input_per_m: 100, output_per_m: 200, source_url: XAI_PRICING },
  'anthropic:claude-sonnet-5-5': { input_per_m: 200, output_per_m: 1000, source_url: ANTHROPIC_PRICING },
  'anthropic:claude-haiku-5-5': { input_per_m: 10, output_per_m: 50, source_url: ANTHROPIC_PRICING },
  // CC-7 L9b : relevé du 2026-10-27 (page tarifaire de la plateforme Claude).
  'anthropic:claude-opus-5-5': { input_per_m: 400, output_per_m: 2000, source_url: 'https://platform.claude.com/docs/en/about-claude/pricing', as_of: '2026-10-27' },
  // Gamme Mythos (au-dessus d'Opus), version publique avec protections renforcées ; même relevé.
  'anthropic:claude-fable-5-1': { input_per_m: 1000, output_per_m: 5000, source_url: 'https://platform.claude.com/docs/en/about-claude/pricing', as_of: '2026-10-27' },
  'gemini:gemini-3.5-flash-lite': { input_per_m: 30, output_per_m: 250, source_url: GEMINI_PRICING , as_of: '2026-10-27' },
  'gemini:gemini-3.6-flash': { input_per_m: 75, output_per_m: 375, source_url: GEMINI_PRICING , as_of: '2026-10-27' },
  'groq:openai/gpt-oss-120b': { input_per_m: 15, output_per_m: 60, source_url: GROQ_GPT_OSS_120B_PRICING , as_of: '2026-10-27' },
};

/** Recherche par référence complète <fournisseur>:<modèle> ; absente = null (deny-by-default). */
export function apiModelRate(ref: string): ApiModelRate | null {
  return API_MODEL_RATES[ref] ?? null;
}

/**
 * Cents US d'un appel (arrondi au cent supérieur, jamais sous-évalué) :
 * jetons d'entrée et de sortie au tarif relevé du modèle.
 */
export function centsOfApiTokens(rate: ApiModelRate, inputTokens: number, outputTokens: number): number {
  const input = Math.max(0, Math.floor(inputTokens));
  const output = Math.max(0, Math.floor(outputTokens));
  return Math.ceil((input * rate.input_per_m + output * rate.output_per_m) / 1_000_000);
}
