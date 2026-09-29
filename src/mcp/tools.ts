import { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from './context';
import { registerCiTools } from './tools/github/ci';
import { registerCommitTools } from './tools/github/commits';
import { registerFileTools } from './tools/github/files';
import { registerRepositoryTools } from './tools/github/repositories';

export function createServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: 'github-mcp', version: '0.2.0' });
  registerRepositoryTools(server, context);
  registerFileTools(server, context);
  registerCommitTools(server, context);
  registerCiTools(server, context);
  return server;
}
