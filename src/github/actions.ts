import type {
  GitHubCheckRun,
  GitHubCombinedStatus,
  GitHubJob,
  GitHubWorkflow,
  GitHubWorkflowRun,
} from './types';

const MAX_LOG_BYTES = 200_000;
import type { GitHubServiceContext } from './service-context';

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
      status?: string;
      event?: string;
      limit?: number;
    } = {},
  ): Promise<GitHubWorkflowRun[]> {
    const { assertGitRef, encodeSegment, paginate, repoPath, withQuery } = this.dependencies;
    if (options.branch) assertGitRef(options.branch);

    const base = options.workflow
      ? repoPath(repository, `/actions/workflows/${encodeSegment(String(options.workflow))}/runs`)
      : repoPath(repository, '/actions/runs');

    return paginate<{ workflow_runs: GitHubWorkflowRun[] }, GitHubWorkflowRun>(
      withQuery(base, { branch: options.branch, status: options.status, event: options.event }),
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
    const { assertPositiveInteger, repoPath, send } = this.dependencies;
    assertPositiveInteger(jobId, 'Identifiant de job');
    const response = await send(repoPath(repository, `/actions/jobs/${jobId}/logs`));
    const text = await response.text();
    return text.length > MAX_LOG_BYTES ? `[…tronqué…]\n${text.slice(-MAX_LOG_BYTES)}` : text;
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
  ): Promise<void> {
    const { assertGitRef, encodeSegment, repoPath, request } = this.dependencies;
    assertGitRef(ref, 'référence');
    await request(
      repoPath(repository, `/actions/workflows/${encodeSegment(String(workflow))}/dispatches`),
      { method: 'POST', body: JSON.stringify({ ref, inputs }) },
    );
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

  getCombinedStatus(repository: string, ref: string): Promise<GitHubCombinedStatus> {
    const { assertGitRef, encodeSlashPath, repoPath, request } = this.dependencies;
    assertGitRef(ref, 'référence');
    return request<GitHubCombinedStatus>(
      repoPath(repository, `/commits/${encodeSlashPath(ref)}/status`),
    );
  }
}
