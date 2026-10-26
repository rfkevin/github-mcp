import { describe, expect, it } from 'vitest';
import { ACTIONS } from '../../../src/collab-store/owner/handler';
import { dashboardPage, type DashboardData } from '../../../src/collab-store/owner/page';
import type { OwnerChannelConfig } from '../../../src/collab-store/owner/config';
import type { CapabilityRow } from '../../../src/collab-store/executors/registry';

// CC-Owner V2 L4 : inventaire du rendu /owner, sans base — chaque action
// déclarée est joignable (halt et resume s'excluent : deux rendus couvrent
// l'union), chaque lien de navigation vise une section rendue, aucun
// formulaire orphelin, aucun script ni URI javascript (CSP sans script).

const config: OwnerChannelConfig = {
  mode: 'access', teamDomain: 'team.cloudflareaccess.com', audience: 'https://owner.example.com', email: 'owner@example.com',
};

const ACTIVE_EXECUTOR = {
  endpoint_id: 'ep-1', principal_id: 'agent:x', attestation_kind: 'provider_adapter', attestation_ref: 'https://attestation.example.com',
  status: 'active', capability_set: { tools: ['llm.generate'] }, registered_at: 1, last_probe: null, owner_notes: null,
} as unknown as CapabilityRow;

function inventoryData(halted: boolean): DashboardData {
  return {
    pending: {
      total: 1, next_before: 41,
      items: [{
        request_id: 'req-1', cycle_id: 'cc-owner-v2', type: 'grant_coordinator',
        participant_id: 'agent:x', summary: 'inventaire L4', seq: 42, at: 1, state: 'pending',
      }],
    },
    classified: [{
      request_id: 'req-0', cycle_id: 'cc-owner-v2', type: 'owner.request', participant_id: 'agent:y',
      request_seq: 7, verdict: 'other', note: '', event_seq: 9, created_at: 8,
    }],
    participants: [{ participant_id: 'agent:x', display_label: 'Agent X', status: 'active' }],
    clients: [], identityFamilies: [], imports: [],
    halted,
    budget: { scope: 'global', limit_cents: 1000, reserved_cents: 0, spent_cents: 100, remaining_cents: 900 },
    coordinators: [], executors: [ACTIVE_EXECUTOR], relay: [],
    cycles: { open: 2, closed: 1 },
  };
}

function actionValues(html: string): string[] {
  return [...html.matchAll(/name="action" value="([^"]*)"/g)].map(match => match[1]);
}

const SECTIONS = ['pending', 'classified', 'relay', 'agent-runs', 'automation', 'coordinators', 'mandate',
  'close', 'executors', 'participants', 'families', 'clients', 'imports', 'phases', 'product'];

describe('CC-Owner V2 L4 — inventaire de la page owner', () => {
  it('les 16 actions déclarées sont joignables (halt/resume exclusifs), aucune action inconnue n’est rendue', () => {
    const values = [...actionValues(dashboardPage(config, inventoryData(false))), ...actionValues(dashboardPage(config, inventoryData(true)))];
    expect(new Set(values)).toEqual(new Set([...ACTIONS]));
    for (const value of values) expect([...ACTIONS]).toContain(value);
  });

  it('aucun formulaire orphelin : chaque formulaire porte exactement une action', () => {
    for (const halted of [false, true]) {
      const html = dashboardPage(config, inventoryData(halted));
      expect(html.split('<form').length - 1).toBe(actionValues(html).length);
    }
  });

  it('bandeau : synthèse des cycles quand elle est fournie, rien sinon', () => {
    expect(dashboardPage(config, inventoryData(false))).toContain('Cycles : 2 ouvert(s), 1 clos');
    const withoutCycles = inventoryData(false);
    delete withoutCycles.cycles;
    expect(dashboardPage(config, withoutCycles)).not.toContain('Cycles :');
  });

  it('navigation par ancres : liens vers les 15 sections, chaque ancre résolue, collante et tactile', () => {
    const html = dashboardPage(config, inventoryData(false));
    expect(html).toContain('<nav class="toc"');
    const hrefs = [...html.matchAll(/<a href="#([^"]+)"/g)].map(match => match[1]);
    expect([...hrefs].sort()).toEqual([...SECTIONS].sort());
    for (const id of SECTIONS) expect(html).toContain('id="' + id + '"');
    expect(html).toContain('.toc{position:sticky;top:0');
    expect(html).toContain('.toc a{min-height:44px;font-size:16px');
  });

  it('aucun script ni URI javascript : la page reste sous CSP sans script', () => {
    for (const halted of [false, true]) {
      const html = dashboardPage(config, inventoryData(halted));
      expect(html).not.toContain('<script');
      expect(html).not.toContain('javascript:');
    }
  });
});
