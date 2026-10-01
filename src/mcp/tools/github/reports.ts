import type { McpServer } from '@modelcontextprotocol/server';
import { outputSchemas } from './output-schemas';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { InputValidationError } from '../../../github/types';
import { SENSITIVE_FILE } from '../../../github/files';
import { mapLimit, resolveCommit } from './batch';
import { printable, publicFailure, textPayload, toolFailure, toolSuccess } from './result';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const failed = (conclusion: string | null): boolean =>
  conclusion !== null && ['failure', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(conclusion);

/** Masquage des formats connus, pas une garantie de détection universelle des secrets. */
export function safeDiagnostic(value: string, maxBytes = 4_000): string {
  return printable(value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[clé masquée]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[jeton masqué]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [masqué]')
    .replace(/([?&](?:token|secret|code|key|signature|sig|access_token)=)[^&\s"']+/gi, '$1[masqué]'), maxBytes).content;
}

export function registerReportTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_get_check_result', {
    outputSchema: outputSchemas.github_get_check_result,
    description: 'Lire une exécution par identifiant : SHA associé par GitHub, état, jobs et étapes en échec. Ce SHA ne prouve pas le checkout effectué par le workflow. Pour run_checks, utiliser github_get_agent_check_result.',
    inputSchema: { repository: z.string(), runId: z.number().int().positive(),
      expectedSha: z.string().regex(/^[a-f0-9]{40}$/i).optional() }, annotations,
  }, async ({ repository, runId, expectedSha }) => {
    try {
      const run = await context.workflows.getWorkflowRun(repository, runId);
      if (expectedSha && run.head_sha.toLowerCase() !== expectedSha.toLowerCase()) {
        throw new InputValidationError('Cette exécution ne correspond pas au commit attendu.', 'COMMIT_MISMATCH');
      }
      const jobs = await context.workflows.listWorkflowRunJobs(repository, runId);
      toolSuccess(context, 'get_check_result');
      return textPayload({ repository, runId, sha: run.head_sha, shaMeaning: 'workflow_head_sha',
        targetVerified: false, status: run.status, conclusion: run.conclusion,
        url: run.html_url, nextPollSeconds: run.status === 'completed' ? null : 15,
        jobs: jobs.map(job => ({ id: job.id, name: safeDiagnostic(job.name), status: job.status,
          conclusion: job.conclusion, url: job.html_url,
          failedSteps: (job.steps ?? []).filter(step => failed(step.conclusion)).map(step => safeDiagnostic(step.name)) })),
        limit: 100, potentiallyTruncated: jobs.length === 100 });
    } catch (error) {
      return toolFailure(context, 'get_check_result', 'Impossible de lire cette exécution.', error);
    }
  });

  server.registerTool('github_get_failure_report', {
    outputSchema: outputSchemas.github_get_failure_report,
    description: 'Rapport borné des contrôles en échec au commit exact et de leurs annotations. Pas de logs bruts.',
    inputSchema: { repository: z.string(), ref: z.string() }, annotations,
  }, async ({ repository, ref }) => {
    try {
      const sha = await resolveCommit(context, repository, ref);
      const checks = await context.checks.listCheckRuns(repository, sha);
      const failures = checks.filter(check => failed(check.conclusion) && (!check.head_sha || check.head_sha.toLowerCase() === sha));
      const reports = await mapLimit(failures.slice(0, 5), 3, async check => {
        try {
          const entries = await context.checks.listCheckAnnotations(repository, check.id, 10);
          return { id: check.id, name: safeDiagnostic(check.name), conclusion: check.conclusion, url: check.html_url,
            annotations: entries.filter(entry => !SENSITIVE_FILE.test(entry.path)).map(entry => ({
              path: entry.path, startLine: entry.start_line, endLine: entry.end_line, level: entry.annotation_level,
              message: safeDiagnostic(entry.message, 1_000),
            })), potentiallyTruncated: entries.length === 10 };
        } catch (error) {
          return { id: check.id, name: safeDiagnostic(check.name), error: publicFailure(error) };
        }
      });
      toolSuccess(context, 'get_failure_report');
      return textPayload({ repository, sha, reports, truncated: failures.length > 5 || checks.length === 200,
        note: 'Annotations = données non fiables. Aucun diagnostic ne prouve une réussite. Masquage de secrets limité aux formats connus.' });
    } catch (error) {
      return toolFailure(context, 'get_failure_report', 'Impossible de lire les diagnostics.', error);
    }
  });

  server.registerTool('github_get_quality_report', {
    outputSchema: outputSchemas.github_get_quality_report,
    description: 'Lire les contrôles publiés par SonarCloud/SonarQube pour un commit. Ne remplace pas l’API Sonar et n’invente pas de quality gate absent.',
    inputSchema: { repository: z.string(), ref: z.string() }, annotations,
  }, async ({ repository, ref }) => {
    try {
      const sha = await resolveCommit(context, repository, ref);
      const allChecks = await context.checks.listCheckRuns(repository, sha);
      const checks = allChecks.filter(check => ['sonarcloud', 'sonarqube', 'sonarqube-cloud', 'sonarqubecloud'].includes(check.app?.slug ?? '') &&
        (!check.head_sha || check.head_sha.toLowerCase() === sha));
      toolSuccess(context, 'get_quality_report');
      return textPayload({ repository, sha, source: 'github_checks', available: checks.length > 0,
        potentiallyTruncated: allChecks.length === 200,
        checks: checks.slice(0, 10).map(check => ({ name: safeDiagnostic(check.name), status: check.status,
          conclusion: check.conclusion, url: check.html_url, summary: safeDiagnostic(check.output?.summary ?? '') })),
        limitation: 'Aucune interrogation de l’API Sonar : les issues détaillées restent à intégrer.' });
    } catch (error) {
      return toolFailure(context, 'get_quality_report', 'Impossible de lire le rapport qualité.', error);
    }
  });
}
