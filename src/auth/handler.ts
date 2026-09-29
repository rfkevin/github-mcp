import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { isAllowedUser, type AuthEnv } from '../config';
import { consentPage, consentPolicy } from './consent';
import { GitHubIdentityError, githubIdentity, githubSignInUrl } from './github';

type PhaseReporter = (phase: string) => void;

// Messages publics par catégorie : jamais d'URL, de code, d'identifiant ni de corps
// de réponse GitHub. Le détail exploitable reste dans le journal structuré.
const IDENTITY_FAILURE_MESSAGES: Record<string, string> = {
  github_token_network_error: 'GitHub est injoignable depuis ce serveur. Réessayez dans un instant.',
  github_user_network_error: 'GitHub est injoignable depuis ce serveur. Réessayez dans un instant.',
  github_token_redirect_rejected:
    'Une redirection GitHub inattendue a été refusée par sécurité. Aucun identifiant n’a été transmis.',
  github_user_redirect_rejected:
    'Une redirection GitHub inattendue a été refusée par sécurité. Aucun identifiant n’a été transmis.',
  github_token_http_error: 'GitHub a refusé la demande de connexion.',
  github_user_http_error: 'GitHub a refusé la vérification de l’identité.',
  github_token_redirect_uri_mismatch: 'Le callback GitHub configuré ne correspond pas à cette adresse.',
  github_token_incorrect_client_credentials: 'Les identifiants OAuth GitHub du serveur sont invalides.',
  github_token_bad_verification_code: 'Le code de connexion GitHub a expiré ou a déjà été utilisé. Recommencez.',
  github_token_response_invalid: 'GitHub a renvoyé une réponse de connexion illisible.',
  github_user_response_invalid: 'GitHub a renvoyé une identité illisible.',
  github_user_id_invalid: 'GitHub a renvoyé une identité inutilisable.',
  github_token_rejected: 'La connexion GitHub a été refusée. Recommencez depuis votre client.',
};

const FALLBACK_FAILURE_MESSAGE = 'Connexion temporairement indisponible.';

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store' } });
}

function failureMessage(error: unknown): string {
  return error instanceof GitHubIdentityError
    ? IDENTITY_FAILURE_MESSAGES[error.reason] ?? FALLBACK_FAILURE_MESSAGE
    : FALLBACK_FAILURE_MESSAGE;
}

async function handleAuthorizeGet(
  request: Request,
  oauth: AuthEnv['OAUTH_PROVIDER'],
  reportPhase: PhaseReporter,
): Promise<Response> {
  reportPhase('authorize.parse_request');
  const auth = await oauth.parseAuthRequest(request);
  reportPhase('authorize.describe_consent');
  const details = await oauth.describeConsent(auth);
  reportPhase('authorize.begin_consent');
  const consent = await oauth.beginConsent(auth);
  consent.headers.set('Content-Type', 'text/html; charset=utf-8');
  consent.headers.set('Content-Security-Policy', consentPolicy(details.redirectUri));
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function handleAuthorizePost(
  request: Request,
  env: AuthEnv,
  oauth: AuthEnv['OAUTH_PROVIDER'],
  reportPhase: PhaseReporter,
): Promise<Response> {
  reportPhase('authorize.read_form');
  const form = await request.formData();
  const formHandle = form.get('handle');
  const handle = typeof formHandle === 'string' ? formHandle : '';

  if (form.get('decision') !== 'approve') {
    reportPhase('authorize.deny_consent');
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  reportPhase('authorize.approve_consent');
  const approved = await oauth.approveConsent(request, handle);
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  reportPhase('authorize.begin_upstream');
  const upstream = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  reportPhase('authorize.build_github_redirect');
  upstream.headers.set('Location', await githubSignInUrl(env, upstream.state, verifier));
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function handleCallback(
  request: Request,
  env: AuthEnv,
  oauth: AuthEnv['OAUTH_PROVIDER'],
  reportPhase: PhaseReporter,
): Promise<Response> {
  reportPhase('callback.finish_upstream');
  const upstream = await oauth.finishUpstream<{ verifier: string }>(request);
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code || url.searchParams.has('error')) {
    upstream.headers.set('Location', authorizationErrorRedirect(upstream.request, 'access_denied'));
    return new Response(null, { status: 302, headers: upstream.headers });
  }

  reportPhase('callback.github_identity');
  const userId = await githubIdentity(env, code, upstream.data.verifier, undefined, reportPhase);
  reportPhase('callback.check_user');
  if (!isAllowedUser(env, userId)) {
    upstream.headers.set('Location', authorizationErrorRedirect(upstream.request, 'access_denied'));
    return new Response(null, { status: 302, headers: upstream.headers });
  }

  reportPhase('callback.complete_authorization');
  const result = await oauth.completeAuthorization({
    request: upstream.request,
    userId,
    metadata: {},
    scope: upstream.request.scope,
    props: { userId },
  });
  upstream.headers.set('Location', result.redirectTo);
  return new Response(null, { status: 302, headers: upstream.headers });
}

function diagnosticReason(error: unknown): string {
  if (error instanceof AuthorizationError) {
    if (error.description === 'Missing transaction handle') return 'consent_handle_missing';
    if (error.description === 'This authorization was not started in this browser; start again') {
      return 'browser_binding_missing';
    }
    if (error.description === 'This authorization belongs to a different browser session; start again') {
      return 'browser_binding_mismatch';
    }
    if (error.description === 'This authorization expired or was already used; start again') {
      return 'consent_transaction_expired_or_used';
    }
    if (error.code === 'invalid_scope') return 'consent_scope_invalid';
    return 'authorization_rejected';
  }

  if (error instanceof GitHubIdentityError) return error.reason;
  if (error instanceof CimdFetchError) return 'client_metadata_unavailable';
  return 'unexpected_error';
}

export const authHandler = {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;
    let phase = 'route.dispatch';
    try {
      if (url.pathname === '/authorize' && request.method === 'GET') {
        return await handleAuthorizeGet(request, oauth, value => { phase = value; });
      }
      if (url.pathname === '/authorize' && request.method === 'POST') {
        return await handleAuthorizePost(request, env, oauth, value => { phase = value; });
      }
      if (url.pathname === '/callback' && request.method === 'GET') {
        return await handleCallback(request, env, oauth, value => { phase = value; });
      }
      return textResponse('Introuvable', 404);
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'oauth_flow_failure',
        phase,
        reason: diagnosticReason(error),
        ...(error instanceof GitHubIdentityError && error.httpStatus !== undefined
          ? { httpStatus: error.httpStatus }
          : {}),
        ...(error instanceof GitHubIdentityError && error.fetchFailure
          ? { fetchFailure: error.fetchFailure }
          : {}),
      }));
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        return textResponse('Demande de connexion invalide ou expirée. Recommencez depuis votre client.', 400);
      }
      return textResponse(failureMessage(error), 503);
    }
  },
};
