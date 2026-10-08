import type {
  GitHubCheckRun,
  GitHubCheckAnnotation,
  GitHubCombinedStatus,
  GitHubJob,
  GitHubWorkflow,
  GitHubWorkflowRun,
} from './types';

const MAX_LOG_BYTES = 200_000;
import type { GitHubServiceContext } from './service-context';
import { InputValidationError } from './types';

export class GitHubActions {
  constructor(private readonly dependencies: GitHubServiceContext) {}

  listWorkflows(repository: string): Promise<GitHubWorkflow[]> {
    const { paginate, repoPath } = this.dependencies;
    return paginate<{ workflows: GitHubWorkflow[] }, GitHubWorkflow>(
      repoPath(repository, '/actions/workflows'),
      payload => payload.workflows,
      200,
    );
  }

  listWorkflowRuns(
    repository: string,
    options: {
      workflow?: string | number;
      branch?: string;
      headSha?: string;
      status?: string;
      event?: string;
      limit?: number;
    } = {},
  ): Promise<GitHubWorkflowRun[]> {
    const { assertGitRef, encodeSegment, paginate, repoPath, withQuery } = this.dependencies;
    if (options.branch) assertGitRef(options.branch);
    if (options.headSha && !/^[a-f0-9]{40}$/i.test(options.headSha)) {
      throw new InputValidationError('SHA de commit invalide.');
    }

    const base = options.workflow
      ? repoPath(repository, `/actions/workflows/${encodeSegment(String(options.workflow))}/runs`)
      : repoPath(repository, '/actions/runs');

    return paginate<{ workflow_runs: GitHubWorkflowRun[] }, GitHubWorkflowRun>(
      withQuery(base, { branch: options.branch, head_sha: options.headSha, status: options.status, event: options.event }),
      payload => payload.workflow_runs,
      options.limit ?? 30,
    );
  }

  getWorkflowRun(repository: string, runId: number): Promise<GitHubWorkflowRun> {
    const { assertPositiveInteger, repoPath, request } = this.dependencies;
    assertPositiveInteger(runId, 'Identifiant d’exécution');
    return request<GitHubWorkflowRun>(repoPath(repository, `/actions/runs/${runId}`));
  }

  listWorkflowRunJobs(repository: string, runId: number): Promise<GitHubJob[]> {
    const { assertPositiveInteger, paginate, repoPath } = this.dependencies;
    assertPositiveInteger(runId, 'Identifiant d’exécution');
    return paginate<{ jobs: GitHubJob[] }, GitHubJob>(
      repoPath(repository, `/actions/runs/${runId}/jobs`),
      payload => payload.jobs,
      100,
    );
  }

  async getJobLogs(repository: string, jobId: number): Promise<string> {
    const { assertPositiveInteger, repoPath, downloadRedirectedText } = this.dependencies;
    assertPositiveInteger(jobId, 'Identifiant de job');
    return downloadRedirectedText(repoPath(repository, `/actions/jobs/${jobId}/logs`), MAX_LOG_BYTES);
  }

  async rerunWorkflow(repository: string, runId: number, failedJobsOnly = false): Promise<void> {
    const { assertPositiveInteger, repoPath, request } = this.dependencies;
    assertPositiveInteger(runId, 'Identifiant d’exécution');
    await request(
      repoPath(repository, `/actions/runs/${runId}/${failedJobsOnly ? 'rerun-failed-jobs' : 'rerun'}`),
      { method: 'POST' },
    );
  }

  async cancelWorkflowRun(repository: string, runId: number): Promise<void> {
    const { assertPositiveInteger, repoPath, request } = this.dependencies;
    assertPositiveInteger(runId, 'Identifiant d’exécution');
    await request(repoPath(repository, `/actions/runs/${runId}/cancel`), { method: 'POST' });
  }

  async dispatchWorkflow(
    repository: string,
    workflow: string | number,
    ref: string,
    inputs: Record<string, string> = {},
  ): Promise<{ runId: number; url: string } | undefined> {
    const { assertGitRef, encodeSegment, repoPath, request } = this.dependencies;
    assertGitRef(ref, 'référence');
    if (!this.dependencies.allowedWorkflows.has(String(workflow)) ||
        !this.dependencies.allowedWorkflowRefs.has(ref)) {
      throw new InputValidationError('Workflow ou référence non autorisé.', 'WORKFLOW_DENIED');
    }
    const result = await request<{ workflow_run_id?: number; html_url?: string } | undefined>(
      repoPath(repository, `/actions/workflows/${encodeSegment(String(workflow))}/dispatches`),
      { method: 'POST', body: JSON.stringify({ ref, inputs }) },
    );
    if (result?.workflow_run_id && Number.isSafeInteger(result.workflow_run_id) && result.workflow_run_id > 0 &&
        typeof result.html_url === 'string') {
      return { runId: result.workflow_run_id, url: result.html_url };
    }
  }

  listCheckRuns(repository: string, ref: string): Promise<GitHubCheckRun[]> {
    const { assertGitRef, encodeSlashPath, paginate, repoPath } = this.dependencies;
    assertGitRef(ref, 'référence');
    return paginate<{ check_runs: GitHubCheckRun[] }, GitHubCheckRun>(
      repoPath(repository, `/commits/${encodeSlashPath(ref)}/check-runs`),
      payload => payload.check_runs,
      200,
    );
  }

  listCheckAnnotations(repository: string, checkId: number, limit = 50): Promise<GitHubCheckAnnotation[]> {
    const { assertPositiveInteger, repoPath, paginateArray } = this.dependencies;
    assertPositiveInteger(checkId, 'Identifiant de contrôle');
    return paginateArray<GitHubCheckAnnotation>(repoPath(repository, `/check-runs/${checkId}/annotations`),
      Math.min(Math.max(limit, 1), 100));
  }

  getCombinedStatus(repository: string, ref: string): Promise<GitHubCombinedStatus> {
    const { assertGitRef, encodeSlashPath, repoPath, request } = this.dependencies;
    assertGitRef(ref, 'référence');
    return request<GitHubCombinedStatus>(
      repoPath(repository, `/commits/${encodeSlashPath(ref)}/status`),
    );
  }
}
