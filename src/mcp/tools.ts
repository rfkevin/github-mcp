import { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from './context';
import { registerRepositoryTools } from './tools/github/repositories';

export function createServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: 'github-mcp', version: '0.1.0' });
  registerRepositoryTools(server, context);
  return server;
}
