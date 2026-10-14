/**
 * R4 / lot C — catalogue de candidats, indépendant du registre D12 et du runtime.
 *
 * Ce module N'ACTIVE aucun endpoint. Les URLs, clés et tarifs utilisés pour une
 * invocation doivent venir des adaptateurs serveur revus, jamais de ce catalogue.
 * Les candidats gratuits n'ont pas non plus de droit de sonde automatique.
 */
export type CatalogueProvider =
  | 'workers-ai' | 'openrouter' | 'groq' | 'gemini' | 'zai' | 'deepseek';
export type CatalogueTier = 'free' | 'paid' | 'unverified';
export type CredentialContract = 'existing-binding' | 'existing-secret' | 'proposed-secret';

export interface ModelCandidate {
  /** Référence descriptive : ce n'est pas une attestation enregistrée. */
  readonly ref: string;
  readonly provider: CatalogueProvider;
  readonly model_id: string;
  /** Un prix / une éligibilité Free doit être revalidé au jour de la sonde. */
  readonly tier: CatalogueTier;
  /** Les limites d'un même pool ne se multiplient pas avec le nombre de modèles. */
  readonly quota_pool: string;
  /** URL publique du catalogue ou de la tarification, jamais une URL de dispatch. */
  readonly source_url: string;
  /** Pas de valeur de clé ni de nom de secret issu d'un formulaire Owner. */
  readonly credential_contract: CredentialContract;
  readonly secret_name: string;
  /** Toujours candidat : ni clé créée ni sonde réussie n'est inférée ici. */
  readonly catalogue_only: true;
  readonly probe_allowed: false;
  readonly dispatch_allowed: false;
  /** Paid et éligibilité non vérifiée : interdiction explicite. */
  readonly paid_disabled: boolean;
}

type CandidateInput = Omit<
  ModelCandidate, 'catalogue_only' | 'probe_allowed' | 'dispatch_allowed' | 'paid_disabled'
>;

const CANDIDATES: readonly CandidateInput[] = [
  {
    ref: 'workers-ai:@cf/zai-org/glm-4.7-flash',
    provider: 'workers-ai', model_id: '@cf/zai-org/glm-4.7-flash', tier: 'free',
    quota_pool: 'cloudflare:account-neurons', credential_contract: 'existing-binding',
    secret_name: 'AI', source_url: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
  },
  {
    ref: 'workers-ai:@cf/google/gemma-4-26b-a4b-it',
    provider: 'workers-ai', model_id: '@cf/google/gemma-4-26b-a4b-it', tier: 'free',
    quota_pool: 'cloudflare:account-neurons', credential_contract: 'existing-binding',
    secret_name: 'AI', source_url: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
  },
  {
    ref: 'openrouter:deepseek/deepseek-v4-flash:free',
    provider: 'openrouter', model_id: 'deepseek/deepseek-v4-flash:free', tier: 'free',
    quota_pool: 'openrouter:account-free', credential_contract: 'existing-secret',
    secret_name: 'LLM_KEY_OPENROUTER',
    source_url: 'https://openrouter.ai/deepseek/deepseek-v4-flash:free',
  },
  {
    ref: 'groq:openai/gpt-oss-20b',
    provider: 'groq', model_id: 'openai/gpt-oss-20b', tier: 'free',
    quota_pool: 'groq:organization', credential_contract: 'proposed-secret',
    secret_name: 'LLM_KEY_GROQ', source_url: 'https://console.groq.com/docs/rate-limits',
  },
  {
    ref: 'zai:glm-4.7-flash',
    provider: 'zai', model_id: 'glm-4.7-flash', tier: 'free',
    quota_pool: 'zai:account', credential_contract: 'proposed-secret',
    secret_name: 'LLM_KEY_ZAI', source_url: 'https://docs.z.ai/guides/overview/pricing',
  },
  {
    ref: 'gemini:gemini-2.5-flash-lite',
    provider: 'gemini', model_id: 'gemini-2.5-flash-lite', tier: 'unverified',
    quota_pool: 'gemini:project', credential_contract: 'proposed-secret',
    secret_name: 'LLM_KEY_GEMINI', source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
  },
  {
    ref: 'openrouter:qwen/qwen3.5-flash-02-23',
    provider: 'openrouter', model_id: 'qwen/qwen3.5-flash-02-23', tier: 'paid',
    quota_pool: 'openrouter:account-paid', credential_contract: 'existing-secret',
    secret_name: 'LLM_KEY_OPENROUTER',
    source_url: 'https://openrouter.ai/qwen/qwen3.5-flash-02-23',
  },
  {
    ref: 'openrouter:deepseek/deepseek-v4-flash-0731',
    provider: 'openrouter', model_id: 'deepseek/deepseek-v4-flash-0731', tier: 'paid',
    quota_pool: 'openrouter:account-paid', credential_contract: 'existing-secret',
    secret_name: 'LLM_KEY_OPENROUTER',
    source_url: 'https://openrouter.ai/deepseek/deepseek-v4-flash-20260731',
  },
  {
    ref: 'deepseek:deepseek-flash',
    provider: 'deepseek', model_id: 'deepseek-flash', tier: 'paid',
    quota_pool: 'deepseek:account', credential_contract: 'proposed-secret',
    secret_name: 'LLM_KEY_DEEPSEEK',
    source_url: 'https://api-docs.deepseek.com/quick_start/pricing/',
  },
  {
    ref: 'zai:glm-4.7-flashx',
    provider: 'zai', model_id: 'glm-4.7-flashx', tier: 'paid',
    quota_pool: 'zai:account', credential_contract: 'proposed-secret',
    secret_name: 'LLM_KEY_ZAI', source_url: 'https://docs.z.ai/guides/overview/pricing',
  },
  {
    ref: 'workers-ai:@cf/deepseek-ai/deepseek-v4-flash-0731',
    provider: 'workers-ai', model_id: '@cf/deepseek-ai/deepseek-v4-flash-0731',
    tier: 'paid', quota_pool: 'cloudflare:account-neurons',
    credential_contract: 'existing-binding', secret_name: 'AI',
    source_url: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
  },
  {
    ref: 'workers-ai:@cf/deepseek-ai/deepseek-v4-pro-0813',
    provider: 'workers-ai', model_id: '@cf/deepseek-ai/deepseek-v4-pro-0813',
    tier: 'paid', quota_pool: 'cloudflare:account-neurons',
    credential_contract: 'existing-binding', secret_name: 'AI',
    source_url: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
  },
];

/**
 * Les droits sont constants (false) : même si une clé existe, ce catalogue
 * ne peut servir de registre d'exécution. Owner register/probe/active reste
 * une chaîne distincte et les protections payantes des adaptateurs restent en place.
 */
export const MODEL_CANDIDATES: readonly ModelCandidate[] = Object.freeze(
  CANDIDATES.map(candidate => Object.freeze({
    ...candidate,
    catalogue_only: true as const,
    probe_allowed: false as const,
    dispatch_allowed: false as const,
    paid_disabled: candidate.tier !== 'free',
  })),
);

const BY_REF = new Map(MODEL_CANDIDATES.map(candidate => [candidate.ref, candidate]));

export function catalogueCandidate(ref: string): ModelCandidate | null {
  return BY_REF.get(ref) ?? null;
}

/** Un refus descriptif ; aucun appel réseau ou effet de bord. */
export function catalogueExecutionGate(ref: string): {
  readonly allowed: false;
  readonly reason: 'unknown_model' | 'paid_or_unverified' | 'catalogue_only';
} {
  const candidate = catalogueCandidate(ref);
  if (!candidate) return { allowed: false, reason: 'unknown_model' };
  if (candidate.paid_disabled) return { allowed: false, reason: 'paid_or_unverified' };
  return { allowed: false, reason: 'catalogue_only' };
}
