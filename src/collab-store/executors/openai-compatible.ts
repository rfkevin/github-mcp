/**
 * CC-4 A3c — adaptateur LLM compatible OpenAI, à fournisseurs explicitement
 * autorisés par le serveur. L'URL et le nom du secret ne viennent jamais d'un
 * endpoint, d'une demande owner ou d'un formulaire.
 */
import { StateContractError } from '../../collab/contracts';
import {
  assertGenerateInput, envelope, readWorkersAiOutput,
  type LlmAdapter, type LlmInput,
} from './adapter';

export const OPENROUTER_PROVIDER = 'openrouter';
export const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_TIMEOUT_MS = 30_000;
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/i;

const PROVIDERS = {
  openrouter: {
    endpoint: OPENROUTER_CHAT_COMPLETIONS_URL,
    secret: 'LLM_KEY_OPENROUTER',
  },
} as const;

export interface OpenAiCompatibleEnv {
  LLM_KEY_OPENROUTER?: string;
}

export interface OpenAiCompatibleOptions {
  fetchImpl?: typeof fetch;
  timeout_ms?: number;
}

function executorError(code: string, message: string): StateContractError {
  return new StateContractError(code, message, 'executor');
}

/** openrouter:<éditeur>/<modèle>:free — tout modèle sans :free est refusé. */
export function parseOpenAiCompatibleRef(attestationRef: string): { provider: typeof OPENROUTER_PROVIDER; model: string } {
  const prefix = OPENROUTER_PROVIDER + ':';
  if (!attestationRef.startsWith(prefix)) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Fournisseur compatible OpenAI non pris en charge.');
  }
  const model = attestationRef.slice(prefix.length);
  if (!model.endsWith(':free')) {
    throw executorError('EXECUTOR_PAID_MODEL', 'Le modèle OpenRouter doit porter le suffixe :free (pilote à 0 €).');
  }
  const baseModel = model.slice(0, -':free'.length);
  if (!MODEL_RE.test(baseModel)) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Référence de modèle OpenRouter invalide.');
  }
  return { provider: OPENROUTER_PROVIDER, model };
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
 * OpenRouter est le premier fournisseur de cette surface universelle. La clé
 * reste dans l'environnement Worker et l'adresse est la constante serveur.
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
      const response = await fetchWithTimeout(fetchImpl, config.endpoint, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + secret,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: parsed.model,
          messages: envelope(input.control, input.data),
          max_tokens: input.max_tokens,
          provider: { data_collection: 'deny' },
        }),
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
