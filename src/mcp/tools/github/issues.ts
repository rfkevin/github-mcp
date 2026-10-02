import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { oauthMetadata } from './metadata';
import { printable, textPayload, toolFailure, toolSuccess } from './result';
import { safeDiagnostic } from './reports';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const summary = (issue: Awaited<ReturnType<ToolContext['issues']['getIssue']>>) => {
  const body = printable(safeDiagnostic(issue.body ?? '', 20_000), 12_000);
  return { number: issue.number, title: safeDiagnostic(issue.title, 1_000), state: issue.state,
    url: issue.html_url, author: issue.user?.login, labels: (issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name),
    assignees: (issue.assignees ?? []).map(user => user.login), body: body.content, bodyTruncated: body.truncated };
};

export function registerIssueTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_list_issues', {
    title: 'Lister les issues GitHub', _meta: oauthMetadata(),
    description: 'Lister les issues réelles du dépôt (les pull requests sont exclues). Nécessite Issues: Read sur la GitHub App.',
    inputSchema: { repository: z.string(), state: z.enum(['open', 'closed', 'all']).default('open'), limit: z.number().int().min(1).max(50).default(20) }, annotations,
  }, async ({ repository, state, limit }) => {
    try { const issues = await context.issues.listIssues(repository, { state, limit }); toolSuccess(context, 'list_issues');
      return textPayload({ repository, issues: issues.map(summary), limit, potentiallyTruncated: issues.length === limit });
    } catch (error) { return toolFailure(context, 'list_issues', 'Lecture des issues impossible. Vérifiez la permission Issues: Read de la GitHub App.', error); }
  });
  server.registerTool('github_get_issue', {
    title: 'Lire une issue GitHub et ses commentaires', _meta: oauthMetadata(),
    description: 'Lire une issue précise et, optionnellement, une page de 20 commentaires. Nécessite Issues: Read sur la GitHub App.',
    inputSchema: { repository: z.string(), number: z.number().int().positive(), includeComments: z.boolean().default(true), commentsPage: z.number().int().min(1).max(100).default(1) }, annotations,
  }, async ({ repository, number, includeComments, commentsPage }) => {
    try { const issue = await context.issues.getIssue(repository, number); const comments = includeComments ? await context.issues.listComments(repository, number, 20, commentsPage) : [];
      toolSuccess(context, 'get_issue'); return textPayload({ repository, ...summary(issue), comments: comments.map(comment => ({ id: comment.id, author: comment.user?.login,
        body: safeDiagnostic(comment.body ?? '', 2_000), bodyTruncated: new TextEncoder().encode(comment.body ?? '').byteLength > 2_000, url: comment.html_url })),
        commentsPotentiallyTruncated: comments.length === 20, commentsPage, nextCommentsPage: comments.length === 20 && commentsPage < 100 ? commentsPage + 1 : null });
    } catch (error) { return toolFailure(context, 'get_issue', 'Lecture de l’issue impossible. Vérifiez la permission Issues: Read de la GitHub App.', error); }
  });
}
