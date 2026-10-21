import { describe, expect, it } from 'vitest';
import { createOAuthFixture } from './helpers';

// CC-6 PR0 — mesures E2E SEULES (lecture seule, aucun changement du code fonctionnel).
// M0 : instructions initialize réellement renvoyées (octets UTF-8 et caractères).
// M1 : tools/list par outil (description) et tailles totales du catalogue.
// Les résultats sont émis sur stdout (visibles dans les logs CI) et consignés
// dans le store cc6-mcp-cleanup (evidence.add task p2) avant toute écriture PR1/PR2.

const { ORIGIN, settings, send, mcpSession, rpcResult } = createOAuthFixture();

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

const initialize = async (clientHeaders: Record<string, string>) => {
    const response = await send('/mcp', { method: 'POST', headers: clientHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
            protocolVersion: '2025-11-25', capabilities: {},
            clientInfo: { name: 'cc6-measure-client', version: '1' } } }) });
    expect(response.status).toBe(200);
    return response.text();
};

const listTools = async (headers: Record<string, string>, id: number) => {
    const response = await send('/mcp', { method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }) });
    expect(response.status).toBe(200);
    return response.text();
};

describe('CC-6 PR0 — mesures initialize/tools/list (E2E, lecture seule)', () => {
    it('M0 — mesure les instructions initialize en octets UTF-8 et caractères', async () => {
        const { headers } = await mcpSession('mcp:read offline_access');
        const body = await initialize({ ...headers, Origin: ORIGIN, 'MCP-Protocol-Version': '2025-11-25' });
        const result = rpcResult(body);
        const instructions = typeof result.instructions === 'string' ? result.instructions : '';
        const measure = { measure: 'M0', instructions_chars: instructions.length,
            instructions_utf8_bytes: byteLength(instructions),
            initialize_response_chars: body.length, initialize_response_utf8_bytes: byteLength(body) };
        // eslint-disable-next-line no-console
        console.log('CC6_PR0_MEASURE ' + JSON.stringify(measure));
        expect(typeof result.instructions).toBe('string');
        expect(instructions.length).toBeGreaterThan(0);
    });

    it('M1 — mesure tools/list par outil et tailles totales (catalogue lecture seule par défaut)', async () => {
        const { headers } = await mcpSession('mcp:read offline_access');
        const body = await listTools(headers, 1);
        const result = rpcResult(body);
        const tools = result.tools as Array<{ name: string; description?: string }>;
        const perTool = tools.map(tool => ({ name: tool.name,
            description_chars: (tool.description ?? '').length,
            description_utf8_bytes: byteLength(tool.description ?? ''),
            tool_json_utf8_bytes: byteLength(JSON.stringify(tool)) }));
        const measure = { measure: 'M1', variant: 'default_read_only', tool_count: tools.length,
            per_tool: perTool,
            total_description_utf8_bytes: perTool.reduce((sum, tool) => sum + tool.description_utf8_bytes, 0),
            tools_list_response_chars: body.length,
            tools_list_response_utf8_bytes: byteLength(body) };
        // eslint-disable-next-line no-console
        console.log('CC6_PR0_MEASURE ' + JSON.stringify(measure));
        expect(tools.length).toBeGreaterThan(0);
    });

    it('M1b — mesure tools/list avec toutes les familles d’outils activées', async () => {
        settings.GITHUB_WRITES_ENABLED = 'true';
        settings.GITHUB_AUTOMATION_ENABLED = 'true';
        try {
            const { headers } = await mcpSession('mcp:read mcp:write mcp:automation mcp:integration');
            const body = await listTools(headers, 1);
            const result = rpcResult(body);
            const tools = result.tools as Array<{ name: string; description?: string }>;
            const perTool = tools.map(tool => ({ name: tool.name,
                description_chars: (tool.description ?? '').length,
                description_utf8_bytes: byteLength(tool.description ?? ''),
                tool_json_utf8_bytes: byteLength(JSON.stringify(tool)) }));
            const measure = { measure: 'M1b', variant: 'all_families_enabled', tool_count: tools.length,
                per_tool: perTool,
                total_description_utf8_bytes: perTool.reduce((sum, tool) => sum + tool.description_utf8_bytes, 0),
                tools_list_response_chars: body.length,
                tools_list_response_utf8_bytes: byteLength(body) };
            // eslint-disable-next-line no-console
            console.log('CC6_PR0_MEASURE ' + JSON.stringify(measure));
            expect(tools.length).toBeGreaterThan(0);
        } finally {
            settings.GITHUB_WRITES_ENABLED = undefined;
            settings.GITHUB_AUTOMATION_ENABLED = undefined;
        }
    });
});
