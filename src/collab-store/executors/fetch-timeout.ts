/** Helper HTTP partagé — timeout borné, 0 retry (openai-compatible + gemini). */
import { StateContractError } from '../../collab/contracts';

export function executorError(code: string, message: string): StateContractError {
  return new StateContractError(code, message, 'executor');
}

export function requireSecret(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    throw executorError('EXECUTOR_UNAVAILABLE', 'Secret du fournisseur absent de cet environnement.');
  }
  return trimmed;
}

export function clampTimeoutMs(value: number | undefined, maxMs = 30_000): number {
  return Math.min(Math.max(Math.trunc(value ?? maxMs), 1), maxMs);
}

/**
 * CC-5 L0 (dette X14) : délai par fournisseur au lieu de 30 s fixes. Chaque
 * fournisseur garde un défaut et un plafond ; une valeur explicite reste
 * bornée par le plafond. Fournisseur inconnu : 30 s (comportement historique).
 */
export const PROVIDER_TIMEOUT_MS: Readonly<Record<string, { default_ms: number; max_ms: number }>> = {
  groq: { default_ms: 30_000, max_ms: 60_000 },
  gemini: { default_ms: 60_000, max_ms: 120_000 },
  zai: { default_ms: 90_000, max_ms: 120_000 },
  openrouter: { default_ms: 60_000, max_ms: 120_000 },
  deepseek: { default_ms: 60_000, max_ms: 120_000 },
  xai: { default_ms: 60_000, max_ms: 120_000 },
  anthropic: { default_ms: 60_000, max_ms: 120_000 },
  'workers-ai': { default_ms: 60_000, max_ms: 120_000 },
};

/** Délai effectif d'un appel fournisseur : défaut par fournisseur, valeur explicite clampée au plafond. */
export function providerTimeoutMs(provider: string, value?: number): number {
  const policy = PROVIDER_TIMEOUT_MS[provider] ?? { default_ms: 30_000, max_ms: 30_000 };
  return Math.min(Math.max(Math.trunc(value ?? policy.default_ms), 1), policy.max_ms);
}

export async function fetchWithTimeout(
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

/** Après fetch : HTTP non-2xx → UPSTREAM_HTTP ; JSON invalide → BAD_RESPONSE. */
export async function readUpstreamJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw executorError('EXECUTOR_UPSTREAM_HTTP', 'Fournisseur HTTP ' + response.status + '.');
  }
  try {
    return await response.json();
  } catch {
    throw executorError('EXECUTOR_BAD_RESPONSE', 'Réponse du fournisseur sans JSON exploitable.');
  }
}
