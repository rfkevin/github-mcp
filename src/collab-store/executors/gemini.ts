/**
 * R4 lot A — adaptateur Google Gemini API (generateContent, non OpenAI-chat).
 * URL + nom de secret = constantes serveur.
 * Free allowlist : gemini-3.5-flash-lite (GA 21/07/2026, Standard Free).
 * gemini-2.5-flash-lite : hors allowlist (accès 2.5 restreint nouveaux projets).
 *
 * Runtime deny-by-default : sans freeProjectAttested, 0 fetch même si
 * LLM_KEY_GEMINI est présent. L'attestation Free n'est **pas** déduite de la
 * clé ni du registre : uniquement option explicite (tests) ou **double**
 * condition serveur Owner :
 *   GEMINI_FREE_PROJECT_ATTESTED=true
 *   ET PUBLIC_ORIGIN = origin CC3-test exacte.
 * Prod / preview / autre origin → fail-closed même si la var d'attestation est true.
 *
 * Thinking Gemini 3.x : thinkingLevel (pas thinkingBudget 2.5). Désactivation
 * complète non supportée sur Flash/Flash-Lite → niveau `minimal` (défaut doc).
 */
import {
  assertGenerateInput, attachUsage, envelope, zeroCostAdapter,
  type LlmAdapter, type LlmInput,
} from './adapter';
import { executorError, fetchWithTimeout, providerTimeoutMs, readUpstreamJson, requireSecret } from './fetch-timeout';

export const GEMINI_PROVIDER = 'gemini';
/** Cible Free principale CC3-4 (stable, Standard Free). */
export const GEMINI_FREE_MODEL = 'gemini-3.5-flash-lite';
/** Ancien Free 2.5 — non utilisable pour les nouveaux projets (restreint 18/09/2026). */
export const GEMINI_LEGACY_25_FLASH_LITE = 'gemini-2.5-flash-lite';
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/** Env serveur Owner : seule valeur acceptée = 'true' (casse exacte). */
export const GEMINI_FREE_ATTEST_ENV = 'GEMINI_FREE_PROJECT_ATTESTED';
/**
 * Origin de déploiement CC3-test (wrangler env.cc3-test). Constante serveur,
 * jamais lue depuis l'en-tête HTTP Origin de la requête.
 */
export const GEMINI_CC3_TEST_PUBLIC_ORIGIN = 'https://github-mcp-cc3-test.rfahedkevin.workers.dev';

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * CC-7 G0 (décision de Kevin du 2026-10-31) : Gemini 3.8 Flash, gratuit au palier gratuit de l'API
 * Gemini (registre de la veille du 2026-10-28), accepté par l'adaptateur consultatif. 3.5 Flash-Lite
 * reste autorisé (repli et endpoints existants).
 */
export const GEMINI_38_FLASH = 'gemini-3.8-flash';
const FREE_MODELS: ReadonlySet<string> = new Set([GEMINI_FREE_MODEL, GEMINI_38_FLASH]);

/**
 * CC-7 G0 — modèles qui refusent thinkingLevel « minimal » (erreur, pas de conversion côté Google) :
 * documentation « What's new in Gemini 3.8 Flash », lue le 2026-10-31 (niveaux low | medium | high,
 * défaut medium) ; gemini-4-argon relevé par la veille du 2026-10-29. Les autres Gemini 3.x gardent
 * minimal comme niveau le plus léger.
 */
export const GEMINI_NO_MINIMAL_MODELS: ReadonlySet<string> = new Set([GEMINI_38_FLASH, 'gemini-4-argon']);

/** Effort serveur (faible, moyen, élevé, très élevé) → thinkingLevel Gemini 3.x. */
export type GeminiEffort = 'low' | 'medium' | 'high' | 'xhigh';

/**
 * thinkingLevel envoyé pour ce modèle et cet effort. Règle historique (L9b) conservée : un cran
 * plus léger que l'effort demandé (faible → minimal, moyen → low, élevé → medium, très élevé → high).
 * Pour un modèle sans « minimal », le plancher devient « low » : jamais de niveau refusé.
 */
export function geminiThinkingLevel(model: string, effort: GeminiEffort): 'minimal' | 'low' | 'medium' | 'high' {
  const level = effort === 'xhigh' ? 'high' : effort === 'high' ? 'medium' : effort === 'medium' ? 'low' : 'minimal';
  return level === 'minimal' && GEMINI_NO_MINIMAL_MODELS.has(model) ? 'low' : level;
}
const PAID_MODELS: ReadonlySet<string> = new Set([
  'gemini-2.5-pro', 'gemini-2.5-flash',
  'gemini-1.5-pro', 'gemini-1.5-flash',
  'gemini-3.5-flash', 'gemini-3.5-pro',
]);

export interface GeminiEnv {
  LLM_KEY_GEMINI?: string;
  /**
   * Attestation projet Google Free, **server-only**. Owner pose/retire la var
   * sur le Worker CC3-test. Jamais lue depuis client, notes endpoint ou registre.
   * Seule la chaîne exacte `true` compte ; insuffisante seule (voir PUBLIC_ORIGIN).
   */
  GEMINI_FREE_PROJECT_ATTESTED?: string;
  /**
   * Origin de déploiement serveur (wrangler vars). Doit égaler
   * GEMINI_CC3_TEST_PUBLIC_ORIGIN pour débloquer. Jamais l'Origin HTTP client.
   */
  PUBLIC_ORIGIN?: string;
}

export interface GeminiOptions {
  fetchImpl?: typeof fetch;
  timeout_ms?: number;
  /**
   * Preuve Owner uniquement (jamais depuis le client / registre) : projet Google
   * Free non facturable vérifié. Absent → EXECUTOR_UNAVAILABLE, 0 fetch.
   * Runtime : dérivé uniquement de geminiFreeAttestedFromEnv (var + origin TEST).
   */
  freeProjectAttested?: boolean;
}

/**
 * true ssi double condition serveur :
 * 1) GEMINI_FREE_PROJECT_ATTESTED === 'true'
 * 2) PUBLIC_ORIGIN === GEMINI_CC3_TEST_PUBLIC_ORIGIN
 * Fail-closed sinon (prod, preview, origin absente, valeur non exacte).
 */
export function geminiFreeAttestedFromEnv(env: GeminiEnv): boolean {
  return env.GEMINI_FREE_PROJECT_ATTESTED === 'true'
    && env.PUBLIC_ORIGIN === GEMINI_CC3_TEST_PUBLIC_ORIGIN;
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
    throw executorError(
      'EXECUTOR_UNSUPPORTED',
      'Modèle Gemini hors allowlist Free vérifiée : ' + model
        + (model === GEMINI_LEGACY_25_FLASH_LITE
          ? ' (2.5 restreint nouveaux projets ; cible Free = ' + GEMINI_FREE_MODEL + ').'
          : '.'),
    );
  }
  return { provider: GEMINI_PROVIDER, model };
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
  const usage = (value.usageMetadata ?? {}) as Record<string, unknown>;
  const input = typeof usage.promptTokenCount === 'number' && Number.isSafeInteger(usage.promptTokenCount) && usage.promptTokenCount >= 0
    ? usage.promptTokenCount : 0;
  const output = typeof usage.candidatesTokenCount === 'number' && Number.isSafeInteger(usage.candidatesTokenCount) && usage.candidatesTokenCount >= 0
    ? usage.candidatesTokenCount : 0;
  // CC-5 L0 (dette X14) : usage calculé avant la garde — l'erreur le porte.
  if (!text.trim()) {
    throw attachUsage(executorError('EXECUTOR_BAD_RESPONSE', 'Réponse Gemini sans texte exploitable.'),
      { input_tokens: input, output_tokens: output });
  }
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
  const secret = requireSecret(env.LLM_KEY_GEMINI);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = providerTimeoutMs(GEMINI_PROVIDER, options.timeout_ms);
  const url = GEMINI_API_BASE + '/' + encodeURIComponent(parsed.model) + ':generateContent';
  return zeroCostAdapter(parsed.provider, parsed.model, async (input: LlmInput) => {
    assertGenerateInput(input);
    const messages = envelope(input.control, input.data);
    const system = messages.find(m => m.role === 'system')?.content ?? input.control;
    const user = messages.find(m => m.role === 'user')?.content ?? input.data;
    // Gemini 3.x : thinkingLevel (doc 14/10/2026). OFF total non supporté sur
    // Flash-Lite → minimal. thinkingBudget (2.5) n'est pas le contrat 3.x.
    // CC-7 G0 : niveau le plus léger accepté PAR CE MODÈLE (low pour 3.8 Flash, qui refuse minimal).
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: input.max_tokens,
        thinkingConfig: { thinkingLevel: geminiThinkingLevel(parsed.model, 'low') },
      },
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
  });
}
