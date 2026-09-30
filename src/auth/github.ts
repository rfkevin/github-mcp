import { publicOrigin, type AppEnv } from '../config';
import { readJson } from '../github/response';

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

function classifyFetchFailure(error: unknown): GitHubFetchFailure {
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

function classifyRedirectTarget(location: string | null): GitHubFetchFailure['redirectTarget'] {
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

function classifyUserRedirect(location: string | null): {
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

async function fetchGithubUser(
  fetcher: typeof fetch,
  accessToken: string,
): Promise<Response> {
  let url = 'https://api.github.com/user';

  for (let redirectCount = 0; redirectCount <= 1; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetcher(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'github-mcp-worker',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (error) {
      throw new GitHubIdentityError(
        'github_user_network_error',
        undefined,
        classifyFetchFailure(error),
      );
    }

    if (response.status < 300 || response.status >= 400) return response;

    const redirect = classifyUserRedirect(response.headers.get('location'));
    await response.body?.cancel();
    if (redirect.url && redirectCount === 0) {
      url = redirect.url;
      continue;
    }

    throw new GitHubIdentityError(
      'github_user_redirect_rejected',
      response.status,
      { kind: 'redirect_rejected', redirectTarget: redirect.redirectTarget },
    );
  }

  throw new GitHubIdentityError(
    'github_user_redirect_rejected',
    undefined,
    { kind: 'redirect_rejected', redirectTarget: 'github_api_user_endpoint' },
  );
}

type GitHubIdentityPhase = 'callback.github_token_exchange' | 'callback.github_user_lookup';
type GitHubIdentityPhaseReporter = (phase: GitHubIdentityPhase) => void;

function tokenErrorReason(error: unknown): GitHubIdentityFailureReason {
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

export async function codeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCodePoint(...new Uint8Array(hash)))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function githubSignInUrl(env: AppEnv, state: string, verifier: string): Promise<string> {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID, redirect_uri: `${publicOrigin(env)}/callback`,
    state, code_challenge: await codeChallenge(verifier), code_challenge_method: 'S256',
    scope: '', // Identity only; repository access uses the installation token.
  }).toString();
  return url.href;
}

export async function githubIdentity(
  env: AppEnv,
  code: string,
  verifier: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  reportPhase?: GitHubIdentityPhaseReporter,
): Promise<string> {
  reportPhase?.('callback.github_token_exchange');
  let response: Response;
  try {
    response = await fetcher('https://github.com/login/oauth/access_token', {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
        code,
        code_verifier: verifier,
        redirect_uri: `${publicOrigin(env)}/callback`,
      }),
    });
  } catch (error) {
    throw new GitHubIdentityError(
      'github_token_network_error',
      undefined,
      classifyFetchFailure(error),
    );
  }

  if (response.status >= 300 && response.status < 400) {
    const fetchFailure: GitHubFetchFailure = {
      kind: 'redirect_rejected',
      redirectTarget: classifyRedirectTarget(response.headers.get('location')),
    };
    await response.body?.cancel();
    throw new GitHubIdentityError(
      'github_token_redirect_rejected',
      response.status || undefined,
      fetchFailure,
    );
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubIdentityError('github_token_http_error', response.status);
  }

  let token: { access_token?: string; error?: string };
  try {
    token = await readJson(response, 64_000);
  } catch {
    throw new GitHubIdentityError('github_token_response_invalid');
  }

  if (!token || typeof token.access_token !== 'string' || !token.access_token.trim()) {
    throw new GitHubIdentityError(tokenErrorReason(token?.error));
  }

  reportPhase?.('callback.github_user_lookup');
  const identity = await fetchGithubUser(fetcher, token.access_token);

  if (!identity.ok) {
    await identity.body?.cancel();
    throw new GitHubIdentityError('github_user_http_error', identity.status);
  }

  let user: { id?: number };
  try {
    user = await readJson(identity, 64_000);
  } catch {
    throw new GitHubIdentityError('github_user_response_invalid');
  }

  if (!user || !Number.isSafeInteger(user.id) || user.id! <= 0) {
    throw new GitHubIdentityError('github_user_id_invalid');
  }

  return String(user.id);
}
