import { publicOrigin, type AppEnv } from '../config';

export type GitHubIdentityFailureReason =
  | 'github_token_network_error'
  | 'github_token_http_error'
  | 'github_token_response_invalid'
  | 'github_token_rejected'
  | 'github_token_bad_verification_code'
  | 'github_token_incorrect_client_credentials'
  | 'github_token_redirect_uri_mismatch'
  | 'github_user_network_error'
  | 'github_user_http_error'
  | 'github_user_response_invalid'
  | 'github_user_id_invalid';

export class GitHubIdentityError extends Error {
  constructor(
    public readonly reason: GitHubIdentityFailureReason,
    public readonly httpStatus?: number,
  ) {
    super(reason);
    this.name = 'GitHubIdentityError';
  }
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
      redirect: 'error',
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
  } catch {
    throw new GitHubIdentityError('github_token_network_error');
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubIdentityError('github_token_http_error', response.status);
  }

  let token: { access_token?: string; error?: string };
  try {
    token = await response.json() as { access_token?: string; error?: string };
  } catch {
    throw new GitHubIdentityError('github_token_response_invalid');
  }

  if (!token.access_token) {
    throw new GitHubIdentityError(tokenErrorReason(token.error));
  }

  reportPhase?.('callback.github_user_lookup');
  let identity: Response;
  try {
    identity = await fetcher('https://api.github.com/user', {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'github-mcp-worker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch {
    throw new GitHubIdentityError('github_user_network_error');
  }

  if (!identity.ok) {
    await identity.body?.cancel();
    throw new GitHubIdentityError('github_user_http_error', identity.status);
  }

  let user: { id?: number };
  try {
    user = await identity.json() as { id?: number };
  } catch {
    throw new GitHubIdentityError('github_user_response_invalid');
  }

  if (!Number.isSafeInteger(user.id) || user.id! <= 0) {
    throw new GitHubIdentityError('github_user_id_invalid');
  }

  return String(user.id);
}
