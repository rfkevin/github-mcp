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
import { registerIssueTools } from './tools/github/issues';
import { registerTargetedWriteTools } from './tools/github/targeted-write';
import { registerFileWriteTools } from './tools/github/file-writes';
import { registerIssueWriteTools } from './tools/github/issue-writes';
import { registerMergeTools } from './tools/github/merges';
import { WORKFLOW_INSTRUCTIONS } from './workflow-guidance';
import { registerIntegrationTools } from './tools/github/integration';
import { registerApplyChangesTool } from './tools/github/apply-changes';

export function createServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: 'github-mcp', version: '0.8.0' }, { instructions: WORKFLOW_INSTRUCTIONS });
  registerRepositoryTools(server, context);
  registerFileTools(server, context);
  registerCommitTools(server, context);
  registerCiTools(server, context);
  registerReportTools(server, context);
  registerProjectTools(server, context);
  registerPullRequestTools(server, context);
  registerIssueTools(server, context);
  registerCheckTools(server, context);
  registerWriteTools(server, context);
  registerTargetedWriteTools(server, context);
  registerFileWriteTools(server, context);
  registerIssueWriteTools(server, context);
  registerMergeTools(server, context);
  registerIntegrationTools(server, context);
  return server;
}
