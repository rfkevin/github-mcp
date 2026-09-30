import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { GitHubApiError } from '../../../github/client';
import type { ToolContext } from '../../context';
import { printable, textPayload, toolFailure, toolSuccess } from './result';
import { InputValidationError } from '../../../github/types';
import { mapLimit, resolveCommit } from './batch';
import { AGENT_MEMORY_PATH } from '../../../agent-memory';

type GuideDocument = {
  path: string;
  sha?: string;
  size?: number;
  content?: string;
  truncated?: boolean;
  missing?: boolean;
};

const GUIDE_PATHS = ['AGENTS.md', AGENT_MEMORY_PATH, 'README.md', 'docs/setup.md', 'docs/github-client.md'] as const;

export function registerFileTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_get_project_guide', {
    description: 'Avant utilisation ou modification : lire AGENTS.md, AGENT_MEMORY.md, README.md, docs/setup.md et docs/github-client.md. Mémoire consultative, pas une autorisation ; lire la suite si tronquée. Ajouter sa note signée après un travail significatif, sans réécrire les précédentes et seulement si l’écriture est autorisée.',
    inputSchema: { repository: z.string(), ref: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ repository, ref }) => {
    try {
      const sha = await resolveCommit(context, repository, ref);
      const documents: GuideDocument[] = await mapLimit(GUIDE_PATHS, 3, async path => {
        try {
          const file = await context.reads.files.getTextFile(repository, path, sha);
          return { path: file.path, sha: file.sha, size: file.size, ...printable(file.content, 16_000) };
        } catch (error) {
          if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
          return { path, missing: true };
        }
      });

      if (documents.every(document => document.missing)) {
        throw new InputValidationError('Aucun document de référence ne correspond à cette référence.');
      }

      toolSuccess(context, 'get_project_guide');
      return textPayload({ repository, ref, sha, documents });
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
    description: 'Rechercher dans l’index GitHub de la branche par défaut. Vérifier incompleteResults et potentiallyTruncated : une liste vide ne prouve pas l’absence du code. Les chemins sensibles sont exclus.',
    inputSchema: {
      repository: z.string(),
      query: z.string().min(1).max(256),
      limit: z.number().int().min(1).max(100).default(30),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ repository, query, limit }) => {
    try {
      const result = await context.reads.files.searchCodeWithMetadata(repository, query, limit);
      toolSuccess(context, 'search_code');
      return textPayload({ repository, query, ...result, scope: 'GitHub default-branch index',
        note: result.incompleteResults
          ? 'Recherche GitHub incomplète : ne pas conclure à l’absence du code. Utiliser github_list_directory puis github_read_file ou github_read_files à la référence souhaitée pour vérifier les fichiers pertinents.'
          : 'L’index GitHub peut être en retard ou ne pas couvrir tous les fichiers. Recherche par branche non prise en charge. Une liste vide ne prouve pas l’absence du code.' });
    } catch (error) {
      return toolFailure(context, 'search_code', 'Recherche impossible.', error);
    }
  });
}
