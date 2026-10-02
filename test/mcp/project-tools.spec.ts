import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/github/client';
import { InputValidationError } from '../../src/github/types';
import type { ToolContext } from '../../src/mcp/context';
import { registerCommitTools } from '../../src/mcp/tools/github/commits';
import { registerProjectTools } from '../../src/mcp/tools/github/project';
import { registerFileTools } from '../../src/mcp/tools/github/files';
import { registerReportTools } from '../../src/mcp/tools/github/reports';
import { SHA, OTHER, registry, context } from './helpers';
describe('foundation: outils regroupés', () => {
    it.each([
        ['github_get_project_context', registerProjectTools],
        ['github_get_project_guide', registerFileTools],
    ] as const)('%s inclut la mémoire au même SHA et signale sa troncature', async (name, register) => {
        const ctx = context();
        ctx.reads.files.getTextFile.mockImplementation(async (_repo, path) => ({ path, sha: OTHER, size: 20000,
            content: path === 'AGENT_MEMORY.md' ? 'Mémoire\n'.repeat(4000) : 'Guide' }));
        const result = await registry(register, ctx as unknown as ToolContext)(name, { repository: 'o/r', ref: 'master' });
        expect(result.structuredContent).toMatchObject({ sha: SHA,
            documents: expect.arrayContaining([expect.objectContaining({ path: 'AGENT_MEMORY.md', truncated: true })]) });
        expect(ctx.reads.files.getTextFile).toHaveBeenCalledWith('o/r', 'AGENT_MEMORY.md', SHA);
    });
    it('une mémoire absente ne bloque pas la lecture du contexte', async () => {
        const ctx = context();
        ctx.reads.files.getTextFile.mockImplementation(async (_repo, path) => {
            if (path === 'AGENT_MEMORY.md')
                throw new GitHubApiError(404, '/git/trees', 'Absent');
            return { path, sha: OTHER, size: 5, content: 'Guide' };
        });
        const result = await registry(registerProjectTools, ctx as unknown as ToolContext)('github_get_project_context', { repository: 'o/r' });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ partial: true, documents: expect.arrayContaining([
                expect.objectContaining({ path: 'AGENT_MEMORY.md', error: expect.any(Object) }),
                expect.objectContaining({ path: 'README.md', content: 'Guide' }),
            ]) });
    });
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
        const result = await registry(registerProjectTools, ctx as unknown as ToolContext)('github_read_files', { repository: 'o/r', ref: SHA, files: [{ path: 'a.ts', startLine: 4, endLine: 2 }] });
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
                { filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, patch: '+ok' },
            ] });
        const result = await registry(registerCommitTools, ctx as unknown as ToolContext)('github_compare_refs', { repository: 'o/r', base: 'master', head: 'mcp/a/b' });
        expect(JSON.stringify(result)).not.toContain('CANARY');
        expect(result.structuredContent.files).toEqual([{ filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, patch: '+ok' }]);
    });
    it('get_check_result refuse un commit différent de celui attendu', async () => {
        const ctx = context();
        ctx.workflows.getWorkflowRun.mockResolvedValue({ head_sha: OTHER });
        const result = await registry(registerReportTools, ctx as unknown as ToolContext)('github_get_check_result', { repository: 'o/r', runId: 1, expectedSha: SHA });
        expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'COMMIT_MISMATCH' } } });
        expect(ctx.workflows.listWorkflowRunJobs).not.toHaveBeenCalled();
    });
    it('le rapport qualité ne se fie pas au nom d’un job Sonar inventé', async () => {
        const ctx = context();
        ctx.checks.listCheckRuns.mockResolvedValue([{ id: 1, name: 'SonarCloud', app: { slug: 'github-actions' }, conclusion: 'success' }] as never);
        const result = await registry(registerReportTools, ctx as unknown as ToolContext)('github_get_quality_report', { repository: 'o/r', ref: SHA });
        expect(result.structuredContent).toMatchObject({ available: false, checks: [] });
    });
    it.each(['sonarqubecloud', 'sonarcloud', 'sonarqube', 'sonarqube-cloud'])('reconnaît le fournisseur Sonar %s au bon commit', async (slug) => {
        const ctx = context();
        ctx.checks.listCheckRuns.mockResolvedValue([{ id: 1, name: 'SonarCloud Code Analysis',
                app: { slug }, head_sha: SHA, status: 'completed', conclusion: 'success', html_url: null,
                output: { summary: 'Quality Gate passed' } }] as never);
        const result = await registry(registerReportTools, ctx as unknown as ToolContext)('github_get_quality_report', { repository: 'o/r', ref: SHA });
        expect(result.structuredContent).toMatchObject({ available: true,
            checks: [{ name: 'SonarCloud Code Analysis', conclusion: 'success', summary: 'Quality Gate passed' }] });
    });
    it('ne reprend pas le rapport Sonar d’un autre commit', async () => {
        const ctx = context();
        ctx.checks.listCheckRuns.mockResolvedValue([{ id: 1, app: { slug: 'sonarqubecloud' },
                head_sha: OTHER, conclusion: 'success' }] as never);
        const result = await registry(registerReportTools, ctx as unknown as ToolContext)('github_get_quality_report', { repository: 'o/r', ref: SHA });
        expect(result.structuredContent).toMatchObject({ available: false, checks: [] });
    });
    it('les annotations sensibles sont retirées, les autres sont bornées', async () => {
        const ctx = context();
        ctx.checks.listCheckRuns.mockResolvedValue([{ id: 1, name: 'unit', conclusion: 'failure', head_sha: SHA, html_url: null }] as never);
        ctx.checks.listCheckAnnotations.mockResolvedValue([
            { path: '.env', message: 'CANARY' }, { path: 'src/app.ts', start_line: 1, end_line: 1,
                annotation_level: 'failure', message: 'x'.repeat(5000) },
        ] as never);
        const result = await registry(registerReportTools, ctx as unknown as ToolContext)('github_get_failure_report', { repository: 'o/r', ref: SHA });
        expect(JSON.stringify(result)).not.toContain('CANARY');
        expect(ctx.checks.listCheckAnnotations).toHaveBeenCalledWith('o/r', 1, 10);
        expect(JSON.stringify(result).length).toBeLessThan(5000);
    });
});
