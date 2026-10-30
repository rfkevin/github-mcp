import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createOAuthFixture } from '../../oauth/helpers';

// CC-3 C2 : isolement des catalogues. Le store est monté sur COLLAB_DB_C2
// (schéma canonique) ; COLLAB_DB garde le schéma proto C0 et n'est pas utilisé.
const bindings = env as unknown as { COLLAB_DB_C2: D1Database };

describe('CC-3 C2 — isolement des catalogues /collab/mcp', () => {
  it('le catalogue GitHub est strictement inchangé (aucun outil collab_*)', async () => {
    const fixture = createOAuthFixture({ COLLAB_DB: bindings.COLLAB_DB_C2, COLLAB_STORE_ENABLED: 'true' });
    const session = await fixture.mcpSession();
    const response = await fixture.send('/mcp', { method: 'POST', headers: session.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const result = fixture.rpcResult(await response.text()) as { tools: Array<{ name: string }> };
    const names = result.tools.map(tool => tool.name);
    expect(names.filter(name => name.startsWith('collab_'))).toEqual([]);
    expect(names).toContain('github_collab_context');
  });

  it('le scope collab: expose les 17 outils du store, dont la délégation owner CC-5, L3d, la continuité chat l7e et l\'inventaire mémoire M1b', async () => {
    // AGENT_RUNS_ENABLED explicitement éteint (défaut du Worker) : la config vitest l'allume pour les suites agentrun (CC-7 L9a).
    const fixture = createOAuthFixture({ COLLAB_DB: bindings.COLLAB_DB_C2, COLLAB_STORE_ENABLED: 'true', AGENT_RUNS_ENABLED: 'false' });
    const session = await fixture.mcpSession('mcp:read collab: offline_access', 'http://localhost:4321/callback',
      fixture.ORIGIN + '/collab/mcp');
    const response = await fixture.send('/collab/mcp', { method: 'POST', headers: session.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const result = fixture.rpcResult(await response.text()) as { tools: Array<{ name: string }> };
    expect(result.tools.map(tool => tool.name).sort())
      .toEqual(['collab_agent_run_summary', 'collab_append_event', 'collab_delegate_owner', 'collab_dispatch_task', 'collab_export',
        'collab_get_context', 'collab_get_delta', 'collab_list_agent_runs', 'collab_list_executors',
        'collab_memory_growth_simulate', 'collab_memory_inventory', 'collab_next_actions',
        'collab_phase_adjust', 'collab_phase_advance', 'collab_preempt_agent_run', 'collab_release_agent_run', 'collab_request_correction']);
  });

  it('sans le scope collab:, /collab/mcp refuse l\'accès', async () => {
    const fixture = createOAuthFixture({ COLLAB_DB: bindings.COLLAB_DB_C2, COLLAB_STORE_ENABLED: 'true' });
    const session = await fixture.mcpSession('mcp:read offline_access', 'http://localhost:4321/callback',
      fixture.ORIGIN + '/collab/mcp');
    const response = await fixture.send('/collab/mcp', { method: 'POST', headers: session.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('sans le flag COLLAB_STORE_ENABLED, /collab/mcp n\'est pas monté (fail-closed)', async () => {
    const fixture = createOAuthFixture({});
    const session = await fixture.mcpSession();
    const response = await fixture.send('/collab/mcp', { method: 'POST', headers: session.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect([404, 503]).toContain(response.status);
  });

  // CC-7 L4 : porte SALON_ENABLED allumée → 4 outils salon en plus (catalogue défaut reste 17).
  it('avec SALON_ENABLED=true le catalogue ajoute les 4 outils collab_salon_*', async () => {
    const fixture = createOAuthFixture({
      COLLAB_DB: bindings.COLLAB_DB_C2, COLLAB_STORE_ENABLED: 'true', SALON_ENABLED: 'true', AGENT_RUNS_ENABLED: 'false',
    });
    const session = await fixture.mcpSession('mcp:read collab: offline_access', 'http://localhost:4321/callback',
      fixture.ORIGIN + '/collab/mcp');
    const response = await fixture.send('/collab/mcp', { method: 'POST', headers: session.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const result = fixture.rpcResult(await response.text()) as { tools: Array<{ name: string }> };
    const names = result.tools.map(tool => tool.name).sort();
    expect(names).toContain('collab_salon_post');
    expect(names).toContain('collab_salon_list');
    expect(names).toContain('collab_salon_pending_wakes');
    expect(names).toContain('collab_salon_ack_wake');
    expect(names.filter(n => n.startsWith('collab_salon_'))).toHaveLength(4);
    expect(names.length).toBe(21);
  });

  // CC-7 L9a : porte AGENT_RUNS_ENABLED allumée → catalogue des modèles et choix de modèle (catalogue défaut reste 17).
  it('avec AGENT_RUNS_ENABLED=true le catalogue ajoute collab_model_catalog et collab_choose_model', async () => {
    const fixture = createOAuthFixture({
      COLLAB_DB: bindings.COLLAB_DB_C2, COLLAB_STORE_ENABLED: 'true', AGENT_RUNS_ENABLED: 'true',
    });
    const session = await fixture.mcpSession('mcp:read collab: offline_access', 'http://localhost:4321/callback',
      fixture.ORIGIN + '/collab/mcp');
    const response = await fixture.send('/collab/mcp', { method: 'POST', headers: session.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const result = fixture.rpcResult(await response.text()) as { tools: Array<{ name: string }> };
    const names = result.tools.map(tool => tool.name);
    expect(names).toContain('collab_model_catalog');
    expect(names).toContain('collab_choose_model');
    expect(names.length).toBe(19);
  });
});
