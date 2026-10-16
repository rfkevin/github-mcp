/** Helper HTTP partagé — timeout borné, 0 retry (openai-compatible + gemini). */
import { StateContractError } from '../../collab/contracts';

export function executorError(code: string, message: string): StateContractError {
  return new StateContractError(code, message, 'executor');
}

export function clampTimeoutMs(value: number | undefined, maxMs = 30_000): number {
  return Math.min(Math.max(Math.trunc(value ?? maxMs), 1), maxMs);
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
