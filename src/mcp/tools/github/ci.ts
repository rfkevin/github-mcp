import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { textPayload, toolFailure, toolSuccess } from './result';
import { publicFailure } from './result';
import { resolveCommit } from './batch';

export async function collectCiStatus(context: ToolContext, repository: string, ref: string) {
  const sha = await resolveCommit(context, repository, ref);
  const [checks, combined, runs] = await Promise.allSettled([
    context.checks.listCheckRuns(repository, sha),
    context.statuses.getCombinedStatus(repository, sha),
    context.workflows.listWorkflowRuns(repository, { headSha: sha, limit: 30 }),
  ]);
  const unavailable = [checks, combined, runs].flatMap((part, index) => part.status === 'rejected'
    ? [{ source: ['checks', 'statuses', 'actions'][index], ...publicFailure(part.reason) }] : []);
  return {
    repository, ref, sha, partial: unavailable.length > 0, unavailable,
    combinedState: combined.status === 'fulfilled' ? combined.value.state : null,
    checks: checks.status === 'fulfilled' ? checks.value
      .filter(check => !check.head_sha || check.head_sha.toLowerCase() === sha)
      .map(check => ({ id: check.id, name: check.name, status: check.status,
        conclusion: check.conclusion, url: check.html_url })) : [],
    runs: runs.status === 'fulfilled' ? runs.value.filter(run => run.head_sha.toLowerCase() === sha &&
      run.path !== '.github/workflows/agent-checks.yml')
      .map(run => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion,
        sha: run.head_sha, branch: run.head_branch, url: run.html_url, createdAt: run.created_at })) : [],
    limits: { checks: 200, runs: 30 },
    note: 'Associations GitHub au commit. Les runs agent-checks testent une cible distincte : utiliser github_get_agent_check_result pour les vérifier.',
  };
}

export function registerCiTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_ci_status', {
    description: 'État des contrôles au commit exact. Les sources inaccessibles sont signalées séparément, jamais assimilées à une réussite.',
    inputSchema: { repository: z.string(), ref: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ repository, ref }) => {
    try {
      const report = await collectCiStatus(context, repository, ref);

      toolSuccess(context, 'ci_status');
      return textPayload(report);
    } catch (error) {
      return toolFailure(context, 'ci_status', 'Impossible de lire l’état des contrôles.', error);
    }
  });
}
