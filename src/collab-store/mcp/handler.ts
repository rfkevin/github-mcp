/**
 * CC-3 C2 — endpoint /collab/mcp (modèle de src/mcp/handler.ts, dupliqué
 * localement car l'architecture C1 interdit l'import depuis src/mcp/**).
 * Différence clé : le scope dédié collab: est requis ; les scopes GitHub
 * (mcp:read, mcp:write…) n'ouvrent aucun outil du store.
 */
import { insufficientScope, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { isAllowedUser, publicOrigin, type AuthEnv } from '../../config';
import { createCollabToolContext } from './context';
import { createCollabServer } from './tools';
import { acceptsCollabOrigin } from './origin';
import type { CollabStoreEnv } from '../store/config';

// Appelé uniquement par OAuthProvider après validation du jeton.
export const collabMcpHandler = {
  async fetch(request: Request, env: AuthEnv, context: ExecutionContext): Promise<Response> {
    const ctx = context as OAuthResourceContext<{ userId?: string }>;
    const userId = ctx.auth?.userId;
    if (!isAllowedUser(env, userId) || ctx.props?.userId !== userId) {
      return new Response('Accès refusé.', { status: 403, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!ctx.auth.scope.includes('collab:')) return insufficientScope(ctx.auth, ['collab:']);
    const origin = request.headers.get('Origin');
    try {
      if (!await acceptsCollabOrigin(origin, publicOrigin(env), ctx.auth.clientId, env.OAUTH_PROVIDER)) {
        console.warn(JSON.stringify({ service: 'collab-mcp', outcome: 'rejected', reason: 'origin_not_allowed' }));
        return new Response('Origine MCP refusée.', { status: 403, headers: { 'Cache-Control': 'no-store' } });
      }
    } catch {
      // Les métadonnées peuvent être temporairement indisponibles. Jamais fail-open.
      console.warn(JSON.stringify({ service: 'collab-mcp', outcome: 'error', reason: 'client_metadata_unavailable' }));
      return new Response('Métadonnées du client indisponibles.', { status: 503,
        headers: { 'Cache-Control': 'no-store', 'Retry-After': '15' } });
    }
    try {
      const tools = createCollabToolContext(env as AuthEnv & CollabStoreEnv, userId, ctx.auth.scope, {}, ctx.auth.clientId);
      return createMcpHandler(() => createCollabServer(tools), {
        // Le wrapper stateless du SDK agents ne traite que ce chemin exact
        // (défaut '/mcp') et répond 404 'Not Found' à tout autre pathname.
        route: '/collab/mcp',
        allowedHostnames: [new URL(publicOrigin(env)).hostname],
        // Le SDK compare seulement les noms d'hôte ; schéma/hôte/port exacts vérifiés ci-dessus.
        allowedOriginHostnames: origin === null ? [] : [new URL(origin).hostname],
      })(request, env, ctx);
    } catch {
      // Fail-closed : COLLAB_DB absent ou indisponible.
      return new Response('Store de collaboration non configuré.', { status: 503,
        headers: { 'Cache-Control': 'no-store', 'Retry-After': '15' } });
    }
  },
};
