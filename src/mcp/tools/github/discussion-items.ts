import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { InputValidationError } from '../../../github/types';
import { SENSITIVE_FILE } from '../../../github/files';
import { oauthMetadata } from './metadata';
import { outputSchemas } from './output-schemas';
import { pageMaskedContent, MASKING_VERSION } from './discussion-content';
import { textPayload, toolFailure, toolSuccess } from './result';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const kind = z.enum(['pull_request_review', 'pull_request_review_comment', 'commit_comment']);

export function registerDiscussionItemTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_get_discussion_item', {
    title: 'Lire un élément de discussion ciblé',
    _meta: oauthMetadata(),
    outputSchema: outputSchemas.github_get_discussion_item,
    description: 'Lire intégralement et par pages UTF-8 une revue de PR, un commentaire inline de revue ou un commentaire de commit. Commencer à offset=0 puis réutiliser revision et nextOffset. pullNumber est requis uniquement pour pull_request_review. Les commentaires généraux d’issue/PR restent lus avec github_get_issue_comment. Les chemins sensibles des commentaires inline/commit sont refusés.',
    inputSchema: { repository: z.string(), kind, id: z.number().int().positive(), pullNumber: z.number().int().positive().optional(),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(12_000).default(4_000),
      revision: z.string().regex(/^[a-f0-9]{64}$/).optional() }, annotations,
  }, async ({ repository, kind, id, pullNumber, offset, limit, revision }) => {
    try {
      if (offset > 0 && !revision) throw new InputValidationError('Une révision est requise pour continuer la lecture.', 'COMMENT_REVISION_REQUIRED');
      let body = '';
      let author: string | undefined;
      let url: string | undefined;
      let createdAt: string | null = null;
      let updatedAt: string | null = null;
      let path: string | null = null;
      let line: number | null = null;
      let state: string | null = null;
      if (kind === 'pull_request_review') {
        if (!pullNumber) throw new InputValidationError('pullNumber est requis pour lire une revue de PR.', 'PULL_NUMBER_REQUIRED');
        const item = await context.pulls.pullRequests.getReview(repository, pullNumber, id);
        body = item.body ?? ''; author = item.user?.login; url = item.html_url; createdAt = item.submitted_at ?? null; state = item.state;
      } else if (kind === 'pull_request_review_comment') {
        const item = await context.pulls.pullRequests.getReviewComment(repository, id);
        if (SENSITIVE_FILE.test(item.path)) throw new InputValidationError('La lecture de ce commentaire sur fichier sensible est interdite.', 'SENSITIVE_FILE');
        body = item.body; author = item.user?.login; url = item.html_url; createdAt = item.created_at ?? null;
        updatedAt = item.updated_at ?? null; path = item.path; line = item.line ?? null;
      } else {
        const item = await context.reads.commits.getComment(repository, id);
        if (SENSITIVE_FILE.test(item.path ?? '')) throw new InputValidationError('La lecture de ce commentaire sur fichier sensible est interdite.', 'SENSITIVE_FILE');
        body = item.body ?? ''; author = item.user?.login; url = item.html_url; createdAt = item.created_at;
        updatedAt = item.updated_at ?? null; path = item.path ?? null; line = item.line ?? null;
      }
      const page = await pageMaskedContent(body, offset, limit, revision);
      toolSuccess(context, 'get_discussion_item');
      return textPayload({ repository, kind, id, author, url: url ?? '', createdAt, updatedAt, path, line, state,
        maskingVersion: MASKING_VERSION, ...page });
    } catch (error) { return toolFailure(context, 'get_discussion_item', 'Lecture ciblée de la discussion impossible.', error); }
  });
}
