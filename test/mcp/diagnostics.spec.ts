import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/github/client';
import { GitHubHttp } from '../../src/github/http';
import { InputValidationError } from '../../src/github/types';
import type { ToolContext } from '../../src/mcp/context';
import { safeDiagnostic } from '../../src/mcp/tools/github/reports';
import { collectCiStatus } from '../../src/mcp/tools/github/ci';
import { failureMessage, publicFailure, textPayload } from '../../src/mcp/tools/github/result';
import { mapLimit } from '../../src/mcp/tools/github/batch';
import { readJson } from '../../src/github/response';
import { SHA, OTHER, context } from './helpers';
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
        expect(() => textPayload({ data: 'x'.repeat(170000) })).toThrow('Résultat trop volumineux');
    });
    it('conserve les résultats de sources disponibles si une permission CI manque', async () => {
        const ctx = context();
        ctx.checks.listCheckRuns.mockRejectedValue(new GitHubApiError(422, '/app/installations/{id}/access_tokens', 'CANARY'));
        const result = await collectCiStatus(ctx as unknown as ToolContext, 'o/r', 'master');
        expect(result).toMatchObject({ sha: SHA, partial: true, availability: 'unknown', combinedState: null,
            githubCombinedState: 'pending', statusCount: 0 });
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
    it('distingue l’absence de CI du pending brut de GitHub', async () => {
        const result = await collectCiStatus(context() as unknown as ToolContext, 'o/r', SHA);
        expect(result).toMatchObject({ availability: 'no_checks', partial: false, combinedState: null,
            githubCombinedState: 'pending', statusCount: 0, checks: [], runs: [] });
        expect(result.note).toContain('Aucune vérification disponible');
    });
    it.each(['pending', 'success', 'failure'])('conserve un vrai commit status %s', async (state) => {
        const ctx = context();
        ctx.statuses.getCombinedStatus.mockResolvedValue({ state, total_count: 1,
            statuses: [{ context: 'external', state, description: null }] } as never);
        const result = await collectCiStatus(ctx as unknown as ToolContext, 'o/r', SHA);
        expect(result).toMatchObject({ availability: 'available', combinedState: state, statusCount: 1 });
    });
    it('un check réussi sans commit status ne devient pas pending', async () => {
        const ctx = context();
        ctx.checks.listCheckRuns.mockResolvedValue([{ id: 1, name: 'ci', head_sha: SHA,
                status: 'completed', conclusion: 'success' }] as never);
        const result = await collectCiStatus(ctx as unknown as ToolContext, 'o/r', SHA);
        expect(result).toMatchObject({ availability: 'available', combinedState: null,
            checks: [{ conclusion: 'success' }] });
    });
    it('n’annonce pas de CI si seuls un autre commit et un run agent-checks existent', async () => {
        const ctx = context();
        ctx.checks.listCheckRuns.mockResolvedValue([{ id: 1, head_sha: OTHER, conclusion: 'success' }] as never);
        ctx.workflows.listWorkflowRuns.mockResolvedValue([{ id: 2, head_sha: SHA,
                path: '.github/workflows/agent-checks.yml', conclusion: 'success' }] as never);
        const result = await collectCiStatus(ctx as unknown as ToolContext, 'o/r', SHA);
        expect(result).toMatchObject({ availability: 'no_checks', checks: [], runs: [] });
    });
    it('ne transforme pas une source statuses inaccessible en absence de CI', async () => {
        const ctx = context();
        ctx.statuses.getCombinedStatus.mockRejectedValue(new GitHubApiError(403, '/status', 'CANARY'));
        const result = await collectCiStatus(ctx as unknown as ToolContext, 'o/r', SHA);
        expect(result).toMatchObject({ availability: 'unknown', partial: true, statusCount: null,
            combinedState: null, githubCombinedState: null });
    });
    it('masque les secrets connus des annotations', () => {
        const result = safeDiagnostic('Bearer abc123 ghp_CANARY https://example/?token=CANARY&code=CANARY');
        expect(result).not.toContain('CANARY');
        expect(result).not.toContain('abc123');
    });
    it('borne la concurrence et conserve l’ordre', async () => {
        let active = 0;
        let max = 0;
        const output = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
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
