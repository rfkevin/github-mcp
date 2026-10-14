/**
 * R4 / lot A1 — adaptateur Groq (OpenAI-compatible).
 *
 * Module isolé : URL et nom de secret constants serveur.
 * Pas de branchement run.ts / factory ici (lot C + #139).
 * Paid : modèles hors allowlist Free refusés avant tout fetch.
 * Tests : fetch mock uniquement ; aucune requête facturable.
 */
import { StateContractError } from '../../../collab/contracts';
import {
  assertGenerateInput,
  envelope,
  readWorkersAiOutput,
  type LlmAdapter,
  type LlmInput,
} from '../adapter';

export const GROQ_PROVIDER = 'groq';
export const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_SECRET_NAME = 'LLM_KEY_GROQ';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Ids Free documentés (revalider au jour d'activation). Deny-by-default hors liste. */
export const GROQ_FREE_MODELS: ReadonlySet<string> = new Set([
  'openai/gpt-oss-20b',
]);

/** Modèles payants connus — refusés même si secret présent (dormant). */
export const GROQ_PAID_MODELS: ReadonlySet<string> = new Set([
  'llama-3.3-70b-versatile',
  'llama-3.1-70b-versatile',
]);

const MODEL_RE = /^[a-z0-9][a-z0-9._/-]{0,127}$/i;

export interface GroqEnv {
  LLM_KEY_GROQ?: string;
}

export interface GroqOptions {
  fetchImpl?: typeof fetch;
  timeout_ms?: number;
}

function executorError(code: string, message: string): StateContractError {
  return new StateContractError(code, message, 'executor');
}

/** groq:<model_id> — Free allowlist only ; paid → EXECUTOR_PAID_MODEL. */
export function parseGroqRef(attestationRef: string): { provider: typeof GROQ_PROVIDER; model: string } {
  const prefix = GROQ_PROVIDER + ':';
  if (!attestationRef.startsWith(prefix)) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Fournisseur Groq attendu (préfixe groq:).');
  }
  const model = attestationRef.slice(prefix.length);
  if (!MODEL_RE.test(model)) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Référence de modèle Groq invalide.');
  }
  if (GROQ_PAID_MODELS.has(model)) {
    throw executorError('EXECUTOR_PAID_MODEL', 'Modèle Groq payant refusé (0 € / paid dormant).');
  }
  if (!GROQ_FREE_MODELS.has(model)) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Modèle Groq hors allowlist Free vérifiée.');
  }
  return { provider: GROQ_PROVIDER, model };
}

function readSecret(env: GroqEnv): string {
  const value = env.LLM_KEY_GROQ?.trim() ?? '';
  if (!value) {
    throw executorError('EXECUTOR_UNAVAILABLE', 'Secret LLM_KEY_GROQ absent de cet environnement.');
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
          reject(executorError('EXECUTOR_TIMEOUT', 'Groq sans réponse après ' + timeoutMs + ' ms.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Construit un adaptateur Groq. L'URL et le secret_name sont fixés ici ;
 * jamais lus depuis attestation, notes ou POST owner.
 */
export function createGroqAdapter(
  env: GroqEnv,
  attestationRef: string,
  options: GroqOptions = {},
): LlmAdapter {
  const parsed = parseGroqRef(attestationRef);
  const secret = readSecret(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.min(
    Math.max(Math.trunc(options.timeout_ms ?? DEFAULT_TIMEOUT_MS), 1),
    DEFAULT_TIMEOUT_MS,
  );

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
      const response = await fetchWithTimeout(
        fetchImpl,
        GROQ_CHAT_COMPLETIONS_URL,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + secret,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: parsed.model,
            messages: envelope(input.control, input.data),
            max_tokens: input.max_tokens,
          }),
        },
        timeoutMs,
      );

      if (response.status === 429) {
        throw executorError('EXECUTOR_UPSTREAM_HTTP', 'Fournisseur HTTP 429.');
      }
      if (!response.ok) {
        throw executorError('EXECUTOR_UPSTREAM_HTTP', 'Fournisseur HTTP ' + response.status + '.');
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw executorError('EXECUTOR_BAD_RESPONSE', 'Réponse Groq sans JSON exploitable.');
      }
      const { text, usage } = readWorkersAiOutput(raw);
      return { text, usage, provider: parsed.provider, model: parsed.model };
    },
  };
}
