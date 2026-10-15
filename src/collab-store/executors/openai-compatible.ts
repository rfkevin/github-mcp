/**
 * CC-4 A3c / R4 lot A — adaptateur LLM compatible OpenAI multi-fournisseurs.
 * URL et nom de secret = constantes serveur uniquement (jamais attestation,
 * notes ou POST). Paid hors allowlist Free → EXECUTOR_PAID_MODEL avant fetch.
 * Groq : config/catalogue ok, runtime bloqué tant que le plan non-facturable
 * n'est pas prouvé et approuvé Owner (Free vs Developer facturable).
 */
import { StateContractError } from '../../collab/contracts';
import {
  assertGenerateInput, envelope, readWorkersAiOutput,
  type LlmAdapter, type LlmInput,
} from './adapter';

export const OPENROUTER_PROVIDER = 'openrouter';
export const GROQ_PROVIDER = 'groq';
export const DEEPSEEK_PROVIDER = 'deepseek';
export const ZAI_PROVIDER = 'zai';

export type OpenAiCompatibleProvider =
  | typeof OPENROUTER_PROVIDER
  | typeof GROQ_PROVIDER
  | typeof DEEPSEEK_PROVIDER
  | typeof ZAI_PROVIDER;

export const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEEPSEEK_CHAT_COMPLETIONS_URL = 'https://api.deepseek.com/chat/completions';
export const ZAI_CHAT_COMPLETIONS_URL = 'https://api.z.ai/api/paas/v4/chat/completions';

const DEFAULT_TIMEOUT_MS = 30_000;
/** OpenRouter org/model */
const OR_MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/i;
/** Ids simples ou org/model (Groq, DeepSeek, Z.AI) */
const GENERIC_MODEL_RE = /^[a-z0-9][a-z0-9._/-]{0,127}$/i;

interface ProviderConfig {
  readonly endpoint: string;
  readonly secret: keyof OpenAiCompatibleEnv;
  /** Si true, le body inclut provider.data_collection=deny (OpenRouter). */
  readonly denyDataCollection: boolean;
}

const PROVIDERS: Readonly<Record<OpenAiCompatibleProvider, ProviderConfig>> = {
  openrouter: {
    endpoint: OPENROUTER_CHAT_COMPLETIONS_URL,
    secret: 'LLM_KEY_OPENROUTER',
    denyDataCollection: true,
  },
  groq: {
    endpoint: GROQ_CHAT_COMPLETIONS_URL,
    secret: 'LLM_KEY_GROQ',
    denyDataCollection: false,
  },
  deepseek: {
    endpoint: DEEPSEEK_CHAT_COMPLETIONS_URL,
    secret: 'LLM_KEY_DEEPSEEK',
    denyDataCollection: false,
  },
  zai: {
    endpoint: ZAI_CHAT_COMPLETIONS_URL,
    secret: 'LLM_KEY_ZAI',
    denyDataCollection: false,
  },
};

/**
 * Fournisseurs dont le runtime est interdit : la présence d'une clé ne prouve
 * pas un compte non facturable. Owner doit approuver un contrat vérifiable
 * avant tout fetch (review Sol #144 CHANGE_REQUEST).
 */
const RUNTIME_BLOCKED_PROVIDERS: ReadonlySet<OpenAiCompatibleProvider> = new Set([
  GROQ_PROVIDER,
]);

/** Allowlist Free exécutable (deny-by-default). Groq vide : catalogue only. */
const FREE_MODELS: Readonly<Record<OpenAiCompatibleProvider, ReadonlySet<string>>> = {
  /** OpenRouter : tout modèle avec suffixe :free (validé à part). */
  openrouter: new Set(),
  groq: new Set(),
  deepseek: new Set(),
  zai: new Set(['glm-4.7-flash']),
};

/** Paid connus — refusés même si secret présent (dormant, 0 €). */
const PAID_MODELS: Readonly<Record<OpenAiCompatibleProvider, ReadonlySet<string>>> = {
  openrouter: new Set(),
  groq: new Set(['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'openai/gpt-oss-20b']),
  deepseek: new Set(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner']),
  zai: new Set(['glm-4.7-flashx']),
};

export interface OpenAiCompatibleEnv {
  LLM_KEY_OPENROUTER?: string;
  LLM_KEY_GROQ?: string;
  LLM_KEY_DEEPSEEK?: string;
  LLM_KEY_ZAI?: string;
}

export interface OpenAiCompatibleOptions {
  fetchImpl?: typeof fetch;
  timeout_ms?: number;
}

function executorError(code: string, message: string): StateContractError {
  return new StateContractError(code, message, 'executor');
}

export function openAiCompatibleProviderOf(attestationRef: string): OpenAiCompatibleProvider | null {
  const colon = attestationRef.indexOf(':');
  if (colon <= 0) return null;
  const prefix = attestationRef.slice(0, colon);
  if (prefix === OPENROUTER_PROVIDER || prefix === GROQ_PROVIDER
    || prefix === DEEPSEEK_PROVIDER || prefix === ZAI_PROVIDER) {
    return prefix;
  }
  return null;
}

/**
 * Parse `provider:model`.
 * - openrouter : suffixe `:free` obligatoire
 * - groq : runtime bloqué (facturation compte non vérifiée)
 * - autres : allowlist Free ; paid listés → EXECUTOR_PAID_MODEL
 */
export function parseOpenAiCompatibleRef(
  attestationRef: string,
): { provider: OpenAiCompatibleProvider; model: string } {
  const provider = openAiCompatibleProviderOf(attestationRef);
  if (!provider) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Fournisseur compatible OpenAI non pris en charge.');
  }
  const model = attestationRef.slice(provider.length + 1);
  if (!model) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Référence de modèle vide.');
  }

  // Avant Free/Paid : aucun fetch Groq tant que Owner n'a pas prouvé un plan 0 €.
  if (RUNTIME_BLOCKED_PROVIDERS.has(provider)) {
    throw executorError(
      'EXECUTOR_UNAVAILABLE',
      'Runtime ' + provider + ' bloqué : facturation du compte non vérifiée (catalogue only, 0 fetch).',
    );
  }

  if (provider === OPENROUTER_PROVIDER) {
    if (!model.endsWith(':free')) {
      throw executorError('EXECUTOR_PAID_MODEL', 'Le modèle OpenRouter doit porter le suffixe :free (pilote à 0 €).');
    }
    const baseModel = model.slice(0, -':free'.length);
    if (!OR_MODEL_RE.test(baseModel)) {
      throw executorError('EXECUTOR_UNSUPPORTED', 'Référence de modèle OpenRouter invalide.');
    }
    return { provider, model };
  }

  if (!GENERIC_MODEL_RE.test(model)) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Référence de modèle invalide.');
  }
  if (PAID_MODELS[provider].has(model)) {
    throw executorError('EXECUTOR_PAID_MODEL', 'Modèle payant refusé (0 € / paid dormant) : ' + model + '.');
  }
  if (!FREE_MODELS[provider].has(model)) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Modèle hors allowlist Free vérifiée : ' + model + '.');
  }
  return { provider, model };
}

function providerSecret(env: OpenAiCompatibleEnv, name: keyof OpenAiCompatibleEnv): string {
  const value = env[name]?.trim() ?? '';
  if (!value) {
    throw executorError('EXECUTOR_UNAVAILABLE', 'Secret du fournisseur absent de cet environnement.');
  }
  return value;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(executorError('EXECUTOR_TIMEOUT', 'Fournisseur sans réponse après ' + timeoutMs + ' ms.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Adaptateur universel : une entrée PROVIDERS par fournisseur.
 * La clé reste dans l'env Worker ; l'URL est la constante serveur.
 */
export function createOpenAiCompatibleAdapter(
  env: OpenAiCompatibleEnv,
  attestationRef: string,
  options: OpenAiCompatibleOptions = {},
): LlmAdapter {
  const parsed = parseOpenAiCompatibleRef(attestationRef);
  const config = PROVIDERS[parsed.provider];
  const secret = providerSecret(env, config.secret);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.min(Math.max(Math.trunc(options.timeout_ms ?? DEFAULT_TIMEOUT_MS), 1), DEFAULT_TIMEOUT_MS);
  return {
    provider: parsed.provider,
    model: parsed.model,
    validate: assertGenerateInput,
    worstCaseNeurons(input: LlmInput) {
      assertGenerateInput(input);
      return 0;
    },
    neuronsFor: () => 0,
    async generate(input) {
      assertGenerateInput(input);
      const body: Record<string, unknown> = {
        model: parsed.model,
        messages: envelope(input.control, input.data),
        max_tokens: input.max_tokens,
      };
      if (config.denyDataCollection) {
        body.provider = { data_collection: 'deny' };
      }
      const response = await fetchWithTimeout(fetchImpl, config.endpoint, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + secret,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }, timeoutMs);
      if (!response.ok) {
        throw executorError('EXECUTOR_UPSTREAM_HTTP', 'Fournisseur HTTP ' + response.status + '.');
      }
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw executorError('EXECUTOR_BAD_RESPONSE', 'Réponse du fournisseur sans JSON exploitable.');
      }
      const { text, usage } = readWorkersAiOutput(raw);
      return { text, usage, provider: parsed.provider, model: parsed.model };
    },
  };
}
