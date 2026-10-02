import { describe, expect, it, vi } from 'vitest';
import { checkKey, CheckCoordinator, type CheckRequest } from '../src/checks/coordinator';
import { checksConfig } from '../src/checks/config';
import type { GitHubWorkflowRun } from '../src/github/types';
import { GitHubApiError } from '../src/github/types';
import { createToolContext } from '../src/mcp/context';
import type { AppEnv } from '../src/config';

const controller = 'a'.repeat(40);
const target = 'b'.repeat(40);
const config = [{ repository: 'owner/project', ref: 'master', controllerSha: controller }];
const input: CheckRequest = { repository: 'owner/project', sha: target, scope: 'unit', target: 'test/oauth/catalogue.spec.ts' };

async function fixture() {
  const reads = {
    repositories: { getRepository: vi.fn(async () => ({ full_name: input.repository, private: false, default_branch: 'master' })) },
    commits: { getCommit: vi.fn(async (_repo: string, ref: string) => ({ sha: ref === 'master' ? controller : ref, html_url: '', commit: { message: '' } })) },
  };
  const actions = {
    listWorkflowRuns: vi.fn(async () => [] as GitHubWorkflowRun[]),
    dispatchWorkflow: vi.fn(async () => ({ runId: 42, url: 'https://github.com/owner/project/actions/runs/42' })),
    getWorkflowRun: vi.fn(),
    listWorkflowRunJobs: vi.fn(async () => [{ id: 1, name: 'checks', status: 'completed', conclusion: 'success', html_url: null,
      steps: [{ name: 'Exécuter le plan de confiance sur la cible', status: 'completed', conclusion: 'success' }] }]),
  };
  const key = await checkKey(input, controller);
  const run: GitHubWorkflowRun = { id: 42, display_title: `agent-checks/${target}/unit/${key}`, path: '.github/workflows/agent-checks.yml',
    head_sha: controller, head_branch: 'master', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    html_url: 'https://github.com/owner/project/actions/runs/42', created_at: '2026-09-30T00:00:00Z' };
  return { reads, actions, key, run, coordinator: new CheckCoordinator(config, reads, actions) };
}

describe('checks: opt-in et identités', () => {
  it('configuration absente = aucun lancement', () => {
    expect(checksConfig()).toEqual([]);
    expect(() => checksConfig('[{"repository":"x"}]')).toThrow();
  });
  it('configuration ET scope sont nécessaires, un ancien jeton reste en lecture seule', () => {
    const env = { GITHUB_CHECKS_CONFIG: JSON.stringify(config) } as AppEnv;
    expect(createToolContext(env, '123', ['mcp:read']).checkCoordinator).toBeUndefined();
    expect(createToolContext({} as AppEnv, '123', ['mcp:read', 'mcp:checks']).checkCoordinator).toBeUndefined();
    expect(createToolContext(env, '123', ['mcp:read', 'mcp:checks']).checkCoordinator).toBeDefined();
  });
  it('la clé change avec le dépôt, SHA, cible, scope ou contrôleur', async () => {
    const key = await checkKey(input, controller);
    for (const changed of [{ ...input, repository: 'owner/other' }, { ...input, sha: controller },
      { ...input, target: 'test/security.spec.ts' }, { ...input, scope: 'quick' as const, target: '' }]) {
      expect(await checkKey(changed, controller)).not.toBe(key);
    }
    expect(await checkKey(input, target)).not.toBe(key);
    expect(await checkKey({ ...input, repository: 'OWNER/PROJECT', sha: target.toUpperCase() }, controller)).toBe(key);
  });
});

describe('checks: plan de confiance', () => {
  it.each([
    { ...input, repository: 'owner/other' }, { ...input, sha: 'master' },
    { ...input, target: '--config=evil' }, { ...input, target: 'test/../../secret.spec.ts' },
    { ...input, scope: 'full' as const },
  ])('rejette les paramètres avant tout appel GitHub : %j', async request => {
    const { coordinator, reads, actions } = await fixture();
    await expect(coordinator.start(request)).rejects.toThrow();
    expect(reads.commits.getCommit).not.toHaveBeenCalled();
    expect(actions.dispatchWorkflow).not.toHaveBeenCalled();
  });
  it('refuse le contrôleur déplacé', async () => {
    const { coordinator, reads, actions } = await fixture();
    reads.commits.getCommit.mockResolvedValue({ sha: target, html_url: '', commit: { message: '' } });
    await expect(coordinator.start(input)).rejects.toMatchObject({ code: 'CONTROLLER_CHANGED' });
    expect(actions.dispatchWorkflow).not.toHaveBeenCalled();
  });
  it('envoie le SHA cible séparément de la ref du contrôleur et retourne immédiatement', async () => {
    const { coordinator, actions, key } = await fixture();
    const result = await coordinator.start(input);
    expect(result).toMatchObject({ runId: 42, targetSha: target, controllerSha: controller, reused: false, nextPollSeconds: 15 });
    expect(actions.dispatchWorkflow).toHaveBeenCalledWith('owner/project', 'agent-checks.yml', 'master',
      { scope: 'unit', target_sha: target, target: input.target, request_id: key });
    expect(actions.getWorkflowRun).not.toHaveBeenCalled();
  });
  it('réutilise une exécution identique encore en cours', async () => {
    const { coordinator, actions, run } = await fixture();
    actions.listWorkflowRuns.mockResolvedValue([{ ...run, status: 'in_progress', conclusion: null }]);
    await expect(coordinator.start(input)).resolves.toMatchObject({ reused: true, runId: 42 });
    expect(actions.dispatchWorkflow).not.toHaveBeenCalled();
  });
  it('réutilise une réussite seulement si l’étape de tests a vraiment tourné', async () => {
    const { coordinator, actions, run } = await fixture();
    actions.listWorkflowRuns.mockResolvedValue([run]);
    await expect(coordinator.start(input)).resolves.toMatchObject({ reused: true, nextPollSeconds: null });
    expect(actions.listWorkflowRunJobs).toHaveBeenCalledWith(input.repository, run.id);
    expect(actions.dispatchWorkflow).not.toHaveBeenCalled();
  });
  it('un job entièrement ignoré ne constitue pas une réussite réutilisable', async () => {
    const { coordinator, actions, run } = await fixture();
    actions.listWorkflowRuns.mockResolvedValue([run]);
    actions.listWorkflowRunJobs.mockResolvedValue([]);
    await expect(coordinator.start(input)).resolves.toMatchObject({ reused: false });
  });
  it('un échec récent empêche de réutiliser une réussite plus ancienne', async () => {
    const { coordinator, actions, run } = await fixture();
    actions.listWorkflowRuns.mockResolvedValue([run, { ...run, id: 43, conclusion: 'failure' }]);
    await expect(coordinator.start(input)).resolves.toMatchObject({ reused: false });
  });
  it.each(['head_sha', 'path', 'display_title', 'event'] as const)('ne réutilise pas une exécution dont %s diffère', async field => {
    const { coordinator, actions, run } = await fixture();
    actions.listWorkflowRuns.mockResolvedValue([{ ...run, [field]: 'other' }]);
    await expect(coordinator.start(input)).resolves.toMatchObject({ reused: false });
  });
  it('ne conseille pas de relancer automatiquement après une panne réseau ambiguë du POST', async () => {
    const { coordinator, actions } = await fixture();
    actions.dispatchWorkflow.mockRejectedValue(new GitHubApiError(0, '/dispatches', 'CANARY'));
    await expect(coordinator.start(input)).rejects.toMatchObject({ code: 'DISPATCH_RESULT_UNKNOWN' });
    expect(actions.dispatchWorkflow).toHaveBeenCalledTimes(1);
  });
  it('vérifie la provenance à chaque lecture du résultat', async () => {
    const { coordinator, actions, run } = await fixture();
    actions.getWorkflowRun.mockResolvedValue(run);
    await expect(coordinator.result(input, 42)).resolves.toMatchObject({ targetSha: target, controllerSha: controller, verifiedSuccess: true });
    actions.getWorkflowRun.mockResolvedValue({ ...run, head_sha: target });
    await expect(coordinator.result(input, 42)).rejects.toMatchObject({ code: 'CHECK_PROVENANCE_MISMATCH' });
  });
});
