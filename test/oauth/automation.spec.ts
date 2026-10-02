import { describe, expect, it, vi } from 'vitest';
import { MANAGED_WORKFLOW, WORKFLOW_PATH, EXECUTE_STEP } from '../../src/automation/workflow';
import { PLAN_PATH } from '../../src/automation/plan';
import { automationKey } from '../../src/automation/coordinator';
import { createOAuthFixture } from './helpers';
const { settings, send, consent, mcpSession, rpcResult, callTool, contentsFile, toolJson } = createOAuthFixture();
describe('Vérifications avec consentement distinct', () => {
    it('n’accorde pas run_checks aux jetons de lecture existants même après activation serveur', async () => {
        const { headers } = await mcpSession();
        settings.GITHUB_CHECKS_CONFIG = JSON.stringify([{ repository: 'owner/project', ref: 'master', controllerSha: 'a'.repeat(40) }]);
        try {
            const listed = await send('/mcp', { method: 'POST', headers,
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
            expect(await listed.text()).not.toContain('github_run_checks');
            const api = vi.spyOn(globalThis, 'fetch');
            const result = await callTool(headers, 'github_run_checks', { repository: 'owner/project', sha: 'b'.repeat(40) }, 2);
            expect(result.body).not.toContain('runId');
            expect(api).not.toHaveBeenCalled();
        }
        finally {
            delete settings.GITHUB_CHECKS_CONFIG;
        }
    });
    it('expose run_checks seulement après consentement explicite et le retire à la désactivation', async () => {
        settings.GITHUB_CHECKS_CONFIG = JSON.stringify([{ repository: 'owner/project', ref: 'master', controllerSha: 'a'.repeat(40) }]);
        try {
            const approval = await consent('mcp:read mcp:checks offline_access');
            expect(approval.html).toContain('minutes GitHub Actions');
            const { headers } = await mcpSession('mcp:read mcp:checks offline_access');
            const list = () => send('/mcp', { method: 'POST', headers,
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
            const catalogue = await (await list()).text();
            expect(catalogue).toContain('github_run_checks');
            const tools = rpcResult(catalogue).tools as Array<{
                name: string;
                _meta: {
                    securitySchemes: unknown;
                };
            }>;
            expect(tools.find(tool => tool.name === 'github_run_checks')?._meta.securitySchemes)
                .toEqual([{ type: 'oauth2', scopes: ['mcp:read', 'mcp:checks'] }]);
            delete settings.GITHUB_CHECKS_CONFIG;
            expect(await (await list()).text()).not.toContain('github_run_checks');
        }
        finally {
            delete settings.GITHUB_CHECKS_CONFIG;
        }
    });
    it('le mode multi-dépôts ne donne aucun pouvoir nouveau aux anciens jetons', async () => {
        const { headers } = await mcpSession();
        settings.GITHUB_AUTOMATION_ENABLED = 'true';
        try {
            const listed = await send('/mcp', { method: 'POST', headers,
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
            expect(await listed.text()).not.toContain('github_prepare_checks');
            const api = vi.spyOn(globalThis, 'fetch');
            await callTool(headers, 'github_prepare_checks', {}, 2);
            expect(api).not.toHaveBeenCalled();
        }
        finally {
            delete settings.GITHUB_AUTOMATION_ENABLED;
        }
    });
    it('le nouveau consentement expose les vérifications et la désactivation les retire', async () => {
        settings.GITHUB_AUTOMATION_ENABLED = 'true';
        try {
            const approval = await consent('mcp:read mcp:automation offline_access');
            expect(approval.html).toContain('y compris ceux ajoutés ultérieurement');
            const { headers } = await mcpSession('mcp:read mcp:automation offline_access');
            const list = () => send('/mcp', { method: 'POST', headers,
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
            const text = await (await list()).text();
            expect(text).toContain('github_prepare_checks');
            expect(text).toContain('github_run_checks');
            expect(text).not.toContain('github_commit_changes');
            const result = await callTool(headers, 'github_prepare_checks', {
                repository: 'other/workbench', branch: 'mcp/123/test', expectedHeadSha: 'a'.repeat(40),
                plan: { version: 1, checks: { quick: ['npm test'] } }, apply: true,
            }, 2);
            expect(result.body).toContain('WRITES_NOT_ENABLED');
            settings.GITHUB_AUTOMATION_ENABLED = 'false';
            expect(await (await list()).text()).not.toContain('github_run_checks');
        }
        finally {
            delete settings.GITHUB_AUTOMATION_ENABLED;
        }
        expect((await send('/ready', {}, { ...settings, GITHUB_AUTOMATION_ENABLED: 'yes' })).status).toBe(503);
    });
    it('parcours multi-dépôts MCP : préparation atomique, premier run push et dispatch corrélé', async () => {
        settings.GITHUB_AUTOMATION_ENABLED = 'true';
        settings.GITHUB_WRITES_ENABLED = 'true';
        try {
            const { headers } = await mcpSession('mcp:read mcp:automation mcp:write offline_access');
            const repository = 'other/workbench', branch = 'mcp/123/test';
            const base = 'a'.repeat(40), next = 'b'.repeat(40), workflowBlob = 'c'.repeat(40), planBlob = 'd'.repeat(40);
            const tree = 'e'.repeat(40), githubTree = '1'.repeat(40), mcpTree = '2'.repeat(40), workflowsTree = '3'.repeat(40);
            const plan = { version: 1, workingDirectory: '.', install: [], checks: { quick: ['python3 -m unittest'], lint: ['python3 -m compileall src'] } };
            const planContent = JSON.stringify(plan, null, 2) + '\n';
            let head = base, principalHasWorkflow = false;
            const bodies: Array<{
                method: string;
                path: string;
                body: Record<string, unknown>;
            }> = [];
            const permissions: unknown[] = [];
            const push = { id: 7, path: WORKFLOW_PATH, head_sha: next, head_branch: branch, event: 'push',
                display_title: `mcp-checks/${next}/quick/push`, status: 'completed', conclusion: 'success', html_url: 'https://github.com/other/workbench/actions/runs/7' };
            let manualTitle = '';
            vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
                const url = new URL(String(input)), method = init?.method ?? 'GET';
                const body = init?.body ? JSON.parse(String(init.body)) : {};
                if (url.pathname.endsWith('/access_tokens')) {
                    permissions.push(body.permissions);
                    return Response.json({ token: 'installation-token' });
                }
                if (method !== 'GET')
                    bodies.push({ method, path: url.pathname, body });
                if (url.pathname === '/installation/repositories')
                    return Response.json({ repositories: [{ full_name: repository }] });
                if (url.pathname === `/repos/${repository}`)
                    return Response.json({ full_name: repository, default_branch: 'main' });
                if (url.pathname.includes('/git/ref/heads/'))
                    return Response.json({ object: { sha: head } });
                if (url.pathname.endsWith(`/git/commits/${base}`))
                    return Response.json({ tree: { sha: tree } });
                if (url.pathname.endsWith('/git/trees') && method === 'POST')
                    return Response.json({ sha: tree });
                if (url.pathname.endsWith('/git/commits') && method === 'POST')
                    return Response.json({ sha: next });
                if (url.pathname.includes('/git/refs/heads/') && method === 'PATCH') {
                    head = next;
                    return Response.json({});
                }
                if (url.pathname.endsWith(`/git/trees/${base}`) || url.pathname.endsWith(`/git/trees/${tree}`))
                    return Response.json({ tree: [], truncated: false });
                if (url.pathname.endsWith(`/git/trees/${next}`))
                    return Response.json({ tree: [
                            { path: '.github', type: 'tree', mode: '040000', sha: githubTree },
                            { path: '.mcp', type: 'tree', mode: '040000', sha: mcpTree },
                        ] });
                if (url.pathname.endsWith(`/git/trees/${githubTree}`))
                    return Response.json({ tree: [{ path: 'workflows', type: 'tree', mode: '040000', sha: workflowsTree }] });
                if (url.pathname.endsWith(`/git/trees/${workflowsTree}`))
                    return Response.json({ tree: [{ path: 'mcp-checks.yml', type: 'blob', mode: '100644', sha: workflowBlob, size: new TextEncoder().encode(MANAGED_WORKFLOW).length }] });
                if (url.pathname.endsWith(`/git/trees/${mcpTree}`))
                    return Response.json({ tree: [{ path: 'checks.json', type: 'blob', mode: '100644', sha: planBlob, size: planContent.length }] });
                if (url.pathname.endsWith(`/git/blobs/${workflowBlob}`))
                    return contentsFile(WORKFLOW_PATH, MANAGED_WORKFLOW);
                if (url.pathname.endsWith(`/git/blobs/${planBlob}`))
                    return contentsFile(PLAN_PATH, planContent);
                if (url.pathname.includes('/commits/'))
                    return Response.json({ sha: url.pathname.endsWith('/main') ? (principalHasWorkflow ? next : base) : next });
                if (url.pathname.endsWith('/actions/runs'))
                    return Response.json({ workflow_runs: [push] });
                if (url.pathname.endsWith('/jobs'))
                    return Response.json({ jobs: [{ id: 1, name: 'checks', status: 'completed', conclusion: 'success',
                                steps: [{ name: EXECUTE_STEP, status: 'completed', conclusion: 'success' }] }] });
                if (url.pathname.endsWith('/actions/runs/7'))
                    return Response.json(push);
                if (url.pathname.endsWith('/actions/runs/8'))
                    return Response.json({ ...push, id: 8, event: 'workflow_dispatch', display_title: manualTitle, head_branch: 'main' });
                if (url.pathname.endsWith('/dispatches')) {
                    manualTitle = `mcp-checks/${next}/lint/${(body.inputs as Record<string, string>).request_id}`;
                    return Response.json({ workflow_run_id: 8, html_url: 'https://github.com/other/workbench/actions/runs/8' });
                }
                throw new Error('Unexpected GitHub request');
            });
            const preview = await callTool(headers, 'github_prepare_checks', { repository, branch, expectedHeadSha: base, plan }, 1);
            expect(toolJson(preview.body)).toMatchObject({ applied: false, changedPaths: [WORKFLOW_PATH, PLAN_PATH] });
            expect(bodies).toEqual([]);
            const applied = await callTool(headers, 'github_prepare_checks', { repository, branch, expectedHeadSha: base, plan, apply: true }, 2);
            expect(toolJson(applied.body)).toMatchObject({ applied: true, commitSha: next });
            expect(bodies.map(item => item.method)).toEqual(['POST', 'POST', 'PATCH']);
            expect(bodies[0].body).toMatchObject({ tree: [{ path: WORKFLOW_PATH, content: MANAGED_WORKFLOW }, { path: PLAN_PATH, content: planContent }] });
            const reused = await callTool(headers, 'github_run_checks', { repository, ref: branch }, 3);
            expect(toolJson(reused.body)).toMatchObject({ reused: true, runId: 7, sha: next });
            const success = await callTool(headers, 'github_get_agent_check_result', { repository, sha: next, runId: 7 }, 4);
            expect(toolJson(success.body)).toMatchObject({ verifiedSuccess: true, targetSha: next });
            principalHasWorkflow = true;
            const dispatched = await callTool(headers, 'github_run_checks', { repository, ref: branch, scope: 'lint' }, 5);
            expect(toolJson(dispatched.body)).toMatchObject({ reused: false, runId: 8 });
            const verified = await callTool(headers, 'github_get_agent_check_result', { repository, sha: next, scope: 'lint', runId: 8 }, 6);
            expect(toolJson(verified.body)).toMatchObject({ verifiedSuccess: true });
            expect(bodies.at(-1)?.body).toEqual({ ref: 'main', inputs: {
                    target_sha: next, scope: 'lint', target: '', request_id: await automationKey({ repository, sha: next, scope: 'lint', target: '' }),
                } });
            expect(permissions).toContainEqual({ metadata: 'read', contents: 'write', workflows: 'write' });
            expect(permissions).toContainEqual({ metadata: 'read', actions: 'write' });
            expect(JSON.stringify(permissions)).not.toContain('administration');
        }
        finally {
            delete settings.GITHUB_AUTOMATION_ENABLED;
            delete settings.GITHUB_WRITES_ENABLED;
        }
    });
});
