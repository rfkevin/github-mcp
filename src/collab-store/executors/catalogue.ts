/**
 * R4 / lot C — catalogue candidat purement descriptif : pas un registre D12.
 *
 * Les routes d'exécution et les secrets sont définis uniquement côté serveur
 * dans les adaptateurs revus. Une entrée listée ne crée ni endpoint, ni sonde.
 */
export type CatalogueProvider =
  | 'workers-ai' | 'openrouter' | 'groq' | 'gemini' | 'zai' | 'deepseek' | 'xai' | 'anthropic';
export type CatalogueTier = 'free' | 'paid' | 'unverified';
export type CredentialContract = 'existing-binding' | 'existing-secret' | 'proposed-secret';

export interface ModelCandidate {
  readonly ref: string;
  readonly provider: CatalogueProvider;
  readonly model_id: string;
  /** Free et tarifs à revalider lors d'une future demande Owner. */
  readonly tier: CatalogueTier;
  /** Pool partagé : plusieurs modèles ne multiplient pas les quotas. */
  readonly quota_pool: string;
  /** Page publique de référence, jamais URL utilisable pour le dispatch. */
  readonly source_url: string;
  readonly credential_contract: CredentialContract;
  readonly secret_name: string;
  readonly catalogue_only: true;
  readonly probe_allowed: false;
  readonly dispatch_allowed: false;
  /** Paid ET Free non confirmé sont désactivés par défaut. */
  readonly paid_disabled: boolean;
}

type ProviderMeta = Readonly<{
  quota_pool: string;
  credential_contract: CredentialContract;
  secret_name: string;
  source_url: string;
}>;

/** Metadata de fournisseur, aucune valeur de secret ou d'endpoint réseau. */
const PROVIDERS: Readonly<Record<CatalogueProvider, ProviderMeta>> = {
  'workers-ai': {
    quota_pool: 'cloudflare:account-neurons', credential_contract: 'existing-binding',
    secret_name: 'AI', source_url: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
  },
  openrouter: {
    quota_pool: 'openrouter:account', credential_contract: 'existing-secret',
    secret_name: 'LLM_KEY_OPENROUTER', source_url: 'https://openrouter.ai/models',
  },
  groq: {
    quota_pool: 'groq:organization', credential_contract: 'proposed-secret',
    secret_name: 'LLM_KEY_GROQ', source_url: 'https://console.groq.com/docs/rate-limits',
  },
  gemini: {
    quota_pool: 'gemini:project', credential_contract: 'proposed-secret',
    secret_name: 'LLM_KEY_GEMINI', source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
  },
  zai: {
    quota_pool: 'zai:account', credential_contract: 'proposed-secret',
    secret_name: 'LLM_KEY_ZAI', source_url: 'https://docs.z.ai/guides/overview/pricing',
  },
  deepseek: {
    quota_pool: 'deepseek:account', credential_contract: 'proposed-secret',
    secret_name: 'LLM_KEY_DEEPSEEK', source_url: 'https://api-docs.deepseek.com/quick_start/pricing/',
  },
  // CC-7 L2 (S2) : fournisseurs des API payantes par participant (descriptifs seulement).
  xai: {
    quota_pool: 'xai:account', credential_contract: 'proposed-secret',
    secret_name: 'LLM_KEY_XAI', source_url: 'https://docs.x.ai/developers/pricing',
  },
  anthropic: {
    quota_pool: 'anthropic:organization', credential_contract: 'proposed-secret',
    secret_name: 'LLM_KEY_ANTHROPIC', source_url: 'https://platform.claude.com/docs/en/about-claude/pricing',
  },
};

type ModelSeed = readonly [CatalogueProvider, string, CatalogueTier, string?];

/** Candidats seulement : modèle, gratuité et disponibilité peuvent évoluer. */
const MODELS: readonly ModelSeed[] = [
  ['workers-ai', '@cf/zai-org/glm-4.7-flash', 'free'],
  ['workers-ai', '@cf/google/gemma-4-26b-a4b-it', 'free'],
  ['workers-ai', '@cf/deepseek-ai/deepseek-v4-flash-0731', 'paid'],
  ['workers-ai', '@cf/deepseek-ai/deepseek-v4-pro-0813', 'paid'],
  ['openrouter', 'deepseek/deepseek-v4-flash:free', 'free',
    'https://openrouter.ai/deepseek/deepseek-v4-flash:free'],
  ['openrouter', 'deepseek/deepseek-v4-flash-0731', 'paid',
    'https://openrouter.ai/deepseek/deepseek-v4-flash-20260731'],
  ['openrouter', 'qwen/qwen3.5-flash-02-23', 'paid',
    'https://openrouter.ai/qwen/qwen3.5-flash-02-23'],
  ['groq', 'openai/gpt-oss-20b', 'free'],
  // Cible Free adaptateur R4 ; tier unverified = accès clé non prouvé (pas de sonde).
  ['gemini', 'gemini-3.5-flash-lite', 'unverified'],
  ['zai', 'glm-4.7-flash', 'free'],
  ['zai', 'glm-4.7-flashx', 'paid'],
  // CC-7 L2 : candidats des API payantes par participant (registre réel : executors/model-rates.ts).
  ['zai', 'glm-5.3', 'paid'],
  ['zai', 'glm-5.3-flash', 'paid'],
  ['zai', 'glm-5.3-flashx', 'paid'],
  ['xai', 'grok-4.7', 'paid'],
  ['xai', 'grok-4.20-0309-non-reasoning', 'paid'],
  ['xai', 'grok-build-0.1', 'paid'],
  ['anthropic', 'claude-sonnet-5-5', 'paid'],
  ['anthropic', 'claude-haiku-5-5', 'paid'],
  ['deepseek', 'deepseek-flash', 'paid'],
];

/** Toute entrée reste inerte même si une clé fournisseur est déjà présente. */
export const MODEL_CANDIDATES: readonly ModelCandidate[] = Object.freeze(
  MODELS.map(([provider, model_id, tier, source_url]) => {
    const metadata = PROVIDERS[provider];
    return Object.freeze({
      ref: provider + ':' + model_id, provider, model_id, tier,
      quota_pool: provider === 'openrouter'
        ? 'openrouter:account-' + (tier === 'free' ? 'free' : 'paid')
        : metadata.quota_pool,
      source_url: source_url ?? metadata.source_url,
      credential_contract: metadata.credential_contract,
      secret_name: metadata.secret_name,
      catalogue_only: true as const,
      probe_allowed: false as const,
      dispatch_allowed: false as const,
      paid_disabled: tier !== 'free',
    });
  }),
);

const BY_REF = new Map(MODEL_CANDIDATES.map(candidate => [candidate.ref, candidate]));

export function catalogueCandidate(ref: string): ModelCandidate | null {
  return BY_REF.get(ref) ?? null;
}

/** Refus du catalogue ; seuls les registres/gates Owner autorisent l'exécution. */
export function catalogueExecutionGate(ref: string): {
  readonly allowed: false;
  readonly reason: 'unknown_model' | 'paid_or_unverified' | 'catalogue_only';
} {
  const candidate = catalogueCandidate(ref);
  if (!candidate) return { allowed: false, reason: 'unknown_model' };
  if (candidate.paid_disabled) return { allowed: false, reason: 'paid_or_unverified' };
  return { allowed: false, reason: 'catalogue_only' };
}
