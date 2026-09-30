import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { printable, textPayload, toolFailure, toolSuccess } from './result';
import { SENSITIVE_FILE } from '../../../github/files';

// Un diff complet peut être énorme : au-delà de ce budget, les patchs sont omis.
const MAX_COMPARISON_BYTES = 120_000;

export function registerCommitTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_compare_refs', {
    description: 'Comparer deux références (noms de branches, tags ou SHA de commits). Les expressions relatives comme master~1 ou HEAD^ sont refusées : utiliser le SHA du parent. Renvoie les commits et fichiers touchés.',
    inputSchema: { repository: z.string(), base: z.string(), head: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ repository, base, head }) => {
    try {
      const comparison = await context.reads.commits.compareRefs(repository, base, head);
      const summary = {
        repository,
        base,
        head,
        status: comparison.status,
        aheadBy: comparison.ahead_by,
        behindBy: comparison.behind_by,
        totalCommits: comparison.total_commits,
        commitsPotentiallyTruncated: comparison.total_commits > Math.min(comparison.commits.length, 50),
        filesPotentiallyTruncated: (comparison.files?.length ?? 0) >= 300,
        commits: comparison.commits.slice(0, 50).map(commit => ({
          sha: commit.sha,
          message: printable(commit.commit.message.split('\n')[0], 500).content,
          date: commit.commit.author?.date,
        })),
        files: (comparison.files ?? []).filter(file => !SENSITIVE_FILE.test(file.filename) &&
          !SENSITIVE_FILE.test(file.previous_filename ?? '')).map(file => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch,
        })),
      };

      const withPatches = new TextEncoder().encode(JSON.stringify(summary)).byteLength <= MAX_COMPARISON_BYTES;
      toolSuccess(context, 'compare_refs');

      return textPayload(withPatches
        ? summary
        : { ...summary, patchesOmitted: true, files: summary.files.map(({ patch, ...file }) => file) });
    } catch (error) {
      return toolFailure(context, 'compare_refs', 'Comparaison impossible.', error);
    }
  });
}
