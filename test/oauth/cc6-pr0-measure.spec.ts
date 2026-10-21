import { describe, expect, it } from 'vitest';
import { createOAuthFixture } from './helpers';

// CC-6 PR0 — mesures E2E SEULES (lecture seule, aucun changement du code fonctionnel).
// M0 : instructions initialize réellement renvoyées (octets UTF-8 et caractères).
// M1/M1b : tools/list par outil (description) et tailles totales du catalogue,
// en configuration lecture seule par défaut puis avec toutes les familles activées.
// Les résultats sont émis sur stdout (visibles dans les logs CI) et consignés
// dans le store cc6-mcp-cleanup (evidence.add task p2) avant toute écriture PR1/PR2.

const { ORIGIN, settings, send, mcpSession, rpcResult } = createOAuthFixture();

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

interface NamedTool { name: string; description?: string }

const measureToolList = (body: string) => {
    const tools = (rpcResult(body).tools ?? []) as NamedTool[];
    const perTool = tools.map(tool => ({ name: tool.name,
        description_chars: (tool.description ?? '').length,
        description_utf8_bytes: byteLength(tool.description ?? ''),
        tool_json_utf8_bytes: byteLength(JSON.stringify(tool)) }));
    return { tool_count: tools.length, per_tool: perTool,
        total_description_utf8_bytes: perTool.reduce((sum, tool) => sum + tool.description_utf8_bytes, 0),
        tools_list_response_chars: body.length, tools_list_response_utf8_bytes: byteLength(body) };
};

describe('CC-6 PR0 — mesures initialize/tools/list (E2E, lecture seule)', () => {
    it('M0 — mesure les instructions initialize en octets UTF-8 et caractères', async () => {
        const { headers } = await mcpSession('mcp:read offline_access');
        const response = await send('/mcp', { method: 'POST',
            headers: { ...headers, Origin: ORIGIN, 'MCP-Protocol-Version': '2025-11-25' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
                protocolVersion: '2025-11-25', capabilities: {},
                clientInfo: { name: 'cc6-measure-client', version: '1' } } }) });
        expect(response.status).toBe(200);
        const body = await response.text();
        const result = rpcResult(body);
        const instructions = typeof result.instructions === 'string' ? result.instructions : '';
        // eslint-disable-next-line no-console
        console.log('CC6_PR0_MEASURE ' + JSON.stringify({ measure: 'M0',
            instructions_chars: instructions.length, instructions_utf8_bytes: byteLength(instructions),
            initialize_response_chars: body.length, initialize_response_utf8_bytes: byteLength(body) }));
        expect(typeof result.instructions).toBe('string');
        expect(instructions.length).toBeGreaterThan(0);
    });

    it.each([
        { measure: 'M1', variant: 'default_read_only', scope: 'mcp:read offline_access', allFamilies: false },
        { measure: 'M1b', variant: 'all_families_enabled', scope: 'mcp:read mcp:write mcp:automation mcp:integration', allFamilies: true },
    ])('%s — mesure tools/list par outil et tailles totales (%s)', async ({ measure, variant, scope, allFamilies }) => {
        if (allFamilies) {
            settings.GITHUB_WRITES_ENABLED = 'true';
            settings.GITHUB_AUTOMATION_ENABLED = 'true';
        }
        try {
            const { headers } = await mcpSession(scope);
            const response = await send('/mcp', { method: 'POST', headers,
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
            expect(response.status).toBe(200);
            const measured = measureToolList(await response.text());
            // eslint-disable-next-line no-console
            console.log('CC6_PR0_MEASURE ' + JSON.stringify({ measure, variant, ...measured }));
            expect(measured.tool_count).toBeGreaterThan(0);
        } finally {
            if (allFamilies) {
                settings.GITHUB_WRITES_ENABLED = undefined;
                settings.GITHUB_AUTOMATION_ENABLED = undefined;
            }
        }
    });
});
