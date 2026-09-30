import type { GitHubActions } from '../github/actions';
import type { GitHubCommits } from '../github/commits';
import type { GitHubRepositories } from '../github/repositories';
import { GitHubApiError, InputValidationError, type GitHubWorkflowRun } from '../github/types';
import { checkScopes, type ChecksConfig } from './config';

const WORKFLOW = 'agent-checks.yml';
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW}`;
const EXECUTE_STEP = 'Exécuter le plan de confiance sur la cible';
export type CheckScope = typeof checkScopes[number];
export type CheckRequest = { repository: string; sha: string; scope: CheckScope; target: string };
export type CheckReceipt = CheckRequest & { controllerSha: string; key: string; title: string; ref: string };

export async function checkKey(request: CheckRequest, controllerSha: string): Promise<string> {
  const data = JSON.stringify(['checks-v1', request.repository.toLowerCase(), request.sha.toLowerCase(),
    request.scope, request.target, controllerSha.toLowerCase(), 'node24.19.0', 'plan1']);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Orchestration uniquement. Le code cible n'est jamais exécuté dans le Worker. */
export class CheckCoordinator {
  constructor(private readonly config: ChecksConfig, private readonly reads: {
    commits: Pick<GitHubCommits, 'getCommit'>;
    repositories: Pick<GitHubRepositories, 'getRepository'>;
  }, private readonly actions: Pick<GitHubActions, 'listWorkflowRuns' | 'dispatchWorkflow' | 'getWorkflowRun' | 'listWorkflowRunJobs'>) {}

  private async receipt(input: CheckRequest): Promise<CheckReceipt> {
    const configuration = this.config.find(item => item.repository.toLowerCase() === input.repository.toLowerCase());
    if (!configuration) throw new InputValidationError('Vérifications non autorisées pour ce dépôt.', 'CHECKS_NOT_ENABLED');
    if (!/^[a-f0-9]{40}$/i.test(input.sha) || !checkScopes.includes(input.scope)) {
      throw new InputValidationError('Commit ou périmètre de vérification invalide.');
    }
    if (input.target && (input.scope !== 'unit' || input.target.length > 240 || input.target.includes('..') ||
        !/^test\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.spec\.ts$/.test(input.target))) {
      throw new InputValidationError('Cible invalide : utiliser un fichier test/*.spec.ts avec unit.');
    }
    const request = { ...input, repository: configuration.repository, sha: input.sha.toLowerCase() };
    const controllerSha = configuration.controllerSha.toLowerCase();
    const key = await checkKey(request, controllerSha);
    return { ...request, controllerSha, key, title: `agent-checks/${request.sha}/${request.scope}/${key}`, ref: configuration.ref };
  }

  private matches(run: GitHubWorkflowRun, receipt: CheckReceipt): boolean {
    return run.head_sha.toLowerCase() === receipt.controllerSha && run.display_title === receipt.title &&
      run.path === WORKFLOW_PATH && run.event === 'workflow_dispatch';
  }

  private async completedSuccessfully(repository: string, run: GitHubWorkflowRun): Promise<boolean> {
    if (run.status !== 'completed' || run.conclusion !== 'success') return false;
    const jobs = await this.actions.listWorkflowRunJobs(repository, run.id);
    return jobs.some(job => job.name === 'checks' && job.status === 'completed' && job.conclusion === 'success' &&
      job.steps?.some(step => step.name === EXECUTE_STEP && step.status === 'completed' && step.conclusion === 'success'));
  }

  async start(input: CheckRequest) {
    const receipt = await this.receipt(input);
    // Le code de contrôle doit être revu et épinglé par l'administrateur, jamais choisi par l'agent.
    const [repository, controller, target] = await Promise.all([
      this.reads.repositories.getRepository(receipt.repository),
      this.reads.commits.getCommit(receipt.repository, receipt.ref),
      this.reads.commits.getCommit(receipt.repository, receipt.sha),
    ]);
    if (repository.default_branch !== receipt.ref || controller.sha.toLowerCase() !== receipt.controllerSha ||
        target.sha.toLowerCase() !== receipt.sha) {
      throw new InputValidationError('Le contrôleur a changé ou ne correspond pas à la branche par défaut. Validation administrateur nécessaire.', 'CONTROLLER_CHANGED');
    }
    const runs = await this.actions.listWorkflowRuns(receipt.repository,
      { workflow: WORKFLOW, headSha: receipt.controllerSha, event: 'workflow_dispatch', limit: 100 });
    const matching = runs.filter(run => this.matches(run, receipt)).sort((a, b) => b.id - a.id);
    // Une nouvelle exécution en échec invalide toute ancienne réussite de la même clé.
    const previous = matching[0];
    if (previous && (['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(previous.status ?? '') ||
        await this.completedSuccessfully(receipt.repository, previous))) {
      return { repository: receipt.repository, targetSha: receipt.sha, controllerSha: receipt.controllerSha,
        runId: previous.id, url: previous.html_url, reused: true, status: previous.status, key: receipt.key,
        deduplication: 'best_effort', nextPollSeconds: previous.status === 'completed' ? null : 15 };
    }
    let run: { runId: number; url: string } | undefined;
    try {
      run = await this.actions.dispatchWorkflow(receipt.repository, WORKFLOW, receipt.ref,
        { scope: receipt.scope, target_sha: receipt.sha, target: receipt.target, request_id: receipt.key });
    } catch (error) {
      if (error instanceof GitHubApiError && (error.status === 0 || error.status >= 500)) {
        throw new InputValidationError('Résultat du lancement incertain. Vérifiez Actions avant de réessayer pour éviter un doublon.', 'DISPATCH_RESULT_UNKNOWN');
      }
      throw error;
    }
    // Une réponse sans identifiant peut malgré tout avoir lancé le workflow : ne pas relancer automatiquement.
    if (!run) throw new InputValidationError('Demande envoyée, mais GitHub n’a pas fourni son identifiant. Vérifiez Actions avant de réessayer.', 'DISPATCH_RESULT_UNKNOWN');
    return { repository: receipt.repository, targetSha: receipt.sha, controllerSha: receipt.controllerSha,
      runId: run.runId, url: run.url, reused: false, status: 'requested', key: receipt.key,
      deduplication: 'best_effort', nextPollSeconds: 15 };
  }

  async result(input: CheckRequest, runId: number) {
    const receipt = await this.receipt(input);
    const run = await this.actions.getWorkflowRun(receipt.repository, runId);
    if (!this.matches(run, receipt)) {
      throw new InputValidationError('Cette exécution ne correspond pas au contrôleur, au commit et aux paramètres attendus.', 'CHECK_PROVENANCE_MISMATCH');
    }
    return { repository: receipt.repository, runId, targetSha: receipt.sha, controllerSha: receipt.controllerSha,
      status: run.status, conclusion: run.conclusion, verifiedSuccess: await this.completedSuccessfully(receipt.repository, run),
      url: run.html_url, nextPollSeconds: run.status === 'completed' ? null : 15 };
  }
}
