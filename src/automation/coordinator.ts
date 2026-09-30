import { z } from 'zod';
import type { GitHubClient } from '../github/client';
import { GitHubApiError, InputValidationError, type GitHubWorkflowRun } from '../github/types';
import { assertSelectedRepository, assertWritableBranch } from '../security/policy';
import { mutation } from '../writes/coordinator';
import { parsePlan, PLAN_PATH, planSchema, scopeSchema, targetSchema } from './plan';
import { EXECUTE_STEP, MANAGED_WORKFLOW, WORKFLOW_PATH } from './workflow';

const sha = z.string().regex(/^[a-f0-9]{40}$/i).transform(value => value.toLowerCase());
export const prepareSchema = z.object({
  repository: z.string().min(3).max(200), branch: z.string().min(1).max(240), expectedHeadSha: sha,
  plan: planSchema, apply: z.boolean().default(false),
}).strict();
export const runSchema = z.object({ repository: z.string().min(3).max(200), sha: sha.optional(),
  ref: z.string().min(1).max(240).optional(), scope: scopeSchema.default('quick'), target: targetSchema.default(''),
}).strict();
type Request = { repository: string; sha: string; scope: string; target: string };
type Reads = {
  repositories: Pick<GitHubClient['repositories'], 'listInstallationRepositories' | 'getRepository'>;
  files: Pick<GitHubClient['files'], 'getTextFile'>;
  commits: Pick<GitHubClient['commits'], 'getCommit'>;
  branches: Pick<GitHubClient['branches'], 'getBranchHead'>;
};
type Actions = Pick<GitHubClient['actions'], 'listWorkflowRuns' | 'getWorkflowRun' | 'listWorkflowRunJobs'>;
type Dispatch = (repository: string, ref: string, inputs: Record<string, string>) => Promise<{ runId: number; url: string } | undefined>;

export async function automationKey(request: Request): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(['mcp-checks-v1',
    request.repository.toLowerCase(), request.sha.toLowerCase(), request.scope, request.target]));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Aucun exécutable de dépôt ne tourne dans le Worker. Aucune liste de dépôts à maintenir. */
export class AutomationCoordinator {
  constructor(private readonly actor: string, private readonly reads: Reads, private readonly actions: Actions,
    private readonly dispatch: Dispatch,
    private readonly changes?: Pick<GitHubClient['changes'], 'applyChangeSet'>) {
    if (!/^[1-9][0-9]*$/.test(actor)) throw new InputValidationError('Identité invalide.');
  }

  private async repository(repository: string) {
    assertSelectedRepository(repository, await this.reads.repositories.listInstallationRepositories());
    const metadata = await this.reads.repositories.getRepository(repository);
    if (metadata.archived) throw new InputValidationError('Dépôt archivé.', 'REPOSITORY_ARCHIVED');
    return metadata;
  }

  private async optionalFile(repository: string, path: string, ref: string) {
    try { return await this.reads.files.getTextFile(repository, path, ref); }
    catch (error) { if (error instanceof GitHubApiError && error.status === 404) return undefined; throw error; }
  }

  async prepare(input: z.input<typeof prepareSchema>) {
    const args = prepareSchema.parse(input);
    assertWritableBranch(args.branch);
    if (!args.branch.startsWith(`mcp/${this.actor}/`)) throw new InputValidationError('Branche d’un autre utilisateur.', 'BRANCH_OWNER_MISMATCH');
    if (args.apply && !this.changes) throw new InputValidationError('Le consentement écriture est nécessaire.', 'WRITES_NOT_ENABLED');
    const metadata = await this.repository(args.repository);
    if (args.branch.toLowerCase() === metadata.default_branch.toLowerCase()) throw new InputValidationError('Branche principale protégée.', 'PROTECTED_BRANCH');
    if ((await this.reads.branches.getBranchHead(args.repository, args.branch)).toLowerCase() !== args.expectedHeadSha) {
      throw new InputValidationError('La branche a changé : relisez-la.', 'HEAD_CHANGED');
    }
    const [workflow, plan] = await Promise.all([
      this.optionalFile(args.repository, WORKFLOW_PATH, args.expectedHeadSha),
      this.optionalFile(args.repository, PLAN_PATH, args.expectedHeadSha),
    ]);
    if (workflow && workflow.content !== MANAGED_WORKFLOW) {
      throw new InputValidationError('Un workflow différent utilise déjà mcp-checks.yml ; aucune substitution automatique.', 'WORKFLOW_CONFLICT');
    }
    const content = JSON.stringify(args.plan, null, 2) + '\n';
    parsePlan(content);
    const changes = [
      ...(!workflow ? [{ path: WORKFLOW_PATH, content: MANAGED_WORKFLOW }] : []),
      ...(plan?.content !== content ? [{ path: PLAN_PATH, content, ...(plan ? { expectedSha: plan.sha } : {}) }] : []),
    ];
    const common = { repository: args.repository, branch: args.branch, defaultBranch: metadata.default_branch,
      profiles: Object.keys(args.plan.checks), changedPaths: changes.map(file => file.path),
      note: 'Le push démarre quick si GitHub Actions est disponible. Les commandes sont du code non fiable sans secret ajouté ; ce résultat ne valide ni sécurité ni production.',
      manualDispatch: 'Disponible après présence du workflow canonique sur la branche par défaut. Avant cela, suivre le run push du commit retourné.' };
    if (!args.apply) return { ...common, applied: false, expectedHeadSha: args.expectedHeadSha, changes };
    if (!changes.length) return { ...common, applied: false, unchanged: true, commitSha: args.expectedHeadSha };
    const result = await mutation(() => this.changes!.applyChangeSet(args.repository, args.branch, changes,
      'ci: prepare managed project checks', { expectedHeadSha: args.expectedHeadSha }));
    return { ...common, applied: true, ...result };
  }

  private async request(input: z.input<typeof runSchema>): Promise<{ request: Request; defaultBranch: string }> {
    const args = runSchema.parse(input);
    const metadata = await this.repository(args.repository);
    if (args.sha && args.ref) {
      const current = await this.reads.commits.getCommit(args.repository, args.ref);
      if (current.sha.toLowerCase() !== args.sha) throw new InputValidationError('La branche indiquée ne pointe plus vers ce SHA.', 'HEAD_CHANGED');
    }
    const commit = await this.reads.commits.getCommit(args.repository, args.sha ?? args.ref ?? metadata.default_branch);
    const resolved = sha.parse(commit.sha);
    if (args.sha && args.sha !== resolved) throw new InputValidationError('Commit inattendu.', 'HEAD_CHANGED');
    const file = await this.optionalFile(args.repository, PLAN_PATH, resolved);
    if (!file) throw new InputValidationError('Plan absent : utiliser github_prepare_checks.', 'CHECKS_SETUP_REQUIRED');
    let plan;
    try { plan = parsePlan(file.content); }
    catch { throw new InputValidationError('Plan de vérification invalide : corriger .mcp/checks.json avec github_prepare_checks.', 'CHECK_PLAN_INVALID'); }
    if (!Object.hasOwn(plan.checks, args.scope)) throw new InputValidationError(`Profil absent. Disponibles : ${Object.keys(plan.checks).join(', ')}.`, 'CHECK_PROFILE_MISSING');
    return { request: { repository: args.repository, sha: resolved, scope: args.scope, target: args.target }, defaultBranch: metadata.default_branch };
  }

  private async canonical(repository: string, ref: string): Promise<boolean> {
    return (await this.optionalFile(repository, WORKFLOW_PATH, ref))?.content === MANAGED_WORKFLOW;
  }

  private async matches(run: GitHubWorkflowRun, request: Request, key: string): Promise<boolean> {
    if (run.path !== WORKFLOW_PATH || !/^[a-f0-9]{40}$/i.test(run.head_sha)) return false;
    const manual = run.event === 'workflow_dispatch' && run.display_title === `mcp-checks/${request.sha}/${request.scope}/${key}`;
    const push = run.event === 'push' && request.scope === 'quick' && request.target === '' &&
      run.head_sha.toLowerCase() === request.sha && run.display_title === `mcp-checks/${request.sha}/quick/push`;
    return (manual || push) && await this.canonical(request.repository, run.head_sha);
  }

  private async success(repository: string, run: GitHubWorkflowRun) {
    if (run.status !== 'completed' || run.conclusion !== 'success') return false;
    const jobs = await this.actions.listWorkflowRunJobs(repository, run.id);
    return jobs.some(job => job.name === 'checks' && job.conclusion === 'success' && job.status === 'completed' &&
      job.steps?.some(step => step.name === EXECUTE_STEP && step.status === 'completed' && step.conclusion === 'success'));
  }

  async start(input: z.input<typeof runSchema>) {
    const { request, defaultBranch } = await this.request(input);
    const key = await automationKey(request);
    // Les runs push permettent le premier test sans fusionner un workflow sur la branche principale.
    const runs = await this.actions.listWorkflowRuns(request.repository, { limit: 100 });
    for (const run of runs.sort((a, b) => b.id - a.id)) {
      if (!await this.matches(run, request, key)) continue;
      if (['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status ?? '') || await this.success(request.repository, run)) {
        return { ...request, targetSha: request.sha, runId: run.id, url: run.html_url, reused: true, key,
          status: run.status, nextPollSeconds: run.status === 'completed' ? null : 15 };
      }
      break; // Un échec récent invalide une ancienne réussite.
    }
    const controller = await this.reads.commits.getCommit(request.repository, defaultBranch);
    if (!await this.canonical(request.repository, controller.sha)) {
      throw new InputValidationError('Le premier test quick démarre au push : consulter github_ci_status sur le SHA cible. Le lancement manuel demande le workflow canonique sur la branche par défaut ; aucune fusion automatique.', 'CHECKS_BOOTSTRAP_PENDING');
    }
    let run: Awaited<ReturnType<Dispatch>>;
    try {
      run = await this.dispatch(request.repository, defaultBranch,
        { target_sha: request.sha, scope: request.scope, target: request.target, request_id: key });
    } catch (error) {
      if (error instanceof GitHubApiError && (error.status === 0 || error.status >= 500)) {
        throw new InputValidationError('Lancement incertain. Consulter Actions avant tout nouvel essai.', 'DISPATCH_RESULT_UNKNOWN');
      }
      throw error;
    }
    if (!run) throw new InputValidationError('Demande envoyée sans identifiant ; consulter Actions, ne pas relancer automatiquement.', 'DISPATCH_RESULT_UNKNOWN');
    return { ...request, targetSha: request.sha, controllerSha: controller.sha, runId: run.runId, url: run.url,
      reused: false, status: 'requested', key, nextPollSeconds: 15 };
  }

  async result(input: z.input<typeof runSchema>, runId: number) {
    if (!input.sha) throw new InputValidationError('Réutiliser le SHA exact retourné au lancement.');
    z.number().int().positive().parse(runId);
    const { request } = await this.request(input);
    const run = await this.actions.getWorkflowRun(request.repository, runId);
    if (!await this.matches(run, request, await automationKey(request))) {
      throw new InputValidationError('Exécution non corrélée au workflow canonique, commit et profil.', 'CHECK_PROVENANCE_MISMATCH');
    }
    return { ...request, runId, targetSha: request.sha, controllerSha: run.head_sha, status: run.status,
      conclusion: run.conclusion, verifiedSuccess: await this.success(request.repository, run), url: run.html_url,
      assurance: 'Commandes du projet terminées, pas une approbation de sécurité ni de déploiement.',
      nextPollSeconds: run.status === 'completed' ? null : 15 };
  }
}
