import { GitHubApiError, GitHubConflictError, GitHubRateLimitError } from '../../../github/client';
import { PolicyViolationError } from '../../../security/policy';
import type { ToolContext } from '../../context';
import { InputValidationError } from '../../../github/types';
import { StateContractError } from '../../../collab/contracts';

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

/** Motif journalisé : classe fermée, jamais le message d'erreur d'origine. */
export function failureReason(error: unknown): string {
  if (error instanceof GitHubRateLimitError) return 'rate_limited';
  if (error instanceof GitHubApiError) {
    return error.status === 0 ? 'github_api_unreachable' : `github_api_${error.status}`;
  }
  if (error instanceof PolicyViolationError) return `policy_${error.code.toLowerCase()}`;
  if (error instanceof GitHubConflictError) return 'conflict';
  if (error instanceof StateContractError) return 'state_contract';
  if (error instanceof InputValidationError) {
    return 'invalid_request';
  }
  return 'unexpected_error';
}

/**
 * Message public : les messages que ce projet écrit lui-même sont utiles
 * (validation, politique, contrat d'état), mais ceux d'une réponse GitHub ou
 * d'un échec `fetch` ne sont jamais recopiés : ils peuvent contenir une URL ou
 * un corps de réponse.
 */
export function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof GitHubRateLimitError) return 'Limite de requêtes GitHub atteinte. Réessayez plus tard.';
  if (error instanceof GitHubApiError) {
    if (error.status === 0) return 'GitHub est injoignable. Réessayez plus tard.';
    if (error.status === 422 && error.endpoint.includes('/access_tokens')) {
      return 'GitHub refuse les permissions demandées. Vérifiez les droits de la GitHub App et acceptez leur mise à jour dans son installation.';
    }
    if (error.status === 403) return 'Accès GitHub refusé. Vérifiez les permissions de l’installation pour cet outil.';
    if (error.status === 404) return 'Ressource introuvable ou inaccessible à cette installation GitHub.';
    if (error.status === 401) return 'Authentification GitHub App refusée. Vérifiez la clé et l’installation.';
    if (error.status >= 300 && error.status < 400) return 'GitHub a redirigé cette requête. Redirection refusée pour protéger le jeton.';
    return fallback;
  }

  // Seuls les messages explicitement typés par ce projet sont affichés.
  // Un Error générique n'est jamais présumé sûr. Les erreurs GitHub,
  // les erreurs de parse et les conflits qui enrobent une réponse d'origine ne
  // sont jamais recopiés — le texte de repli du point d'entrée prend le relais.
  if (
    error instanceof Error &&
    (error instanceof InputValidationError || error instanceof PolicyViolationError || error instanceof StateContractError)
  ) {
    return error.message;
  }

  return fallback;
}

export type PublicFailure = { code: string; message: string; retryable: boolean };

export function publicFailure(error: unknown, fallback = 'Opération impossible.'): PublicFailure {
  let code = failureReason(error).toUpperCase();
  if (error instanceof InputValidationError || error instanceof PolicyViolationError || error instanceof StateContractError) code = error.code;
  if (error instanceof GitHubApiError && error.status === 422 && error.endpoint.includes('/access_tokens')) {
    code = 'APP_PERMISSIONS_REJECTED';
  }
  return {
    code,
    message: failureMessage(error, fallback),
    retryable: error instanceof GitHubApiError && (error.status === 0 || error.status === 429 || error.status >= 500),
  };
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
  // Certains clients n'affichent que le texte d'une erreur d'outil : quand le message est le
  // repli générique, le code fermé (ex. GITHUB_API_422, UNEXPECTED_ERROR) y figure aussi.
  const text = failure.message === fallback ? `${fallback} Code : ${failure.code}.` : failure.message;
  return { isError: true, content: [{ type: 'text', text }], structuredContent: { error: failure } };
}