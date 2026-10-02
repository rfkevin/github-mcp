import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import type { GitHubIssue } from '../../../github/types';
import { oauthMetadata } from './metadata';
import { outputSchemas } from './output-schemas';
import { printable, textPayload, toolFailure, toolSuccess } from './result';
import { safeDiagnostic } from './reports';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function issueSummary(issue: GitHubIssue) {
  const body = printable(safeDiagnostic(issue.body ?? '', 20_000), 12_000);
  return {
    number: issue.number,
    title: safeDiagnostic(issue.title, 1_000),
    state: issue.state,
    url: issue.html_url,
    author: issue.user?.login,
    labels: issue.labels.map(label => typeof label === 'string' ? label : label.name),
    assignees: issue.assignees?.map(user => user.login) ?? [],
    body: body.content,
    bodyTruncated: body.truncated || new TextEncoder().encode(issue.body ?? '').byteLength > 20_000,
  };
}

export function registerIssueTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_list_issues', {
    title: 'Lister les issues GitHub',
    _meta: oauthMetadata(),
    outputSchema: outputSchemas.github_list_issues,
    description: 'Lister les issues du dépôt (hors pull requests). Lecture seule. Utiliser github_get_issue pour lire une issue et ses commentaires.',
    inputSchema: {
      repository: z.string(),
      state: z.enum(['open', 'closed', 'all']).default('open'),
      labels: z.array(z.string().min(1).max(50)).max(20).optional(),
      assignee: z.string().min(1).max(100).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    },
    annotations,
  }, async ({ repository, state, labels, assignee, limit }) => {
    try {
      const issues = await context.pulls.issues.listIssues(repository, { state, labels, assignee, limit });
      toolSuccess(context, 'list_issues');
      return textPayload({ repository, issues: issues.map(issueSummary), limit,
        potentiallyTruncated: issues.length === limit });
    } catch (error) {
      return toolFailure(context, 'list_issues', 'Lecture des issues impossible.', error);
    }
  });

  server.registerTool('github_get_issue', {
    title: 'Lire une issue GitHub et ses commentaires',
    _meta: oauthMetadata(),
    outputSchema: outputSchemas.github_get_issue,
    description: 'Lire une issue GitHub et, optionnellement, une page de 20 commentaires. Les textes sont bornés ; paginer tant que nextCommentsPage existe.',
    inputSchema: {
      repository: z.string(),
      number: z.number().int().positive(),
      includeComments: z.boolean().default(true),
      commentsPage: z.number().int().min(1).max(100).default(1),
    },
    annotations,
  }, async ({ repository, number, includeComments, commentsPage = 1 }) => {
    try {
      const issue = await context.pulls.issues.getIssue(repository, number);
      if (issue.pull_request) {
        return toolFailure(context, 'get_issue', 'Ce numéro désigne une pull request ; utilisez github_get_pull_request.',
          new Error('pull request'));
      }
      const comments = includeComments ? await context.pulls.issues.listComments(repository, number, 20, commentsPage) : undefined;
      toolSuccess(context, 'get_issue');
      return textPayload({ repository, ...issueSummary(issue),
        ...(comments ? {
          comments: comments.map(comment => ({ id: comment.id, author: comment.user?.login,
            body: safeDiagnostic(comment.body ?? '', 2_000),
            bodyTruncated: new TextEncoder().encode(comment.body ?? '').byteLength > 2_000,
            url: comment.html_url })),
          commentsPotentiallyTruncated: comments.length === 20,
          commentsPage,
          nextCommentsPage: comments.length === 20 && commentsPage < 100 ? commentsPage + 1 : null,
        } : {}) });
    } catch (error) {
      return toolFailure(context, 'get_issue', 'Lecture de l’issue impossible.', error);
    }
  });
}
