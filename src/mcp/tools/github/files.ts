import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { GitHubApiError } from '../../../github/client';
import type { ToolContext } from '../../context';
import { printable, textPayload, toolFailure, toolSuccess } from './result';

type GuideDocument = {
  path: string;
  sha?: string;
  size?: number;
  content?: string;
  truncated?: boolean;
  missing?: boolean;
};

const GUIDE_PATHS = ['AGENTS.md', 'README.md', 'docs/setup.md', 'docs/github-client.md'] as const;

export function registerFileTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_get_project_guide', {
    description: 'Lire les documents de référence du dépôt (AGENTS.md, README.md, docs/setup.md, docs/github-client.md).',
    inputSchema: { repository: z.string(), ref: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ repository, ref }) => {
    try {
      const documents: GuideDocument[] = [];

      for (const path of GUIDE_PATHS) {
        try {
          const file = await context.reads.files.getTextFile(repository, path, ref);
          documents.push({ path: file.path, sha: file.sha, size: file.size, ...printable(file.content) });
        } catch (error) {
          if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
          documents.push({ path, missing: true });
        }
      }

      if (documents.every(document => document.missing)) {
        throw new Error('Aucun document de référence ne correspond à cette référence.');
      }

      toolSuccess(context, 'get_project_guide');
      return textPayload({ repository, ref, documents });
    } catch (error) {
      return toolFailure(context, 'get_project_guide', 'Impossible de lire les documents de référence.', error);
    }
  });

  server.registerTool('github_read_file', {
    description: 'Lire un fichier texte du dépôt à une référence donnée. Les fichiers sensibles sont refusés.',
    inputSchema: { repository: z.string(), path: z.string(), ref: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ repository, path, ref }) => {
    try {
      const file = await context.reads.files.getTextFile(repository, path, ref);
      toolSuccess(context, 'read_file');
      return textPayload({ path: file.path, sha: file.sha, size: file.size, ...printable(file.content) });
    } catch (error) {
      return toolFailure(context, 'read_file', 'Impossible de lire ce fichier.', error);
    }
  });

  server.registerTool('github_list_directory', {
    description: 'Lister un dossier du dépôt à une référence donnée. Les entrées sensibles sont masquées.',
    inputSchema: { repository: z.string(), path: z.string().default(''), ref: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ repository, path, ref }) => {
    try {
      const entries = await context.reads.files.listDirectory(repository, path, ref);
      toolSuccess(context, 'list_directory');
      return textPayload({ repository, path, ref, entries });
    } catch (error) {
      return toolFailure(context, 'list_directory', 'Impossible de lister ce dossier.', error);
    }
  });

  server.registerTool('github_search_code', {
    description: 'Rechercher du code dans un dépôt autorisé. Les chemins sensibles sont exclus.',
    inputSchema: {
      repository: z.string(),
      query: z.string().min(1).max(256),
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ repository, query, limit }) => {
    try {
      const matches = await context.reads.files.searchCode(repository, query, limit);
      toolSuccess(context, 'search_code');
      return textPayload({ repository, query, matches });
    } catch (error) {
      return toolFailure(context, 'search_code', 'Recherche impossible.', error);
    }
  });
}
