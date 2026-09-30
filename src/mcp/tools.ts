import { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from './context';
import { registerCiTools } from './tools/github/ci';
import { registerCommitTools } from './tools/github/commits';
import { registerFileTools } from './tools/github/files';
import { registerRepositoryTools } from './tools/github/repositories';
import { registerReportTools } from './tools/github/reports';
import { registerProjectTools } from './tools/github/project';
import { registerCheckTools } from './tools/github/checks';
import { registerWriteTools } from './tools/github/writes';
import { registerPullRequestTools } from './tools/github/pull-requests';

export function createServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: 'github-mcp', version: '0.6.0' });
  registerRepositoryTools(server, context);
  registerFileTools(server, context);
  registerCommitTools(server, context);
  registerCiTools(server, context);
  registerReportTools(server, context);
  registerProjectTools(server, context);
  registerPullRequestTools(server, context);
  registerCheckTools(server, context);
  registerWriteTools(server, context);
  return server;
}
