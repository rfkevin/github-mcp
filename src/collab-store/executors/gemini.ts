/**
 * R4 lot A — adaptateur Google Gemini API (generateContent, non OpenAI-chat).
 * URL + nom de secret = constantes serveur. Free allowlist : gemini-2.5-flash-lite.
 * Runtime deny-by-default : sans freeProjectAttested (Owner), 0 fetch même si
 * LLM_KEY_GEMINI est présent (même modèle peut être facturé Free vs Paid Google).
 */
import {
  assertGenerateInput, envelope,
  type LlmAdapter, type LlmInput,
} from './adapter';
import { clampTimeoutMs, executorError, fetchWithTimeout, readUpstreamJson } from './fetch-timeout';

export const GEMINI_PROVIDER = 'gemini';
export const GEMINI_FREE_MODEL = 'gemini-2.5-flash-lite';
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const FREE_MODELS: ReadonlySet<string> = new Set([GEMINI_FREE_MODEL]);
const PAID_MODELS: ReadonlySet<string> = new Set([
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash',
]);

export interface GeminiEnv {
  LLM_KEY_GEMINI?: string;
}

export interface GeminiOptions {
  fetchImpl?: typeof fetch;
  timeout_ms?: number;
  /**
   * Preuve Owner uniquement (jamais depuis le client / registre) : projet Google
   * Free non facturable vérifié. Absent → EXECUTOR_UNAVAILABLE, 0 fetch.
   */
  freeProjectAttested?: boolean;
}

export function geminiProviderOf(attestationRef: string): typeof GEMINI_PROVIDER | null {
  const colon = attestationRef.indexOf(':');
  if (colon <= 0) return null;
  return attestationRef.slice(0, colon) === GEMINI_PROVIDER ? GEMINI_PROVIDER : null;
}

export function parseGeminiRef(attestationRef: string): { provider: typeof GEMINI_PROVIDER; model: string } {
  if (!geminiProviderOf(attestationRef)) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Fournisseur Gemini non pris en charge.');
  }
  const model = attestationRef.slice(GEMINI_PROVIDER.length + 1);
  if (!model || !MODEL_RE.test(model)) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Référence de modèle Gemini invalide.');
  }
  if (PAID_MODELS.has(model)) {
    throw executorError('EXECUTOR_PAID_MODEL', 'Modèle Gemini payant refusé (0 € / paid dormant) : ' + model + '.');
  }
  if (!FREE_MODELS.has(model)) {
    throw executorError('EXECUTOR_UNSUPPORTED', 'Modèle Gemini hors allowlist Free vérifiée : ' + model + '.');
  }
  return { provider: GEMINI_PROVIDER, model };
}

function readGeminiSecret(env: GeminiEnv): string {
  const value = env.LLM_KEY_GEMINI?.trim() ?? '';
  if (!value) {
    throw executorError('EXECUTOR_UNAVAILABLE', 'Secret du fournisseur absent de cet environnement.');
  }
  return value;
}

function readGeminiText(raw: unknown): { text: string; input_tokens: number; output_tokens: number } {
  const value = (raw ?? {}) as Record<string, unknown>;
  const candidates = value.candidates as Array<{ content?: { parts?: Array<{ text?: unknown }> } }> | undefined;
  const parts = Array.isArray(candidates) ? candidates[0]?.content?.parts : undefined;
  let text = '';
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (typeof part?.text === 'string') text += part.text;
    }
  }
  if (!text.trim()) {
    throw executorError('EXECUTOR_BAD_RESPONSE', 'Réponse Gemini sans texte exploitable.');
  }
  const usage = (value.usageMetadata ?? {}) as Record<string, unknown>;
  const input = typeof usage.promptTokenCount === 'number' && Number.isSafeInteger(usage.promptTokenCount) && usage.promptTokenCount >= 0
    ? usage.promptTokenCount : 0;
  const output = typeof usage.candidatesTokenCount === 'number' && Number.isSafeInteger(usage.candidatesTokenCount) && usage.candidatesTokenCount >= 0
    ? usage.candidatesTokenCount : 0;
  return { text, input_tokens: input, output_tokens: output };
}

export function createGeminiAdapter(
  env: GeminiEnv,
  attestationRef: string,
  options: GeminiOptions = {},
): LlmAdapter {
  const parsed = parseGeminiRef(attestationRef);
  if (!options.freeProjectAttested) {
    throw executorError(
      'EXECUTOR_UNAVAILABLE',
      'Runtime gemini bloqué : projet Free non facturable non attesté par Owner (0 fetch).',
    );
  }
  const secret = readGeminiSecret(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = clampTimeoutMs(options.timeout_ms);
  const url = GEMINI_API_BASE + '/' + encodeURIComponent(parsed.model) + ':generateContent';
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
      const messages = envelope(input.control, input.data);
      const system = messages.find(m => m.role === 'system')?.content ?? input.control;
      const user = messages.find(m => m.role === 'user')?.content ?? input.data;
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: input.max_tokens },
      };
      const response = await fetchWithTimeout(fetchImpl, url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': secret,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }, timeoutMs);
      const raw = await readUpstreamJson(response);
      const { text, input_tokens, output_tokens } = readGeminiText(raw);
      return {
        text,
        usage: { input_tokens, output_tokens },
        provider: parsed.provider,
        model: parsed.model,
      };
    },
  };
}
