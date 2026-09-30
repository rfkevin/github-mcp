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
  const commitChecks = checks.status === 'fulfilled' ? checks.value
    .filter(check => !check.head_sha || check.head_sha.toLowerCase() === sha) : [];
  const commitRuns = runs.status === 'fulfilled' ? runs.value.filter(run => run.head_sha.toLowerCase() === sha &&
    run.path !== '.github/workflows/agent-checks.yml') : [];
  const statusCount = combined.status === 'fulfilled' ? combined.value.total_count : null;
  const hasChecks = commitChecks.length > 0 || commitRuns.length > 0 || (statusCount ?? 0) > 0;
  let availability: 'available' | 'unknown' | 'no_checks' = 'no_checks';
  if (hasChecks) availability = 'available';
  else if (unavailable.length > 0) availability = 'unknown';
  return {
    repository, ref, sha, partial: unavailable.length > 0, unavailable, availability,
    // GitHub renvoie aussi pending quand aucun commit status n'existe.
    combinedState: combined.status === 'fulfilled' && (statusCount ?? 0) > 0 ? combined.value.state : null,
    githubCombinedState: combined.status === 'fulfilled' ? combined.value.state : null,
    statusCount,
    checks: commitChecks
      .map(check => ({ id: check.id, name: check.name, status: check.status,
        conclusion: check.conclusion, url: check.html_url })),
    runs: commitRuns
      .map(run => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion,
        sha: run.head_sha, branch: run.head_branch, url: run.html_url, createdAt: run.created_at })),
    limits: { checks: 200, runs: 30 },
    note: `${availability === 'no_checks' ? 'Aucune vérification disponible pour ce commit : ni réussite ni exécution en cours attestée. ' : ''}combinedState porte uniquement sur les commit statuses, pas sur tous les checks. githubCombinedState est la valeur brute GitHub : pending avec statusCount=0 ne signifie pas qu’un test tourne. Les runs agent-checks testent une cible distincte : utiliser github_get_agent_check_result pour les vérifier.`,
  };
}

export function registerCiTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_ci_status', {
    description: 'État des contrôles au commit exact. availability distingue available, no_checks et unknown. Aucun contrôle ne signifie ni réussite ni exécution en cours. Les sources inaccessibles sont signalées séparément.',
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
