import { GitHubApiError, GitHubConflictError, GitHubRateLimitError } from '../../../github/client';
import { PolicyViolationError } from '../../../security/policy';
import type { ToolContext } from '../../context';

const MAX_MESSAGE_LENGTH = 200;

/** Taille maximale d'un contenu renvoyé à un client MCP, par document. */
export const MAX_TEXT_BYTES = 80_000;

export type ToolPayload = { content: Array<{ type: 'text'; text: string }> };
export type ToolErrorResult = { isError: true; content: Array<{ type: 'text'; text: string }> };

export function textPayload(value: unknown): ToolPayload {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
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

/** Motif journalisé : classe fermée, jamais le message d'erreur d'origine. */
export function failureReason(error: unknown): string {
  if (error instanceof GitHubRateLimitError) return 'rate_limited';
  if (error instanceof GitHubApiError) {
    return error.status === 0 ? 'github_api_unreachable' : `github_api_${error.status}`;
  }
  if (error instanceof PolicyViolationError) return `policy_${error.code.toLowerCase()}`;
  if (error instanceof GitHubConflictError) return 'conflict';
  // Réfutations de validation et de type écrites par ce projet (chemin refusé, requête invalide…).
  if (error instanceof TypeError || (error instanceof Error && error.name === 'Error')) {
    return 'invalid_request';
  }
  return 'unexpected_error';
}

/**
 * Message public : les messages que ce projet écrit lui-même sont utiles
 * (validation, politique), mais ceux d'une réponse GitHub ou d'un échec `fetch`
 * ne sont jamais recopiés : ils peuvent contenir une URL ou un corps de réponse.
 */
export function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof GitHubRateLimitError) return 'Limite de requêtes GitHub atteinte. Réessayez plus tard.';
  if (error instanceof GitHubApiError) {
    return error.status === 0 ? 'GitHub est injoignable. Réessayez plus tard.' : fallback;
  }

  // Seuls les messages que ce projet écrit lui-même sont affichés : un `Error`
  // nu (validation, politique) ou une violation de politique. Les erreurs GitHub,
  // les erreurs de parse et les conflits qui enrobent une réponse d'origine ne
  // sont jamais recopiés — le texte de repli du point d'entrée prend le relais.
  if (
    error instanceof Error &&
    (error.name === 'Error' || error instanceof PolicyViolationError) &&
    !(error instanceof TypeError) &&
    error.message.length <= MAX_MESSAGE_LENGTH
  ) {
    return error.message;
  }

  return fallback;
}

export function toolFailure(context: ToolContext, action: string, fallback: string, error: unknown): ToolErrorResult {
  console.log(JSON.stringify({
    actor: context.actor,
    service: 'github',
    action,
    outcome: 'error',
    reason: failureReason(error),
  }));

  return { isError: true, content: [{ type: 'text', text: failureMessage(error, fallback) }] };
}
