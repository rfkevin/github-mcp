/**
 * CC-3 C2 — helpers de résultat locaux (jamais importés depuis src/mcp/**).
 * Leçon F2-BUG-01 : une erreur connue garde son propre code typé ;
 * UNEXPECTED_ERROR est réservé aux échecs réellement inattendus.
 */
import { StateContractError } from '../../collab/contracts';
import { CollabStoreError } from '../store/collab-store';

export type ToolPayload = { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> };
export type ToolErrorResult = { isError: true; content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> };

export function collabSuccess(value: Record<string, unknown>): ToolPayload {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

/**
 * Tous les échecs du store sont déterministes (même entrée, même résultat) :
 * retryable reste false, sauf information contraire explicite.
 */
export function collabFailure(
  error: unknown,
  fallback: string,
  extra: Record<string, unknown> = {},
): ToolErrorResult {
  const known = error instanceof StateContractError || error instanceof CollabStoreError;
  if (!known) {
    // Diagnostic serveur : l'erreur inconnue est consignée mais jamais exposée au client.
    console.warn(JSON.stringify({ service: 'collab-store', outcome: 'unexpected_error',
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error) }));
  }
  const code = known ? (error as { code: string }).code : 'UNEXPECTED_ERROR';
  const message = known && error instanceof Error ? error.message : fallback;
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: { error: { code, message, retryable: false }, ...extra },
  };
}
