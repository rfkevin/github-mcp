import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { isAllowedUser, type AuthEnv } from '../config';
import { consentPage, consentPolicy } from './consent';
import { githubIdentity, githubSignInUrl } from './github';

type PhaseReporter = (phase: string) => void;

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
  const userId = await githubIdentity(env, code, upstream.data.verifier);
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
      return new Response('Introuvable', { status: 404 });
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'oauth_flow_failure',
        phase,
        reason: diagnosticReason(error),
      }));
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        return new Response('Demande de connexion invalide ou expirée. Recommencez depuis votre client.', {
          status: 400, headers: { 'Cache-Control': 'no-store' },
        });
      }
      return new Response('Connexion temporairement indisponible.', {
        status: 503, headers: { 'Cache-Control': 'no-store' },
      });
    }
  },
};
