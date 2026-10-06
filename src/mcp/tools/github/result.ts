import type { ToolContext } from '../../context';
import { InputValidationError } from '../../../github/types';
import { failureReason, publicFailure, type PublicFailure } from '../../../errors/public-failure';

// Chemin public historique conservé pour les outils et les tests existants.
export { failureMessage, failureReason, publicFailure, type PublicFailure } from '../../../errors/public-failure';

/** Taille maximale d'un contenu renvoyé à un client MCP, par document. */
export const MAX_TEXT_BYTES = 80_000;

export type ToolPayload = { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> };
export type ToolErrorResult = { isError: true; content: Array<{ type: 'text'; text: string }>; structuredContent: { error: PublicFailure } };

export function textPayload(value: Record<string, unknown>): ToolPayload {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > 160_000) {
    throw new InputValidationError('Résultat trop volumineux. Réduisez la plage ou le nombre de fichiers.', 'RESULT_TOO_LARGE');
  }
  return { content: [{ type: 'text', text }], structuredContent: value };
}

/** Tronque sur une frontière d'octets : le dernier caractère peut être remplacé, jamais rejeté. */
export function printable(content: string, maxBytes = MAX_TEXT_BYTES): { content: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(content);

  if (bytes.byteLength <= maxBytes) {
    return { content, truncated: false };
  }

  return { content: new TextDecoder().decode(bytes.slice(0, maxBytes)), truncated: true };
}

export function toolSuccess(context: ToolContext, action: string): void {
  console.log(JSON.stringify({ actor: context.actor, service: 'github', action, outcome: 'success' }));
}

export function toolFailure(context: ToolContext, action: string, fallback: string, error: unknown): ToolErrorResult {
  console.log(JSON.stringify({
    actor: context.actor,
    service: 'github',
    action,
    outcome: 'error',
    reason: failureReason(error),
  }));

  const failure = publicFailure(error, fallback);
  return { isError: true, content: [{ type: 'text', text: failure.message }], structuredContent: { error: failure } };
}
