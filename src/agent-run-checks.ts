import { GitHubClient } from './github/client';
import { CheckCoordinator, checkKey } from './checks/coordinator';
import { checksConfig } from './checks/config';
import { InputValidationError } from './github/types';
import { SENSITIVE_FILE } from './github/files';
import { safeDiagnostic } from './mcp/tools/github/reports';
import { ToolRefused } from './collab-store/agentrun/engine';
import type { ApiChecks } from './collab-store/agentrun/github-write/tools';

export interface ApiChecksEnv {
  GITHUB_APP_ID?: string; GITHUB_INSTALLATION_ID?: string; GITHUB_PRIVATE_KEY?: string;
  GITHUB_CHECKS_CONFIG?: string; AGENT_RUN_CHECKS?: string;
}

/** Same pinned controller as the chat. Neither workflow nor controller ref comes from the model. */
export function apiChecksFrom(env: ApiChecksEnv, repository: string): ApiChecks | null {
  if (env.AGENT_RUN_CHECKS !== 'true' || !env.GITHUB_APP_ID || !env.GITHUB_INSTALLATION_ID || !env.GITHUB_PRIVATE_KEY) return null;
  const config = checksConfig(env.GITHUB_CHECKS_CONFIG).filter(c => c.repository.toLowerCase() === repository.toLowerCase());
  if (config.length !== 1) return null;
  const shared = { appId: env.GITHUB_APP_ID, installationId: env.GITHUB_INSTALLATION_ID, privateKey: env.GITHUB_PRIVATE_KEY,
    allowedRepositories: [repository] };
  const reads = new GitHubClient({ ...shared, tokenPermissions: { metadata: 'read', contents: 'read', checks: 'read', actions: 'read' } });
  const dispatch = new GitHubClient({ ...shared, policy: { readOnly: false }, apiVersion: '2026-03-10',
    tokenPermissions: { metadata: 'read', actions: 'write' }, allowedWorkflows: ['agent-checks.yml'], allowedWorkflowRefs: [config[0].ref] });
  const coordinator = new CheckCoordinator(config, reads, dispatch.actions);
  const input = (sha: string) => ({ repository, sha, scope: 'full' as const, target: '' });
  return {
    async start(sha) {
      try { return await coordinator.start(input(sha)); }
      catch (e) {
        // Uncertain dispatch MUST stay ambiguous, never retry as a definite refusal.
        if (e instanceof InputValidationError && e.code !== 'DISPATCH_RESULT_UNKNOWN') throw new ToolRefused(e.code);
        throw e;
      }
    },
    async lookup(sha) {
      const key = await checkKey(input(sha), config[0].controllerSha.toLowerCase());
      const runs = await reads.actions.listWorkflowRuns(repository, { workflow: 'agent-checks.yml', headSha: config[0].controllerSha, event: 'workflow_dispatch', limit: 100 });
      const run = runs.filter(r => r.head_sha.toLowerCase() === config[0].controllerSha.toLowerCase()
        && r.event === 'workflow_dispatch' && r.path === '.github/workflows/agent-checks.yml' && r.display_title === `agent-checks/${sha}/full/${key}`)
        .sort((a,b) => b.id-a.id)[0];
      return run ? { found: true, result: { runId: run.id, targetSha: sha, controllerSha: config[0].controllerSha, key, url: run.html_url, status: run.status, reused: true } } : null;
    },
    async result(sha, runId) {
      const result = await coordinator.result(input(sha), runId);
      if (result.status !== 'completed' || result.verifiedSuccess) return result;
      const jobs = await reads.actions.listWorkflowRunJobs(repository, runId);
      const failedJobs = jobs.filter(j => j.conclusion === 'failure' || j.conclusion === 'timed_out').slice(0, 2);
      const diagnostics = await Promise.all(failedJobs.map(async job => {
        let excerpt = '';
        try { excerpt = safeDiagnostic(await reads.actions.getJobLogs(repository, job.id), 2000); } catch { excerpt = '[logs indisponibles]'; }
        return { job: safeDiagnostic(job.name, 200), excerpt };
      }));
      const checks = await reads.actions.listCheckRuns(repository, sha);
      const annotations = [];
      for (const check of checks.filter(c => c.head_sha === sha && c.conclusion === 'failure').slice(0, 3)) {
        const entries = await reads.actions.listCheckAnnotations(repository, check.id, 5);
        for (const entry of entries.filter(e => !SENSITIVE_FILE.test(e.path))) {
          let source = '[source indisponible]';
          try {
            const file = await reads.files.getTextFile(repository, entry.path, sha);
            source = safeDiagnostic(file.content.split('\n')[entry.start_line - 1] ?? '', 600);
          } catch { /* Preserve the diagnostic if the source is unavailable. */ }
          annotations.push({ path: safeDiagnostic(entry.path, 400), line: entry.start_line,
            column: (entry as typeof entry & { start_column?: number }).start_column ?? null,
            message: safeDiagnostic(entry.message, 1000), source });
        }
      }
      return { ...result, diagnostics, annotations, diagnostics_bounded: true };
    },
  };
}
