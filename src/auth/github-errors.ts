export type GitHubIdentityFailureReason =
  | 'github_token_network_error'
  | 'github_token_http_error'
  | 'github_token_redirect_rejected'
  | 'github_token_response_invalid'
  | 'github_token_rejected'
  | 'github_token_bad_verification_code'
  | 'github_token_incorrect_client_credentials'
  | 'github_token_redirect_uri_mismatch'
  | 'github_user_network_error'
  | 'github_user_redirect_rejected'
  | 'github_user_http_error'
  | 'github_user_response_invalid'
  | 'github_user_id_invalid';

export type GitHubFetchFailureKind =
  | 'timeout'
  | 'aborted'
  | 'redirect_rejected'
  | 'fetch_type_error'
  | 'other';

export type GitHubFetchFailure = {
  kind: GitHubFetchFailureKind;
  code?: string;
  redirectTarget?:
    | 'github_token_endpoint'
    | 'github_other_path'
    | 'github_api_user_endpoint'
    | 'github_api_other_path'
    | 'external_origin'
    | 'unavailable';
};

const SAFE_FETCH_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_CERT_VERIFY_FAILED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export class GitHubIdentityError extends Error {
  constructor(
    public readonly reason: GitHubIdentityFailureReason,
    public readonly httpStatus?: number,
    public readonly fetchFailure?: GitHubFetchFailure,
  ) {
    super(reason);
    this.name = 'GitHubIdentityError';
  }
}

export function classifyFetchFailure(error: unknown): GitHubFetchFailure {
  const causes: unknown[] = [error];
  if (error instanceof Error && error.cause !== undefined) causes.push(error.cause);

  for (const cause of causes) {
    if (cause instanceof DOMException && cause.name === 'TimeoutError') {
      return { kind: 'timeout' };
    }
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      return { kind: 'aborted' };
    }

    if (cause instanceof Error) {
      if (cause.name === 'TimeoutError') return { kind: 'timeout' };
      if (cause.name === 'AbortError') return { kind: 'aborted' };

      if (/redirect/i.test(cause.message)) {
        return { kind: 'redirect_rejected' };
      }
    }

    if (typeof cause === 'object' && cause !== null && 'code' in cause) {
      const code = cause.code;
      if (typeof code === 'string' && SAFE_FETCH_ERROR_CODES.has(code)) {
        return { kind: 'other', code };
      }
    }
  }

  if (causes.some(cause => cause instanceof TypeError)) {
    return { kind: 'fetch_type_error' };
  }

  return { kind: 'other' };
}

export function classifyRedirectTarget(location: string | null): GitHubFetchFailure['redirectTarget'] {
  if (!location) return 'unavailable';

  let target: URL;
  try {
    target = new URL(location, 'https://github.com/login/oauth/access_token');
  } catch {
    return 'unavailable';
  }

  if (target.origin !== 'https://github.com') return 'external_origin';
  return target.pathname === '/login/oauth/access_token'
    ? 'github_token_endpoint'
    : 'github_other_path';
}

export function classifyUserRedirect(location: string | null): {
  redirectTarget: GitHubFetchFailure['redirectTarget'];
  url?: string;
} {
  if (!location) return { redirectTarget: 'unavailable' };

  let target: URL;
  try {
    target = new URL(location, 'https://api.github.com/user');
  } catch {
    return { redirectTarget: 'unavailable' };
  }

  if (target.origin !== 'https://api.github.com') {
    return { redirectTarget: 'external_origin' };
  }

  if (
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !['/user', '/user/'].includes(target.pathname)
  ) {
    return { redirectTarget: 'github_api_other_path' };
  }

  return { redirectTarget: 'github_api_user_endpoint', url: target.href };
}

export function tokenErrorReason(error: unknown): GitHubIdentityFailureReason {
  switch (error) {
    case 'bad_verification_code':
      return 'github_token_bad_verification_code';
    case 'incorrect_client_credentials':
      return 'github_token_incorrect_client_credentials';
    case 'redirect_uri_mismatch':
      return 'github_token_redirect_uri_mismatch';
    default:
      return 'github_token_rejected';
  }
}
