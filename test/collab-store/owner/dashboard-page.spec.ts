import { describe, expect, it } from 'vitest';
import { dashboardPage, OWNER_PAGE_CSP } from '../../../src/collab-store/owner/page';
import type { DashboardData } from '../../../src/collab-store/owner/page';
import type { OwnerChannelConfig } from '../../../src/collab-store/owner/config';
import type { PendingWithExecutable } from '../../../src/collab-store/owner/executable';

/**
 * CC-AUTO T1 — smoke test de rendu du tableau de bord /owner (dashboardPage) :
 * ordre bandeau/file/sections, états du bandeau (ACTIVE/HALTÉE, budget), et
 * non-régression (un seul bouton HALT/RESUME, aucun formulaire dans le bandeau,
 * champs de décision inchangés, ni script ni secret rendu). Fixtures
 * synthétiques uniquement : aucun secret réel, aucune écriture, aucun réseau.
 */
const SECRET = 't1-fixture-secret-0123456789abcdefghij';
const config: OwnerChannelConfig = { mode: 'secret', secret: SECRET };

let n = 0;
const uniq = (label: string) => `t1-${label}-${++n}`;

function pendingItem(overrides: Partial<PendingWithExecutable> = {}): PendingWithExecutable {
  return {
    request_id: uniq('req'), cycle_id: 't1-cycle', type: 'owner.request', participant_id: 'agent:a',
    summary: 'valider le rendu', seq: 7, at: 0, state: 'pending', ...overrides,
  };
}

function dataWith(overrides: {
  items?: PendingWithExecutable[];
  total?: number;
  nextBefore?: number | null;
  halted?: boolean;
  budget?: DashboardData['budget'];
} = {}): DashboardData {
  const items = overrides.items ?? [pendingItem()];
  return {
    pending: { items, total: overrides.total ?? items.length, next_before: overrides.nextBefore ?? null },
    participants: [], clients: [], halted: overrides.halted, budget: overrides.budget,
  };
}

/** Le bandeau précède la file, qui précède Automatisation, Coordinateurs puis Exécuteurs. */
function assertOrder(html: string): void {
  const banner = html.indexOf('Automatisation');
  const fileHeading = html.indexOf('<h2>Demandes en attente');
  const automation = html.indexOf('<h2>Automatisation</h2>');
  const coordinators = html.indexOf('<h2>Coordinateurs actifs</h2>');
  const executors = html.indexOf('<h2>Exécuteurs</h2>');
  expect(banner).toBeGreaterThanOrEqual(0);
  expect(fileHeading).toBeGreaterThan(banner);
  expect(automation).toBeGreaterThan(fileHeading);
  expect(coordinators).toBeGreaterThan(automation);
  expect(executors).toBeGreaterThan(coordinators);
}

describe('CC-AUTO T1 — rendu du tableau de bord /owner', () => {
  it('ordre : bandeau puis file puis sections, y compris sans demande en attente', () => {
    assertOrder(dashboardPage(config, dataWith({ items: [pendingItem()] })));
    const empty = dashboardPage(config, dataWith({ items: [] }));
    assertOrder(empty);
    expect(empty).toContain('Aucune demande en attente.');
    expect(empty).toContain('<strong>0</strong> demande(s) en attente');
  });

  it('bandeau : compteur, ACTIVE vs HALTÉE, budget affiché seulement si présent', () => {
    const active = dashboardPage(config, dataWith({ total: 3 }));
    expect(active).toContain('<strong>3</strong> demande(s) en attente · Automatisation ACTIVE</p>');
    const bannerActive = active.slice(0, active.indexOf('<h2>Demandes en attente'));
    expect(bannerActive).not.toContain('class="halt"');
    expect(bannerActive).not.toContain('Budget restant');
    expect(active).not.toContain('Automatisation HALTÉE');

    const halted = dashboardPage(config, dataWith({
      halted: true,
      budget: { scope: 'global', limit_cents: 500, reserved_cents: 100, spent_cents: 150, remaining_cents: 250 },
    }));
    expect(halted).toContain('Automatisation HALTÉE · Budget restant 2.50 € / 5.00 €</p>');
    const bannerHalted = halted.slice(0, halted.indexOf('<h2>Demandes en attente'));
    expect(bannerHalted).toContain('class="halt"');
    expect(bannerHalted).toContain('urgence posé');
    expect(bannerHalted).toContain('Budget restant 2.50 € / 5.00 €');
    // Un seul message d’alerte dans le bandeau ; la section Automatisation garde le sien, pas plus.
    expect(halted.match(/class="halt"/g)?.length).toBe(2);
  });

  it('non-régression : un seul bouton HALT/RESUME, aucun formulaire ni bouton dans le bandeau', () => {
    for (const halted of [false, true]) {
      const html = dashboardPage(config, dataWith({ halted }));
      const toggleForms = (html.match(/name="action" value="(halt|resume)"/g) ?? []).length;
      expect(toggleForms, 'halted=' + String(halted)).toBe(1);
      const banner = html.slice(0, html.indexOf('<h2>Demandes en attente'));
      expect(banner).not.toContain('<form');
      expect(banner).not.toContain('<button');
    }
  });

  it('décision : request_seq/cycle_id/payload_sha256 inchangés, empreinte affichée seulement si exécutable', () => {
    const item = pendingItem();
    const html = dashboardPage(config, dataWith({ items: [item] }));
    expect(html).toContain('<input type="hidden" name="request_id" value="' + item.request_id + '">');
    expect(html).toContain('<input type="hidden" name="request_seq" value="7">');
    expect(html).toContain('<input type="hidden" name="cycle_id" value="t1-cycle">');
    expect(html).not.toContain('name="payload_sha256"');
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="deny"');

    const sha = 'ab'.repeat(32);
    const exec = dashboardPage(config, dataWith({ items: [pendingItem({ seq: 9, executable: {
      action: 'install_phases', cycle_id: 't1-cycle', target: 't1-cycle', payload_sha256: sha, previous_seq: null,
      reason: 'motif', risk: 'risque', rollback: 'retour arrière', expires_at: null, expired: false,
      max_cost_cents: 0, preview: '{}',
    } })] }));
    expect(exec).toContain('<input type="hidden" name="payload_sha256" value="' + sha + '">');
    expect(exec).toContain('<input type="hidden" name="request_seq" value="9">');
    expect(exec).toContain('Empreinte sha256');
  });

  it('sécurité du rendu : aucun script, CSP constante, secret jamais affiché, pagination inchangée', () => {
    const html = dashboardPage(config, dataWith({ nextBefore: 42 }));
    expect(html).not.toContain('<script');
    expect(OWNER_PAGE_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    expect(html).not.toContain(SECRET);
    expect(html).toContain('type="password" name="owner_secret"');
    expect(html).toContain('name="before" value="42"');
    expect(html).toContain('Demandes plus anciennes');
    const last = dashboardPage(config, dataWith({ nextBefore: null }));
    expect(last).not.toContain('Demandes plus anciennes');
  });
});
