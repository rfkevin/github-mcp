import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { textPayload, toolFailure, toolSuccess } from './result';

export function registerCiTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_ci_status', {
    description: 'Résumer les contrôles, le statut combiné et les exécutions récentes d’une référence.',
    inputSchema: { repository: z.string(), ref: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ repository, ref }) => {
    try {
      // Une exécution se filtre par branche : sur un SHA, on liste les plus récentes.
      const runsFilter = /^[a-f0-9]{40}$/i.test(ref) ? { limit: 10 } : { branch: ref, limit: 10 };
      const [checks, combined, runs] = await Promise.all([
        context.reads.actions.listCheckRuns(repository, ref),
        context.reads.actions.getCombinedStatus(repository, ref),
        context.reads.actions.listWorkflowRuns(repository, runsFilter),
      ]);

      toolSuccess(context, 'ci_status');
      return textPayload({
        repository,
        ref,
        combinedState: combined.state,
        checks: checks.map(check => ({
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
          url: check.html_url,
        })),
        runs: runs.map(run => ({
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          branch: run.head_branch,
          url: run.html_url,
          createdAt: run.created_at,
        })),
      });
    } catch (error) {
      return toolFailure(context, 'ci_status', 'Impossible de lire l’état des contrôles.', error);
    }
  });
}
