import { describe, expect, it, vi } from 'vitest';
import { automationEnabled } from '../src/automation/config';
import { AutomationCoordinator, automationKey } from '../src/automation/coordinator';
import { parsePlan, PLAN_PATH } from '../src/automation/plan';
import { EXECUTE_STEP, MANAGED_WORKFLOW, WORKFLOW_PATH } from '../src/automation/workflow';
import { GitHubApiError, type GitHubWorkflowRun } from '../src/github/types';
import { assertWritablePath, validateChangeSet } from '../src/security/policy';
import { createToolContext } from '../src/mcp/context';
import type { AppEnv } from '../src/config';

const repository = 'owner/new-project';
const sha = 'a'.repeat(40);
const controller = 'b'.repeat(40);
const plan = { version: 1 as const, workingDirectory: '.', install: ['npm ci --ignore-scripts'], checks: { quick: ['npm test -- --run'], lint: ['npm run lint'] } };
const request = { repository, sha, scope: 'quick', target: '' };
function fixture() {
  const reads = {
    repositories: {
      listInstallationRepositories: vi.fn(async () => [repository]),
      getRepository: vi.fn(async () => ({ full_name: repository, private: true, default_branch: 'main', archived: false })),
    },
    files: { getTextFile: vi.fn(async (_repository: string, path: string, _ref: string) => {
      if (path === PLAN_PATH) return { path, content: JSON.stringify(plan), sha, size: 200 };
      return { path, content: MANAGED_WORKFLOW, sha, size: MANAGED_WORKFLOW.length };
    }) },
    commits: { getCommit: vi.fn(async (_repository: string, ref: string) => ({ sha: ref === 'main' ? controller : sha, html_url: '', commit: { message: '' } })) },
    branches: { getBranchHead: vi.fn(async () => sha) },
  };
  const actions = {
    listWorkflowRuns: vi.fn(async () => [] as GitHubWorkflowRun[]), getWorkflowRun: vi.fn(),
    listWorkflowRunJobs: vi.fn(async () => [{ id: 1, name: 'checks', status: 'completed', conclusion: 'success', html_url: null,
      steps: [{ name: EXECUTE_STEP, status: 'completed', conclusion: 'success' }] }]),
  };
  const dispatch = vi.fn(async () => ({ runId: 7, url: 'https://github.com/owner/new-project/actions/runs/7' }));
  const changes = { applyChangeSet: vi.fn(async () => ({ branch: 'mcp/123/work', commitSha: controller, changedPaths: [WORKFLOW_PATH, PLAN_PATH], deletedPaths: [] })) };
  return { reads, actions, dispatch, changes, coordinator: new AutomationCoordinator('123', reads, actions, dispatch, changes) };
}
const pushRun = (): GitHubWorkflowRun => ({ id: 7, head_sha: sha, path: WORKFLOW_PATH, display_title: `mcp-checks/${sha}/quick/push`,
  event: 'push', head_branch: 'mcp/123/work', status: 'completed', conclusion: 'success', html_url: '', created_at: '' });

describe('vérifications multi-dépôts', () => {
  it('nécessite le nouveau consentement et ne dépend pas de la liste historique', () => {
    const env = { GITHUB_AUTOMATION_ENABLED: 'true' } as AppEnv;
    expect(createToolContext(env, '123', ['mcp:read']).automationCoordinator).toBeUndefined();
    expect(createToolContext(env, '123', ['mcp:read', 'mcp:write']).automationCoordinator).toBeUndefined();
    expect(createToolContext(env, '123', ['mcp:read', 'mcp:automation']).automationCoordinator).toBeDefined();
    expect(createToolContext({} as AppEnv, '123', ['mcp:read', 'mcp:automation']).automationCoordinator).toBeUndefined();
  });
  it('reste désactivé sans activation globale explicite', () => {
    expect(automationEnabled()).toBe(false);
    expect(automationEnabled('true')).toBe(true);
    expect(() => automationEnabled('yes')).toThrow();
  });
  it('accepte des commandes de différents projets et exige un vrai profil quick', () => {
    expect(parsePlan(JSON.stringify({ version: 1, checks: { quick: ['python3 -m unittest'] } })).checks.quick).toEqual(['python3 -m unittest']);
    expect(() => parsePlan(JSON.stringify({ version: 1, checks: { quick: [] } }))).toThrow();
    expect(() => parsePlan(JSON.stringify({ version: 1, checks: { lint: ['true'] } }))).toThrow();
    expect(() => parsePlan(JSON.stringify({ ...plan, workingDirectory: '../outside' }))).toThrow();
  });
  it('ne transforme pas une écriture ordinaire en modification de workflow', () => {
    expect(() => validateChangeSet([{ path: WORKFLOW_PATH, content: MANAGED_WORKFLOW }])).toThrow();
    expect(() => validateChangeSet([{ path: WORKFLOW_PATH, content: MANAGED_WORKFLOW }], { managedChecks: true })).not.toThrow();
    expect(() => validateChangeSet([{ path: WORKFLOW_PATH, content: MANAGED_WORKFLOW + '\n# changed' }], { managedChecks: true })).toThrow();
    expect(() => validateChangeSet([{ path: '.github/workflows/deploy.yml', content: MANAGED_WORKFLOW }], { managedChecks: true })).toThrow();
    expect(() => assertWritablePath(WORKFLOW_PATH)).toThrow(); // Suppression toujours refusée.
  });
  it('génère un workflow fixe sans secrets, environnement, cache partagé ou runner privé', () => {
    expect(MANAGED_WORKFLOW).toContain('permissions:\n  contents: read');
    expect(MANAGED_WORKFLOW).toContain('persist-credentials: false');
    expect(MANAGED_WORKFLOW).toContain('runs-on: ubuntu-24.04');
    expect(MANAGED_WORKFLOW).toContain('package-manager-cache: false');
    expect(MANAGED_WORKFLOW).not.toMatch(/secrets\.|environment:|self-hosted|pull_request_target|actions\/cache/);
  });
  it('prévisualise sans écrire et conserve le workflow déjà conforme', async () => {
    const { coordinator, changes } = fixture();
    const result = await coordinator.prepare({ repository, branch: 'mcp/123/work', expectedHeadSha: sha, plan });
    expect(result).toMatchObject({ applied: false, changedPaths: [PLAN_PATH] });
    expect(changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it('ajoute workflow et plan dans un seul commit contrôlé par le SHA', async () => {
    const { coordinator, reads, changes } = fixture();
    reads.files.getTextFile.mockRejectedValue(new GitHubApiError(404, '', 'absent'));
    await expect(coordinator.prepare({ repository, branch: 'mcp/123/work', expectedHeadSha: sha, plan, apply: true })).resolves.toMatchObject({ applied: true });
    expect(changes.applyChangeSet).toHaveBeenCalledTimes(1);
    expect(changes.applyChangeSet.mock.calls[0]).toEqual([repository, 'mcp/123/work',
      [{ path: WORKFLOW_PATH, content: MANAGED_WORKFLOW }, { path: PLAN_PATH, content: JSON.stringify(plan, null, 2) + '\n' }],
      'ci: prepare managed project checks', { expectedHeadSha: sha }]);
  });
  it('ne masque pas un refus de permission par une création de fichier', async () => {
    const { coordinator, reads, changes } = fixture();
    reads.files.getTextFile.mockRejectedValue(new GitHubApiError(403, '', 'refus'));
    await expect(coordinator.prepare({ repository, branch: 'mcp/123/work', expectedHeadSha: sha, plan, apply: true })).rejects.toThrow();
    expect(changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it('refuse un dépôt retiré de l’installation avant de lire ses fichiers', async () => {
    const { coordinator, reads, dispatch } = fixture();
    reads.repositories.listInstallationRepositories.mockResolvedValue([]);
    await expect(coordinator.start(request)).rejects.toMatchObject({ code: 'REPOSITORY_DENIED' });
    expect(reads.files.getTextFile).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('refuse une branche tierce et la branche par défaut', async () => {
    const { coordinator, reads, changes } = fixture();
    await expect(coordinator.prepare({ repository, branch: 'mcp/999/work', expectedHeadSha: sha, plan, apply: true })).rejects.toThrow();
    reads.repositories.getRepository.mockResolvedValue({ full_name: repository, private: true, default_branch: 'mcp/123/work', archived: false });
    await expect(coordinator.prepare({ repository, branch: 'mcp/123/work', expectedHeadSha: sha, plan, apply: true })).rejects.toThrow();
    expect(changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it('refuse le remplacement d’un workflow existant différent', async () => {
    const { coordinator, reads, changes } = fixture();
    reads.files.getTextFile.mockResolvedValue({ path: WORKFLOW_PATH, content: 'name: custom', sha, size: 12 });
    await expect(coordinator.prepare({ repository, branch: 'mcp/123/work', expectedHeadSha: sha, plan, apply: true })).rejects.toMatchObject({ code: 'WORKFLOW_CONFLICT' });
    expect(changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it('réutilise le premier run push sans fusion ni dispatch', async () => {
    const { coordinator, actions, dispatch } = fixture();
    actions.listWorkflowRuns.mockResolvedValue([pushRun()]);
    await expect(coordinator.start(request)).resolves.toMatchObject({ reused: true, runId: 7, targetSha: sha });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('utilise la branche par défaut découverte, sans liste de dépôts ni SHA administrateur', async () => {
    const { coordinator, dispatch } = fixture();
    await coordinator.start({ repository, ref: 'feature/new', scope: 'lint' });
    expect(dispatch).toHaveBeenCalledWith(repository, 'main', {
      target_sha: sha, scope: 'lint', target: '', request_id: await automationKey({ ...request, scope: 'lint' }),
    });
  });
  it('bloque le dispatch si le workflow principal diffère', async () => {
    const { coordinator, reads, dispatch } = fixture();
    reads.files.getTextFile.mockImplementation(async (_repo, path) => ({ path, content: path === PLAN_PATH ? JSON.stringify(plan) : 'name: deploy', sha, size: 10 }));
    await expect(coordinator.start(request)).rejects.toMatchObject({ code: 'CHECKS_BOOTSTRAP_PENDING' });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('refuse un profil absent avant tout lancement', async () => {
    const { coordinator, dispatch } = fixture();
    await expect(coordinator.start({ ...request, scope: 'deploy' })).rejects.toMatchObject({ code: 'CHECK_PROFILE_MISSING' });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('ne lance rien si la branche a avancé ou si le plan est invalide', async () => {
    const { coordinator, reads, dispatch } = fixture();
    await expect(coordinator.start({ ...request, ref: 'main' })).rejects.toMatchObject({ code: 'HEAD_CHANGED' });
    reads.files.getTextFile.mockResolvedValue({ path: PLAN_PATH, content: '{', sha, size: 1 });
    await expect(coordinator.start(request)).rejects.toMatchObject({ code: 'CHECK_PLAN_INVALID' });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('la préparation nécessite aussi le consentement écriture, même sur une branche autorisée', async () => {
    const { reads, actions, dispatch } = fixture();
    const coordinator = new AutomationCoordinator('123', reads, actions, dispatch);
    await expect(coordinator.prepare({ repository, branch: 'mcp/123/work', expectedHeadSha: sha, plan, apply: true }))
      .rejects.toMatchObject({ code: 'WRITES_NOT_ENABLED' });
    expect(reads.repositories.listInstallationRepositories).not.toHaveBeenCalled();
  });
  it('refuse la provenance falsifiée et les jobs ignorés', async () => {
    const { coordinator, actions } = fixture();
    actions.getWorkflowRun.mockResolvedValue(pushRun());
    await expect(coordinator.result(request, 7)).resolves.toMatchObject({ verifiedSuccess: true });
    actions.listWorkflowRunJobs.mockResolvedValue([]);
    await expect(coordinator.result(request, 7)).resolves.toMatchObject({ verifiedSuccess: false });
    actions.getWorkflowRun.mockResolvedValue({ ...pushRun(), head_sha: controller });
    await expect(coordinator.result(request, 7)).rejects.toMatchObject({ code: 'CHECK_PROVENANCE_MISMATCH' });
  });
  it('ne rejoue pas un lancement réseau ambigu', async () => {
    const { coordinator, dispatch } = fixture();
    dispatch.mockRejectedValue(new GitHubApiError(0, '', 'network'));
    await expect(coordinator.start(request)).rejects.toMatchObject({ code: 'DISPATCH_RESULT_UNKNOWN' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
