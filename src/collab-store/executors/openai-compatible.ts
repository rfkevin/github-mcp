/**
 * CC-4 A3c / R4 lot A — adaptateur LLM compatible OpenAI multi-fournisseurs.
 * URL et nom de secret = constantes serveur uniquement (jamais attestation,
 * notes ou POST). Paid hors allowlist Free → EXECUTOR_PAID_MODEL avant fetch.
 * Groq Free : double condition Owner (GROQ_FREE_PROJECT_ATTESTED=true +
 * PUBLIC_ORIGIN CC3-test) imposée dans le constructeur ; sinon 0 fetch.
 * Z.AI glm-4.7-flash : thinking.disabled. xAI : 100 % paid dormant.
 * CC-5 L1 : Groq gpt-oss-20b reasoning_effort=low (suite diagnostic X4).
 */
import {
  assertGenerateInput, envelope, readWorkersAiOutput, zeroCostAdapter,
  type LlmAdapter, type LlmInput,
} from './adapter';
import { executorError, fetchWithTimeout, providerTimeoutMs, readUpstreamJson, requireSecret } from './fetch-timeout';

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

/** Env serveur Owner : seule valeur acceptée = 'true' (casse exacte). */
export const GROQ_FREE_ATTEST_ENV = 'GROQ_FREE_PROJECT_ATTESTED';
/**
 * Origin de déploiement CC3-test (wrangler env.cc3-test). Constante serveur,
 * jamais lue depuis l'en-tête HTTP Origin de la requête.
 */
export const GROQ_CC3_TEST_PUBLIC_ORIGIN = 'https://github-mcp-cc3-test.rfahedkevin.workers.dev';
/** Cible Free principale CC3-4 (participant groq-gptoss20b ; free rate table). */
export const GROQ_FREE_MODEL = 'openai/gpt-oss-20b';

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
  // CC-5 L1 (X4 suite) : gpt-oss-20b raisonne par défaut (medium) et peut
  // épuiser max_tokens sur un brief lourd → content vide. effort low réduit
  // le risque sans changer le contrat free (0 €).
  [GROQ_PROVIDER + ':' + GROQ_FREE_MODEL]: { reasoning_effort: 'low' },
};

const FREE_MODELS: Readonly<Record<OpenAiCompatibleProvider, ReadonlySet<string>>> = {
  openrouter: new Set(),
  groq: new Set([GROQ_FREE_MODEL]),
  deepseek: new Set(),
  zai: new Set([ZAI_FREE_MODEL]),
  xai: new Set(),
};

const PAID_MODELS: Readonly<Record<OpenAiCompatibleProvider, ReadonlySet<string>>> = {
  openrouter: new Set(),
  groq: new Set([
    'llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'llama-3.1-8b-instant',
    'openai/gpt-oss-120b', 'openai/gpt-oss-safeguard-20b',
  ]),
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
  /**
   * Attestation compte Groq Free non facturable, **server-only**. Owner pose
   * la var sur Worker CC3-test uniquement. Jamais client / registre / notes.
   * Seule la chaîne exacte `true` compte ; insuffisante seule (voir PUBLIC_ORIGIN).
   */
  GROQ_FREE_PROJECT_ATTESTED?: string;
  /**
   * Origin de déploiement serveur (wrangler vars). Doit égaler
   * GROQ_CC3_TEST_PUBLIC_ORIGIN pour débloquer Groq Free.
   */
  PUBLIC_ORIGIN?: string;
}

export interface OpenAiCompatibleOptions {
  fetchImpl?: typeof fetch;
  timeout_ms?: number;
  /**
   * Uniquement pour parse/tests. Le constructeur **ignore** cette option et
   * dérive l'autorisation uniquement de `groqFreeAttestedFromEnv(env)` :
   * `options.freeProjectAttested=true` ne peut jamais élargir l'accès.
   */
  freeProjectAttested?: boolean;
}

/**
 * true ssi double condition serveur :
 * 1) GROQ_FREE_PROJECT_ATTESTED === 'true'
 * 2) PUBLIC_ORIGIN === GROQ_CC3_TEST_PUBLIC_ORIGIN
 * Fail-closed sinon (prod, preview, origin absente, valeur non exacte).
 */
export function groqFreeAttestedFromEnv(env: OpenAiCompatibleEnv): boolean {
  return env.GROQ_FREE_PROJECT_ATTESTED === 'true'
    && env.PUBLIC_ORIGIN === GROQ_CC3_TEST_PUBLIC_ORIGIN;
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
  options: Pick<OpenAiCompatibleOptions, 'freeProjectAttested'> = {},
): { provider: OpenAiCompatibleProvider; model: string } {
  const provider = openAiCompatibleProviderOf(attestationRef);
  if (!provider) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Fournisseur compatible OpenAI non pris en charge.');
  }
  const model = attestationRef.slice(provider.length + 1);
  if (!model) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Référence de modèle vide.');
  }

  if (provider === GROQ_PROVIDER && !options.freeProjectAttested) {
    throw executorError(
      'EXECUTOR_UNAVAILABLE',
      'Runtime groq bloqué : compte Free non facturable non attesté par Owner (0 fetch).',
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

/**
 * Constructeur exporté : pour Groq, l'attestation vient **uniquement** de env
 * (`groqFreeAttestedFromEnv`). `options.freeProjectAttested` ne peut jamais
 * élargir l'accès (fail-closed même si un appelant malveillant le force à true).
 */
export function createOpenAiCompatibleAdapter(
  env: OpenAiCompatibleEnv,
  attestationRef: string,
  options: OpenAiCompatibleOptions = {},
): LlmAdapter {
  const freeProjectAttested = groqFreeAttestedFromEnv(env);
  const parsed = parseOpenAiCompatibleRef(attestationRef, { freeProjectAttested });
  const config = PROVIDERS[parsed.provider];
  const secret = requireSecret(env[config.secret]);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = providerTimeoutMs(parsed.provider, options.timeout_ms);
  const modelKey = parsed.provider + ':' + parsed.model;
  return zeroCostAdapter(parsed.provider, parsed.model, async (input: LlmInput) => {
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
    // CC-5 L0 : la garde « contenu vide » vit dans readWorkersAiOutput (même
    // code, même message), où l'usage est déjà calculé et attaché à l'erreur.
    const { text, usage } = readWorkersAiOutput(raw);
    return { text, usage, provider: parsed.provider, model: parsed.model };
  });
}
