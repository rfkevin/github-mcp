/**
 * CC-3 C2 — helpers de résultat locaux (jamais importés depuis src/mcp/**).
 * Leçon F2-BUG-01 : une erreur connue garde son propre code typé ;
 * une erreur non typée devient STORE_UNAVAILABLE avec son repli (C6, R4).
 */
import { StateContractError } from '../../collab/contracts';
import { CollabStoreError } from '../store/collab-store';
import { MemoryStoreError } from '../memory/memory-store';
import { storeFallback, type StoreFallback } from '../export/fallback';

export type ToolPayload = { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> };
export type ToolErrorResult = { isError: true; content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> };

export function collabSuccess(value: Record<string, unknown>): ToolPayload {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

/**
 * Les échecs typés du store sont déterministes (même entrée, même résultat) :
 * retryable reste false. Toute autre erreur vient du stockage (D1 indisponible,
 * binding absent) ou d'un défaut imprévu : CC-3 C6 la rend explicite —
 * STORE_UNAVAILABLE, retryable, avec le repli en lecture seule (R4) et jamais
 * une écriture GitHub de substitution.
 */
export function collabFailure(
  error: unknown,
  fallback: string,
  extra: Record<string, unknown> = {},
  storeDown: StoreFallback = storeFallback(null),
): ToolErrorResult {
  // CR-B (CR-02) : les erreurs typées du lifecycle mémoire (C4) gardent leur
  // code propre ; sans cela elles deviendraient STORE_UNAVAILABLE retryable.
  const known =
    error instanceof StateContractError || error instanceof CollabStoreError || error instanceof MemoryStoreError;
  if (!known) {
    // Diagnostic serveur : l'erreur inconnue est consignée mais jamais exposée au client.
    console.warn(JSON.stringify({ service: 'collab-store', outcome: 'store_unavailable',
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error) }));
    const message = fallback + ' Store indisponible : ' + storeDown.instruction;
    return {
      isError: true,
      content: [{ type: 'text', text: message }],
      structuredContent: { error: { code: 'STORE_UNAVAILABLE', message, retryable: true }, fallback: storeDown, ...extra },
    };
  }
  const code = (error as { code: string }).code;
  const message = error instanceof Error ? error.message : fallback;
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: { error: { code, message, retryable: false }, ...extra },
  };
}
