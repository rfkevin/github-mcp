import OAuthProvider, { getOAuthApi, type OAuthHelpers, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { assertConfigured, publicOrigin, type AppEnv, type AuthEnv } from './config';
import { authHandler } from './auth/handler';
import { mcpHandler } from './mcp/handler';
import { checksConfig } from './checks/config';
import { writesEnabled } from './writes/config';
import { automationEnabled } from './automation/config';
import { collabStoreEnabled, type CollabStoreEnv } from './collab-store/store/config';
import { collabMcpHandler } from './collab-store/mcp/handler';
import { OWNER_PATH, handleOwnerRequest, type OwnerRouteEnv } from './collab-store/owner/handler';

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
    }
    try { assertConfigured(env); } catch {
      return new Response('Serveur non configuré.',
        { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const origin = publicOrigin(env);
    if (new URL(request.url).origin !== origin) {
      return new Response('Origine refusée.',
        { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
    if (new URL(request.url).pathname === '/ready' && request.method === 'GET') {
      return Response.json({ status: 'ready', sha: env.BUILD_SHA ?? null },
        { headers: { 'Cache-Control': 'no-store' } });
    }
    const writes = writesEnabled(env.GITHUB_WRITES_ENABLED);
    const scopes = [
      'mcp:read',
      'offline_access',
      ...(checksConfig(env.GITHUB_CHECKS_CONFIG).length ? ['mcp:checks'] : []),
      ...(writes ? ['mcp:write'] : []),
      ...(writes ? ['mcp:integration'] : []),
      ...(automationEnabled(env.GITHUB_AUTOMATION_ENABLED) ? ['mcp:automation'] : []),
      // CC-3 C2 : 'collab:' n'est proposé que si le store est réellement monté.
      ...(collabStoreEnabled((env as CollabStoreEnv).COLLAB_STORE_ENABLED) && (env as CollabStoreEnv).COLLAB_DB ? ['collab:'] : []),
    ];
    const providerOptions: OAuthProviderOptions<AuthEnv> = {
      apiRoute: '/mcp', apiHandler: mcpHandler, defaultHandler: authHandler,
      authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: scopes,
      // mcp:checks est exigé seulement quand GITHUB_CHECKS_CONFIG est configuré : les clients
      // le demandent alors dès la connexion (sans configuration manuelle des scopes).
      requiredScopes: [
        'mcp:read',
        ...(writes ? ['mcp:write'] : []),
        ...(scopes.includes('mcp:checks') ? ['mcp:checks'] : []),
      ],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      clientIdMetadataDocumentEnabled: true,
    };
    const provider = new OAuthProvider<AuthEnv>(providerOptions);
    // CC-3 C5 : canal owner (I7), servi hors des fournisseurs OAuth (aucun jeton n'y donne accès) ;
    // non monté sans configuration complète. La liste des clients OAuth sert seulement à retrouver
    // le client d'un pseudonyme unregistered:… lors d'une association.
    if (new URL(request.url).pathname === OWNER_PATH) {
      const owner = await handleOwnerRequest(request, env as unknown as OwnerRouteEnv, origin, undefined,
        () => listOAuthClientIds(getOAuthApi(providerOptions, env as AuthEnv)));
      if (owner) return owner;
    }
    // CC-3 C2 : second OAuthProvider, même Worker, resource RFC 8707 dédiée
    // (${origin}/collab/mcp). Endpoints authorize/token/register partagés : une
    // requête dont l'indicateur resource vise le store est routée vers ce
    // provider (la lib valide resource contre resourceMetadata), sinon vers le
    // provider GitHub. L'émission de jeton reste permissive : le refus typé sans
    // le scope 'collab:' est enforced par collabMcpHandler (insufficientScope).
    const pathname = new URL(request.url).pathname;
    const collabResource = `${origin}/collab/mcp`;
    const targetResource = await requestedResource(request, pathname);
    if (collabStoreEnabled((env as CollabStoreEnv).COLLAB_STORE_ENABLED)
      && (pathname === '/collab/mcp' || targetResource === collabResource)) {
      if (!(env as CollabStoreEnv).COLLAB_DB) {
        return new Response('Store de collaboration non configuré.',
          { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
      const collabProvider = new OAuthProvider<AuthEnv>({
        apiRoute: '/collab/mcp', apiHandler: collabMcpHandler, defaultHandler: authHandler,
        authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
        scopesSupported: ['collab:', 'mcp:read', 'offline_access'], requiredScopes: [],
        resourceMetadata: { resource: collabResource, authorization_servers: [origin] },
        clientIdMetadataDocumentEnabled: true,
      });
      return collabProvider.fetch(request, env as AuthEnv, ctx);
    }
    return provider.fetch(request, env as AuthEnv, ctx);
  },
} satisfies ExportedHandler<AppEnv>;

/** Indicateur resource (RFC 8707) d'une requête authorize/token, sinon null. */
async function requestedResource(request: Request, pathname: string): Promise<string | null> {
  if (pathname === '/authorize' && request.method === 'GET') {
    return new URL(request.url).searchParams.get('resource');
  }
  if (pathname === '/oauth/token' && request.method === 'POST') {
    try {
      const value = (await request.clone().formData()).get('resource');
      return typeof value === 'string' ? value : null;
    } catch { return null; }
  }
  return null;
}

/** Identifiants des clients OAuth enregistrés (pagination bornée), pour le canal owner. */
async function listOAuthClientIds(helpers: OAuthHelpers): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await helpers.listClients({ limit: 1000, cursor });
    ids.push(...result.items.map(client => client.clientId));
    cursor = result.cursor;
    if (!cursor) break;
  }
  return ids;
}
