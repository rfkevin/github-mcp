import { insufficientScope, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { isAllowedUser, publicOrigin, type AppEnv } from '../config';
import { createToolContext } from './context';
import { createServer } from './tools';

// Called only by OAuthProvider after validating the token.
export const mcpHandler = {
  async fetch(request: Request, env: AppEnv, context: ExecutionContext): Promise<Response> {
    const ctx = context as OAuthResourceContext<{ userId?: string }>;
    const userId = ctx.auth?.userId;
    if (!isAllowedUser(env, userId) || ctx.props?.userId !== userId) {
      return new Response('Accès refusé.', { status: 403 });
    }
    if (!ctx.auth.scope.includes('mcp:read')) return insufficientScope(ctx.auth, ['mcp:read']);
    const tools = createToolContext(env, userId);
    return createMcpHandler(() => createServer(tools), {
      allowedHostnames: [new URL(publicOrigin(env)).hostname],
    })(request, env, ctx);
  },
};
