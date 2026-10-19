import { OAuthAuthorizationServer, OAuthResourceServer, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { assertConfigured, publicOrigin, type AppEnv, type AuthEnv } from './config';
import { authHandler } from './auth/handler';
import { mcpHandler } from './mcp/handler';
import { checksConfig } from './checks/config';
import { writesEnabled } from './writes/config';
import { automationEnabled } from './automation/config';
import { collabStoreEnabled, type CollabStoreEnv } from './collab-store/store/config';
import { collabMcpHandler } from './collab-store/mcp/handler';
import { parseFallbackState, storeFallback } from './collab-store/export/fallback';
import { OWNER_PATH, handleOwnerRequest, type OwnerRouteEnv } from './collab-store/owner/handler';
import { controllerCronEnabled, runScheduledControllers } from './collab-store/controller/scheduled';

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
    const collabEnabled = collabStoreEnabled((env as CollabStoreEnv).COLLAB_STORE_ENABLED);
    const collabReady = collabEnabled && Boolean((env as CollabStoreEnv).COLLAB_DB);
    const githubResource = `${origin}/mcp`;
    const collabResource = `${origin}/collab/mcp`;
    const scopes = [
      'mcp:read', 'offline_access',
      ...(checksConfig(env.GITHUB_CHECKS_CONFIG).length ? ['mcp:checks'] : []),
      ...(writes ? ['mcp:write', 'mcp:integration'] : []),
      ...(automationEnabled(env.GITHUB_AUTOMATION_ENABLED) ? ['mcp:automation'] : []),
      ...(collabReady ? ['collab:'] : []),
    ];
    const requiredGitHubScopes = ['mcp:read',
      ...(writes ? ['mcp:write'] : []),
      ...(scopes.includes('mcp:checks') ? ['mcp:checks'] : []),
    ];

    // One authorization server owns /authorize, /callback, client registration and token
    // exchange. Two OAuthProvider instances had incompatible resource registries on
    // these shared endpoints (real Grok /collab/mcp request: invalid_target).
    // Each resource server validates its own exact token audience; no cross-resource grant.
    const authorizationServer = new OAuthAuthorizationServer<AppEnv>({
      issuer: origin,
      resources: [githubResource, ...(collabReady ? [collabResource] : [])],
      defaultResource: githubResource, // Preserve historical clients without a resource parameter.
      legacyGrantResource: githubResource, // Never migrate an old GitHub grant into collab.
      authorizeEndpoint: `${origin}/authorize`,
      tokenEndpoint: `${origin}/oauth/token`,
      clientRegistrationEndpoint: `${origin}/oauth/register`,
      scopesSupported: scopes,
      clientIdMetadataDocumentEnabled: true,
    });
    const oauth = authorizationServer.getOAuthApi(env);
    const authEnv: AuthEnv = { ...env, OAUTH_PROVIDER: oauth };
    const validateToken = () => (resource: string, token: string) =>
      authorizationServer.validateToken(resource, token, env);
    const github = new OAuthResourceServer<AuthEnv, { userId?: string }>({
      resourceMetadata: { resource: githubResource, authorization_servers: [origin] },
      requiredScopes: requiredGitHubScopes,
      validateToken,
      handler: mcpHandler,
    });
    const collab = collabReady ? new OAuthResourceServer<AuthEnv, { userId?: string }>({
      resourceMetadata: { resource: collabResource, authorization_servers: [origin] },
      requiredScopes: ['collab:'], // A client must not infer all GitHub scopes for the collab API.
      validateToken,
      handler: collabMcpHandler,
    }) : null;

    const pathname = new URL(request.url).pathname;
    // Owner remains out of OAuth and never delegates owner rights to an MCP token.
    if (pathname === OWNER_PATH) {
      const owner = await handleOwnerRequest(request, env as unknown as OwnerRouteEnv, origin, undefined,
        () => listOAuthClientIds(oauth));
      if (owner) return owner;
    }
    // Our application owns authorization and upstream GitHub callback; the same
    // helpers now restore either resource's grant at POST /authorize and /callback.
    if (pathname === '/authorize' || pathname === '/callback') {
      return authHandler.fetch(request, authEnv);
    }
    if (pathname === '/mcp' || pathname.startsWith('/mcp/')
      || pathname === '/.well-known/oauth-protected-resource'
      || pathname === '/.well-known/oauth-protected-resource/mcp') {
      return github.fetch(request, authEnv, ctx);
    }
    if (pathname === '/collab/mcp' && collabEnabled && !collabReady) {
      // CC-3 C6 R4: explicit read-only fallback when D1 is unavailable.
      const fallback = storeFallback(parseFallbackState((env as CollabStoreEnv).COLLAB_FALLBACK_STATE));
      return new Response('Store de collaboration non configuré (STORE_UNAVAILABLE). ' + fallback.instruction,
        { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '15', 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (collab && (pathname === '/collab/mcp' || pathname.startsWith('/collab/mcp/')
      || pathname === '/.well-known/oauth-protected-resource/collab/mcp')) {
      return collab.fetch(request, authEnv, ctx);
    }
    if (pathname.startsWith('/oauth/') || pathname.startsWith('/.well-known/')) {
      return authorizationServer.fetch(request, env, ctx);
    }
    // Retain the existing friendly HTML 404 for non-OAuth paths.
    return authHandler.fetch(request, authEnv);
  },

  // CC-5 L3d — passage programmé du contrôleur : inerte sauf CONTROLLER_CRON_ENABLED="true"
  // et store monté. Il ne fait que journaliser des décisions (aucune action, aucune dépense).
  async scheduled(_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    const store = env as AppEnv & CollabStoreEnv & { CONTROLLER_CRON_ENABLED?: string };
    if (!controllerCronEnabled(store.CONTROLLER_CRON_ENABLED)) return;
    if (!collabStoreEnabled(store.COLLAB_STORE_ENABLED) || !store.COLLAB_DB) return;
    ctx.waitUntil(runScheduledControllers(store.COLLAB_DB).then(() => undefined));
  },
} satisfies ExportedHandler<AppEnv>;

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
