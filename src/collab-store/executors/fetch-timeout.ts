/** Helper HTTP partagé — timeout borné, 0 retry (openai-compatible + gemini). */
import { StateContractError } from '../../collab/contracts';

export function executorError(code: string, message: string): StateContractError {
  return new StateContractError(code, message, 'executor');
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
