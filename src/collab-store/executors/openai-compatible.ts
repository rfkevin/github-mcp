/**
 * CC-4 A3c / R4 lot A — adaptateur LLM compatible OpenAI multi-fournisseurs.
 * URL et nom de secret = constantes serveur uniquement (jamais attestation,
 * notes ou POST). Paid hors allowlist Free → EXECUTOR_PAID_MODEL avant fetch.
 * Groq : runtime bloqué (facturation non vérifiée). Z.AI glm-4.7-flash :
 * thinking.disabled. xAI : 100 % paid dormant (0 free API public).
 */
import {
  assertGenerateInput, envelope, readWorkersAiOutput,
  type LlmAdapter, type LlmInput,
} from './adapter';
import { clampTimeoutMs, executorError, fetchWithTimeout, readUpstreamJson } from './fetch-timeout';

export const OPENROUTER_PROVIDER = 'openrouter';
export const GROQ_PROVIDER = 'groq';
export const DEEPSEEK_PROVIDER = 'deepseek';
export const ZAI_PROVIDER = 'zai';
export const XAI_PROVIDER = 'xai';

export type OpenAiCompatibleProvider =
  | typeof OPENROUTER_PROVIDER
  | typeof GROQ_PROVIDER
  | typeof DEEPSEEK_PROVIDER
  | typeof ZAI_PROVIDER
  | typeof XAI_PROVIDER;

export const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEEPSEEK_CHAT_COMPLETIONS_URL = 'https://api.deepseek.com/chat/completions';
export const ZAI_CHAT_COMPLETIONS_URL = 'https://api.z.ai/api/paas/v4/chat/completions';
export const XAI_CHAT_COMPLETIONS_URL = 'https://api.x.ai/v1/chat/completions';

const OR_MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/i;
const GENERIC_MODEL_RE = /^[a-z0-9][a-z0-9._/-]{0,127}$/i;

interface ProviderConfig {
  readonly endpoint: string;
  readonly secret: keyof OpenAiCompatibleEnv;
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
  xai: {
    endpoint: XAI_CHAT_COMPLETIONS_URL,
    secret: 'LLM_KEY_XAI',
    denyDataCollection: false,
  },
};

const ZAI_FREE_MODEL = 'glm-4.7-flash';
const MODEL_REQUEST_OPTIONS: Readonly<Record<string, Record<string, unknown>>> = {
  [ZAI_PROVIDER + ':' + ZAI_FREE_MODEL]: { thinking: { type: 'disabled' } },
};

const RUNTIME_BLOCKED_PROVIDERS: ReadonlySet<OpenAiCompatibleProvider> = new Set([
  GROQ_PROVIDER,
]);

const FREE_MODELS: Readonly<Record<OpenAiCompatibleProvider, ReadonlySet<string>>> = {
  openrouter: new Set(),
  groq: new Set(),
  deepseek: new Set(),
  zai: new Set([ZAI_FREE_MODEL]),
  xai: new Set(),
};

const PAID_MODELS: Readonly<Record<OpenAiCompatibleProvider, ReadonlySet<string>>> = {
  openrouter: new Set(),
  groq: new Set(['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'openai/gpt-oss-20b']),
  deepseek: new Set(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner']),
  zai: new Set(['glm-4.7-flashx']),
  xai: new Set([
    'grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4',
    'grok-3', 'grok-3-mini', 'grok-2', 'grok-2-latest',
    'grok-build-0.1',
  ]),
};

export interface OpenAiCompatibleEnv {
  LLM_KEY_OPENROUTER?: string;
  LLM_KEY_GROQ?: string;
  LLM_KEY_DEEPSEEK?: string;
  LLM_KEY_ZAI?: string;
  LLM_KEY_XAI?: string;
}

export interface OpenAiCompatibleOptions {
  fetchImpl?: typeof fetch;
  timeout_ms?: number;
}

export function openAiCompatibleProviderOf(attestationRef: string): OpenAiCompatibleProvider | null {
  const colon = attestationRef.indexOf(':');
  if (colon <= 0) return null;
  const prefix = attestationRef.slice(0, colon);
  if (prefix === OPENROUTER_PROVIDER || prefix === GROQ_PROVIDER
    || prefix === DEEPSEEK_PROVIDER || prefix === ZAI_PROVIDER
    || prefix === XAI_PROVIDER) {
    return prefix;
  }
  return null;
}

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

export function createOpenAiCompatibleAdapter(
  env: OpenAiCompatibleEnv,
  attestationRef: string,
  options: OpenAiCompatibleOptions = {},
): LlmAdapter {
  const parsed = parseOpenAiCompatibleRef(attestationRef);
  const config = PROVIDERS[parsed.provider];
  const secret = providerSecret(env, config.secret);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = clampTimeoutMs(options.timeout_ms);
  const modelKey = parsed.provider + ':' + parsed.model;
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
        ...MODEL_REQUEST_OPTIONS[modelKey],
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
      const raw = await readUpstreamJson(response);
      const { text, usage } = readWorkersAiOutput(raw);
      if (!text.trim()) {
        throw executorError('EXECUTOR_BAD_RESPONSE', 'Réponse du fournisseur avec contenu vide.');
      }
      return { text, usage, provider: parsed.provider, model: parsed.model };
    },
  };
}
