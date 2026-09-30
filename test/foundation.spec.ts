import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { GitHubClient, GitHubApiError } from '../src/github/client';
import { GitHubFiles } from '../src/github/files';
import { GitHubHttp } from '../src/github/http';
import type { GitHubServiceContext } from '../src/github/service-context';
import { InputValidationError } from '../src/github/types';
import { assertWritablePath } from '../src/security/policy';
import type { ToolContext } from '../src/mcp/context';
import { createToolContext } from '../src/mcp/context';
import type { AppEnv } from '../src/config';
import { registerCommitTools } from '../src/mcp/tools/github/commits';
import { registerProjectTools } from '../src/mcp/tools/github/project';
import { registerReportTools, safeDiagnostic } from '../src/mcp/tools/github/reports';
import { collectCiStatus } from '../src/mcp/tools/github/ci';
import { failureMessage, publicFailure, textPayload } from '../src/mcp/tools/github/result';
import { mapLimit } from '../src/mcp/tools/github/batch';
import { readJson } from '../src/github/response';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
type ToolResult = { isError?: boolean; structuredContent: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function registry(register: (server: McpServer, context: ToolContext) => void, context: ToolContext) {
  const handlers = new Map<string, Handler>();
  const fake = { registerTool: (name: string, _spec: unknown, handler: Handler) => handlers.set(name, handler) };
  register(fake as unknown as McpServer, context);
  return (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);
}

function context() {
  return {
    actor: '123',
    github: { repositories: { getRepository: vi.fn(async () => ({ default_branch: 'master' })) } },
    reads: {
      commits: { getCommit: vi.fn(async () => ({ sha: SHA })), compareRefs: vi.fn() },
      files: { getTextFile: vi.fn(async (_repo: string, path: string, _ref: string) =>
        ({ path, sha: OTHER, size: 8, content: 'one\ntwo\nthree\n' })),
      getRepositoryTree: vi.fn(async () => ({ truncated: false, entries: [] })) },
    },
    checks: { listCheckRuns: vi.fn(async () => []), listCheckAnnotations: vi.fn(async () => []) },
    statuses: { getCombinedStatus: vi.fn(async () => ({ state: 'pending', total_count: 0, statuses: [] })) },
    workflows: { listWorkflowRuns: vi.fn(async () => []), getWorkflowRun: vi.fn(), listWorkflowRunJobs: vi.fn(async () => []) },
  };
}

describe('foundation: diagnostics et cohérence', () => {
  it('borne les réponses GitHub même sans Content-Length', async () => {
    await expect(readJson(new Response('x'.repeat(100)), 20)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    await expect(readJson(new Response(JSON.stringify({ ok: true })), 20)).resolves.toEqual({ ok: true });
  });
  it('applique la version d’API explicite nécessaire au retour du runId', async () => {
    let headers: Headers | undefined;
    const http = new GitHubHttp({ apiVersion: '2026-03-10', userAgent: 'test', timeoutMs: 1000,
      getInstallationToken: async () => 'fake', fetcher: async (_input, init) => {
        headers = new Headers(init?.headers);
        return Response.json({ workflow_run_id: 42 });
      } });
    await expect(http.request('/repos/o/r/actions/workflows/agent-checks.yml/dispatches', { method: 'POST' }))
      .resolves.toEqual({ workflow_run_id: 42 });
    expect(headers?.get('X-GitHub-Api-Version')).toBe('2026-03-10');
  });
  it('une erreur Error arbitraire ne révèle pas son message', () => {
    expect(failureMessage(new Error('TOKEN_CANARY private URL'), 'Échec.')).toBe('Échec.');
    expect(failureMessage(new InputValidationError('Chemin invalide.'), 'Échec.')).toBe('Chemin invalide.');
  });
  it('diagnostique précisément un refus de permissions de jeton', () => {
    expect(publicFailure(new GitHubApiError(422, '/app/installations/{id}/access_tokens', 'CANARY')))
      .toMatchObject({ code: 'APP_PERMISSIONS_REJECTED', retryable: false });
    expect(JSON.stringify(publicFailure(new GitHubApiError(403, '/private', 'CANARY')))).not.toContain('CANARY');
  });
  it('borne les sorties et ne recopie pas un résultat trop gros', () => {
    expect(() => textPayload({ data: 'x'.repeat(170_000) })).toThrow('Résultat trop volumineux');
  });
  it('conserve les résultats de sources disponibles si une permission CI manque', async () => {
    const ctx = context();
    ctx.checks.listCheckRuns.mockRejectedValue(new GitHubApiError(422, '/app/installations/{id}/access_tokens', 'CANARY'));
    const result = await collectCiStatus(ctx as unknown as ToolContext, 'o/r', 'master');
    expect(result).toMatchObject({ sha: SHA, partial: true, combinedState: 'pending' });
    expect(result.unavailable[0]).toMatchObject({ source: 'checks', code: 'APP_PERMISSIONS_REJECTED' });
    expect(ctx.reads.commits.getCommit).toHaveBeenCalledTimes(1);
    expect(ctx.statuses.getCombinedStatus).toHaveBeenCalledWith('o/r', SHA);
    expect(ctx.workflows.listWorkflowRuns).toHaveBeenCalledWith('o/r', { headSha: SHA, limit: 30 });
  });
  it('ne confond pas une ancienne réussite avec le commit demandé', async () => {
    const ctx = context();
    ctx.workflows.listWorkflowRuns.mockResolvedValue([
      { id: 1, head_sha: OTHER, conclusion: 'success' }, { id: 2, head_sha: SHA, conclusion: 'failure' },
    ] as never);
    const result = await collectCiStatus(ctx as unknown as ToolContext, 'o/r', SHA);
    expect(result.runs.map(run => run.id)).toEqual([2]);
    expect(ctx.reads.commits.getCommit).not.toHaveBeenCalled();
  });
  it('masque les secrets connus des annotations', () => {
    const result = safeDiagnostic('Bearer abc123 ghp_CANARY https://example/?token=CANARY&code=CANARY');
    expect(result).not.toContain('CANARY');
    expect(result).not.toContain('abc123');
  });
  it('borne la concurrence et conserve l’ordre', async () => {
    let active = 0;
    let max = 0;
    const output = await mapLimit([1, 2, 3, 4, 5], 2, async n => {
      active++;
      max = Math.max(max, active);
      await Promise.resolve();
      active--;
      return n * 2;
    });
    expect(max).toBe(2);
    expect(output).toEqual([2, 4, 6, 8, 10]);
  });
});

describe('foundation: outils regroupés', () => {
  it('read_files résout une seule fois la branche et livre les lignes au même SHA', async () => {
    const ctx = context();
    const call = registry(registerProjectTools, ctx as unknown as ToolContext);
    const result = await call('github_read_files', { repository: 'o/r', ref: 'master',
      files: [{ path: 'a.ts', startLine: 2, endLine: 3 }, { path: 'b.ts', startLine: 1 }] });
    expect(result.structuredContent).toMatchObject({ sha: SHA, partial: false,
      files: [{ path: 'a.ts', content: '2: two\n3: three', blobSha: OTHER }, { path: 'b.ts' }] });
    expect(ctx.reads.commits.getCommit).toHaveBeenCalledTimes(1);
    expect(ctx.reads.files.getTextFile.mock.calls.every(args => args[2] === SHA)).toBe(true);
  });
  it('read_files renvoie les réussites et échecs séparément', async () => {
    const ctx = context();
    ctx.reads.files.getTextFile.mockRejectedValueOnce(new InputValidationError('Refusé.', 'SENSITIVE_FILE'));
    const call = registry(registerProjectTools, ctx as unknown as ToolContext);
    const result = await call('github_read_files', { repository: 'o/r', ref: SHA,
      files: [{ path: '.env', startLine: 1 }, { path: 'b.ts', startLine: 1 }] });
    expect(result.structuredContent).toMatchObject({ partial: true,
      files: [{ error: { code: 'SENSITIVE_FILE' } }, { path: 'b.ts', content: expect.any(String) }] });
  });
  it('read_files refuse une plage inversée avant de lire le fichier', async () => {
    const ctx = context();
    const result = await registry(registerProjectTools, ctx as unknown as ToolContext)('github_read_files',
      { repository: 'o/r', ref: SHA, files: [{ path: 'a.ts', startLine: 4, endLine: 2 }] });
    expect(result.structuredContent).toMatchObject({ partial: true, files: [{ error: { code: 'INVALID_RANGE' } }] });
    expect(ctx.reads.files.getTextFile).not.toHaveBeenCalled();
  });
  it('contexte conserve les métadonnées si contents manque', async () => {
    const ctx = context();
    ctx.reads.commits.getCommit.mockRejectedValue(new GitHubApiError(422, '/access_tokens', 'CANARY'));
    const result = await registry(registerProjectTools, ctx as unknown as ToolContext)('github_get_project_context', { repository: 'o/r' });
    expect(result.structuredContent).toMatchObject({ defaultBranch: 'master', partial: true,
      capabilities: { mutationsExposed: false }, error: { code: 'APP_PERMISSIONS_REJECTED' } });
  });
  it('le diff masque aussi les renommages issus de fichiers sensibles', async () => {
    const ctx = context();
    ctx.reads.commits.compareRefs.mockResolvedValue({ status: 'ahead', ahead_by: 1, behind_by: 0,
      total_commits: 1, commits: [], files: [
        { filename: '.env', patch: 'CANARY_1' },
        { filename: 'config.txt', previous_filename: '.env.production', patch: 'CANARY_2' },
        { filename: '.dev.vars', patch: 'CANARY_3' },
        { filename: 'src/app.ts', patch: '+ok' },
      ] });
    const result = await registry(registerCommitTools, ctx as unknown as ToolContext)('github_compare_refs',
      { repository: 'o/r', base: 'master', head: 'mcp/a/b' });
    expect(JSON.stringify(result)).not.toContain('CANARY');
    expect(result.structuredContent.files).toEqual([{ filename: 'src/app.ts', patch: '+ok' }]);
  });
  it('get_check_result refuse un commit différent de celui attendu', async () => {
    const ctx = context();
    ctx.workflows.getWorkflowRun.mockResolvedValue({ head_sha: OTHER });
    const result = await registry(registerReportTools, ctx as unknown as ToolContext)('github_get_check_result',
      { repository: 'o/r', runId: 1, expectedSha: SHA });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'COMMIT_MISMATCH' } } });
    expect(ctx.workflows.listWorkflowRunJobs).not.toHaveBeenCalled();
  });
  it('le rapport qualité ne se fie pas au nom d’un job Sonar inventé', async () => {
    const ctx = context();
    ctx.checks.listCheckRuns.mockResolvedValue([{ id: 1, name: 'SonarCloud', app: { slug: 'github-actions' }, conclusion: 'success' }] as never);
    const result = await registry(registerReportTools, ctx as unknown as ToolContext)('github_get_quality_report', { repository: 'o/r', ref: SHA });
    expect(result.structuredContent).toMatchObject({ available: false, checks: [] });
  });
  it('les annotations sensibles sont retirées, les autres sont bornées', async () => {
    const ctx = context();
    ctx.checks.listCheckRuns.mockResolvedValue([{ id: 1, name: 'unit', conclusion: 'failure', head_sha: SHA }] as never);
    ctx.checks.listCheckAnnotations.mockResolvedValue([
      { path: '.env', message: 'CANARY' }, { path: 'src/app.ts', message: 'x'.repeat(5_000) },
    ] as never);
    const result = await registry(registerReportTools, ctx as unknown as ToolContext)('github_get_failure_report', { repository: 'o/r', ref: SHA });
    expect(JSON.stringify(result)).not.toContain('CANARY');
    expect(ctx.checks.listCheckAnnotations).toHaveBeenCalledWith('o/r', 1, 10);
    expect(JSON.stringify(result).length).toBeLessThan(5_000);
  });
});

describe('foundation: lecture et transport', () => {
  let privateKey: string;
  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256',
      modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify']) as CryptoKeyPair;
    const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer;
    privateKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END PRIVATE KEY-----`;
  });

  function clientWithTree(entry: Record<string, unknown>, treeExtra = {}) {
    const calls: string[] = [];
    const client = new GitHubClient({ appId: '1', installationId: '2', privateKey,
      fetcher: async input => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/access_tokens')) return Response.json({ token: 'fake' });
        if (url.includes('/git/trees/')) return Response.json({ tree: [entry], truncated: false, ...treeExtra });
        if (url.includes('/git/blobs/')) return Response.json({ content: btoa('ok'), encoding: 'base64', size: 2 });
        return new Response(null, { status: 404 });
      } });
    return { client, calls };
  }
  it.each(['120000', '160000'])('refuse un lien/sous-module avant le blob : %s', async mode => {
    const { client, calls } = clientWithTree({ path: 'safe.txt', type: mode === '160000' ? 'commit' : 'blob', mode, sha: SHA, size: 2 });
    await expect(client.files.getTextFile('o/r', 'safe.txt', SHA)).rejects.toThrow('liens symboliques');
    expect(calls.some(url => url.includes('/git/blobs/'))).toBe(false);
  });
  it('refuse un fichier surdimensionné avant téléchargement du blob', async () => {
    const { client, calls } = clientWithTree({ path: 'safe.txt', type: 'blob', mode: '100644', sha: SHA, size: 1_000_001 });
    await expect(client.files.getTextFile('o/r', 'safe.txt', SHA)).rejects.toThrow('volumineux');
    expect(calls.some(url => url.includes('/git/blobs/'))).toBe(false);
  });
  it('refuse un arbre tronqué', async () => {
    const { client } = clientWithTree({ path: 'safe.txt', type: 'blob', mode: '100644', sha: SHA, size: 2 }, { truncated: true });
    await expect(client.files.getTextFile('o/r', 'safe.txt', SHA)).rejects.toThrow('incomplet');
  });
  it('partage les requêtes d’arbre parallèles du même appel', async () => {
    const { client, calls } = clientWithTree({ path: 'safe.txt', type: 'blob', mode: '100644', sha: SHA, size: 2 });
    await Promise.all([client.files.getTextFile('o/r', 'safe.txt', SHA), client.files.getTextFile('o/r', 'safe.txt', SHA)]);
    expect(calls.filter(url => url.includes('/git/trees/'))).toHaveLength(1);
    expect(calls.filter(url => url.endsWith('/access_tokens'))).toHaveLength(1);
  });
  it('refuse une recherche qui tente de changer le dépôt', async () => {
    const request = vi.fn();
    const files = new GitHubFiles({ request } as unknown as GitHubServiceContext);
    await expect(files.searchCode('o/r', 'secret repo:someone/else')).rejects.toThrow('limitée au dépôt');
    expect(request).not.toHaveBeenCalled();
  });
  it('filtre les réponses de recherche qui appartiennent à un autre dépôt', async () => {
    const files = new GitHubFiles({
      request: async () => ({ items: [{ path: 'safe.txt', repository: { full_name: 'other/repo' } }] }),
      repoPath: () => '', splitRepository: () => ({ owner: 'o', name: 'r' }), withQuery: (p: string) => p,
    } as unknown as GitHubServiceContext);
    await expect(files.searchCode('o/r', 'hello')).resolves.toEqual([]);
  });
  it('ne suit aucune redirection avec le jeton de dépôt', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://external.invalid/secret' } }));
    const http = new GitHubHttp({ fetcher, userAgent: 'test', timeoutMs: 1000, getInstallationToken: async () => 'CANARY' });
    await expect(http.request('/repos/o/r')).rejects.toThrow('Redirection GitHub refusée');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://api.github.com/repos/o/r', expect.objectContaining({ redirect: 'manual' }));
  });
  it('une permission Actions manquante ne bloque pas contents', async () => {
    const permissions: unknown[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/access_tokens')) {
        const permission = JSON.parse(String(init?.body)).permissions;
        permissions.push(permission);
        return permission.actions ? new Response(null, { status: 422 }) : Response.json({ token: 'fake' });
      }
      return Response.json({ sha: SHA });
    });
    try {
      const ctx = createToolContext({ GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2', GITHUB_PRIVATE_KEY: privateKey } as AppEnv, '123');
      await expect(ctx.workflows.listWorkflowRuns('o/r')).rejects.toMatchObject({ status: 422 });
      await expect(ctx.reads.commits.getCommit('o/r', 'master')).resolves.toMatchObject({ sha: SHA });
      expect(permissions).toEqual([{ metadata: 'read', actions: 'read' }, { metadata: 'read', contents: 'read' }]);
    } finally { spy.mockRestore(); }
  });
  it('dispatch est refusé par défaut et ne peut pas viser un autre workflow/ref', async () => {
    let calls = 0;
    const make = (allowedWorkflows: string[] = [], allowedWorkflowRefs: string[] = []) => new GitHubClient({
      appId: '1', installationId: '2', privateKey, allowedWorkflows, allowedWorkflowRefs,
      fetcher: async () => { calls++; return Response.json({}); },
    });
    await expect(make().actions.dispatchWorkflow('o/r', 'agent-checks.yml', 'master')).rejects.toThrow('non autorisé');
    await expect(make(['agent-checks.yml'], ['master']).actions.dispatchWorkflow('o/r', 'deploy.yml', 'master')).rejects.toThrow('non autorisé');
    await expect(make(['agent-checks.yml'], ['master']).actions.dispatchWorkflow('o/r', 'agent-checks.yml', 'mcp/a/b')).rejects.toThrow('non autorisé');
    expect(calls).toBe(0);
  });
  it('renvoie le runId de GitHub après un dispatch autorisé', async () => {
    const client = new GitHubClient({ appId: '1', installationId: '2', privateKey,
      apiVersion: '2026-03-10', allowedWorkflows: ['agent-checks.yml'], allowedWorkflowRefs: ['master'],
      fetcher: async input => String(input).endsWith('/access_tokens') ? Response.json({ token: 'fake' }) :
        Response.json({ workflow_run_id: 42, html_url: 'https://github.com/o/r/actions/runs/42' }) });
    await expect(client.actions.dispatchWorkflow('o/r', 'agent-checks.yml', 'master')).resolves.toEqual({
      runId: 42, url: 'https://github.com/o/r/actions/runs/42' });
  });
  it.each(['directory', 'symlink', 'head_changed'])('refuse une modification non vérifiable avant toute écriture : %s', async scenario => {
    let writes = 0;
    const client = new GitHubClient({ appId: '1', installationId: '2', privateKey,
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/access_tokens')) return Response.json({ token: 'fake' });
        if (init?.method === 'POST' || init?.method === 'PATCH') writes++;
        if (url.includes('/git/ref/')) return Response.json({ object: { sha: SHA } });
        if (url.includes('/git/commits/')) return Response.json({ tree: { sha: OTHER } });
        return Response.json({ tree: [{ path: 'src', sha: OTHER, type: scenario === 'directory' ? 'tree' : 'blob',
          mode: scenario === 'directory' ? '040000' : '120000' }] });
      } });
    await expect(client.changes.applyChangeSet('o/r', 'mcp/test/fix', [{ path: 'src', content: 'bad' }], 'test',
      { expectedHeadSha: scenario === 'head_changed' ? OTHER : SHA })).rejects.toThrow();
    expect(writes).toBe(0);
  });
});

it.each(['.github', '.github/workflows/ci.yml', '.github/actions/setup/action.yml', '.github/CODEOWNERS', 'scripts', 'scripts/ci/run-checks.mjs'])
('le MCP ne peut pas modifier le contrôleur : %s', path => {
  expect(() => assertWritablePath(path)).toThrow('GitHub Actions');
});
