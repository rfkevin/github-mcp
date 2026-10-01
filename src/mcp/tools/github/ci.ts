import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { textPayload, toolFailure, toolSuccess } from './result';
import { publicFailure } from './result';
import { resolveCommit } from './batch';
import { expectedCheckSchema, verificationStatus, type ExpectedCheck, type Observation } from '../../verification';

export async function collectCiStatus(context: ToolContext, repository: string, ref: string, expected: ExpectedCheck[] = []) {
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
  const matchingRuns = runs.status === 'fulfilled' ? runs.value.filter(run => run.head_sha.toLowerCase() === sha &&
    run.path !== '.github/workflows/agent-checks.yml') : [];
  // Une nouvelle exécution au même SHA remplace l'ancienne, pas les autres événements/branches.
  const latestRuns = new Map<string, typeof matchingRuns[number]>();
  for (const run of [...matchingRuns].sort((a, b) => b.id - a.id)) {
    const key = JSON.stringify([run.path ?? run.name ?? run.id, run.event, run.head_branch]);
    if (!latestRuns.has(key)) latestRuns.set(key, run);
  }
  const commitRuns = [...latestRuns.values()];
  const statusCount = combined.status === 'fulfilled' ? combined.value.total_count : null;
  const hasChecks = commitChecks.length > 0 || commitRuns.length > 0 || (statusCount ?? 0) > 0;
  let availability: 'available' | 'unknown' | 'no_checks' = 'no_checks';
  if (hasChecks) availability = 'available';
  else if (unavailable.length > 0) availability = 'unknown';
  const potentiallyTruncated = commitChecks.length >= 200 || (runs.status === 'fulfilled' && runs.value.length >= 30) ||
    (combined.status === 'fulfilled' && combined.value.statuses.length < combined.value.total_count);
  const observations: Observation[] = [
    ...commitChecks.map(check => ({ source: 'check' as const, name: check.name, status: check.status, conclusion: check.conclusion })),
    ...commitRuns.map(run => ({ source: 'workflow' as const, name: run.path ?? run.name ?? `run:${run.id}`, status: run.status ?? 'unknown', conclusion: run.conclusion })),
    ...(combined.status === 'fulfilled' ? combined.value.statuses.map(status => ({ source: 'status' as const,
      name: status.context, status: status.state === 'pending' ? 'pending' : 'completed', conclusion: status.state })) : []),
  ];
  return {
    repository, ref, sha, partial: unavailable.length > 0, unavailable, availability,
    // GitHub renvoie aussi pending quand aucun commit status n'existe.
    combinedState: combined.status === 'fulfilled' && (statusCount ?? 0) > 0 ? combined.value.state : null,
    githubCombinedState: combined.status === 'fulfilled' ? combined.value.state : null,
    statusCount,
    verification: verificationStatus(observations, expected, unavailable.length > 0 || potentiallyTruncated),
    potentiallyTruncated,
    checks: commitChecks
      .map(check => ({ id: check.id, name: check.name, status: check.status,
        conclusion: check.conclusion, url: check.html_url })),
    runs: commitRuns
      .map(run => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion,
        sha: run.head_sha, branch: run.head_branch, path: run.path, url: run.html_url, createdAt: run.created_at })),
    limits: { checks: 200, runs: 30 },
    note: `${availability === 'no_checks' ? 'Aucune vérification disponible pour ce commit : ni réussite ni exécution en cours attestée. ' : ''}combinedState porte uniquement sur les commit statuses, pas sur tous les checks. githubCombinedState est la valeur brute GitHub : pending avec statusCount=0 ne signifie pas qu’un test tourne. Les runs agent-checks testent une cible distincte : utiliser github_get_agent_check_result pour les vérifier.`,
  };
}

export function registerCiTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_ci_status', {
    description: 'Après commit/PR et jusqu’au bilan : suivre les contrôles au SHA exact. Déclarer expectedChecks depuis les workflows/mission : source check + nom du check, workflow + chemin .github/workflows/ci.yml, status + contexte. verification distingue pending, failed, incomplete et declared_checks_passed. Sans attentes, observed_success ne valide pas toute la tâche. Respecter nextPollSeconds ; relire le headSha de la PR avant de conclure. Les contrôles absents, annulés, ignorés ou inaccessibles ne sont pas des réussites.',
    inputSchema: { repository: z.string(), ref: z.string(), expectedChecks: z.array(expectedCheckSchema).max(30).default([]) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ repository, ref, expectedChecks }) => {
    try {
      const report = await collectCiStatus(context, repository, ref, expectedChecks);

      toolSuccess(context, 'ci_status');
      return textPayload(report);
    } catch (error) {
      return toolFailure(context, 'ci_status', 'Impossible de lire l’état des contrôles.', error);
    }
  });
}
