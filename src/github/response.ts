import { InputValidationError } from './types';

/** Borne appliquée pendant la lecture, y compris sans Content-Length. */
export async function readText(response: Response, maxBytes = 8_000_000): Promise<string> {
  if (Number(response.headers.get('Content-Length')) > maxBytes) {
    await response.body?.cancel();
    throw new InputValidationError('Réponse GitHub trop volumineuse. Réduisez la demande.', 'RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty JSON response');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new InputValidationError('Réponse GitHub trop volumineuse. Réduisez la demande.', 'RESPONSE_TOO_LARGE');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally { reader.releaseLock(); }
}

export async function readJson<T>(response: Response, maxBytes = 8_000_000): Promise<T> {
  return JSON.parse(await readText(response, maxBytes)) as T;
}
