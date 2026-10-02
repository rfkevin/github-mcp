import { publicOrigin, type AppEnv } from '../config';
import { readJson } from '../github/response';
import { GitHubIdentityError, classifyFetchFailure, classifyRedirectTarget, tokenErrorReason } from './github-errors';
import type { GitHubFetchFailure } from './github-errors';
import { fetchGithubUser } from './github-user';
export { GitHubIdentityError } from './github-errors';
export type { GitHubIdentityFailureReason, GitHubFetchFailureKind, GitHubFetchFailure } from './github-errors';

type GitHubIdentityPhase = 'callback.github_token_exchange' | 'callback.github_user_lookup';

type GitHubIdentityPhaseReporter = (phase: GitHubIdentityPhase) => void;

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
