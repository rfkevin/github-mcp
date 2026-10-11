import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_KINDS,
  provesDistinctPrincipals,
  validateAttestationKind,
  validateCapabilitySet,
  validateEndpointRegistration,
  validateSessionBinding,
  type EndpointRegistration,
} from '../../../src/collab-store/contracts';
import { StateContractError } from '../../../src/collab/contracts';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-4 A0 (point 4, plan CC-PLAN-4 §3.1) — contrat principal / endpoint /
// session : CONTRAT ET SCHÉMA SEULEMENT, aucune exécution d'agent dans ce lot.
// Un identifiant CIMD partagé n'est pas une preuve de participants distincts ;
// les capacités d'un endpoint sont deny-by-default.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let counter = 0;
const uniq = (label: string) => 'a0pr-' + label + '-' + (++counter);

function codeOf(error: unknown): string {
  return (error as { code: string }).code;
}

function endpoint(principal: string, overrides: Record<string, unknown> = {}): EndpointRegistration {
  return validateEndpointRegistration({
    endpoint_id: uniq('ep'),
    principal_id: principal,
    attestation_kind: 'github_oidc',
    attestation_ref: 'repo:rfkevin/github-mcp:env:production',
    status: 'probe_required',
    capability_set: { tools: ['collab_append_event'] },
    ...overrides,
  });
}

describe('CC-4 A0 (point 4) — contrat principal/endpoint/session (§3.1)', () => {
  it('attestation kinds : les quatre kinds acceptés, tout le reste refusé', () => {
    expect([...ATTESTATION_KINDS]).toEqual(['oauth_client', 'github_oidc', 'provider_adapter', 'chat_cimd']);
    expect(validateAttestationKind('chat_cimd')).toBe('chat_cimd');
    try {
      validateAttestationKind('sms');
      expect.unreachable('kind inconnu accepté');
    } catch (error) {
      expect(error).toBeInstanceOf(StateContractError);
      expect(codeOf(error)).toBe('INVALID_ATTESTATION_KIND');
    }
  });

  it('capability_set deny-by-default : absent autorise rien, champs inconnus refusés', () => {
    expect(validateCapabilitySet(undefined)).toEqual({});
    expect(validateCapabilitySet({ tools: ['collab_append_event'] })).toEqual({ tools: ['collab_append_event'] });
    expect(validateCapabilitySet({ token_ceiling: 5, cost_ceiling: 0 })).toEqual({ token_ceiling: 5, cost_ceiling: 0 });
    for (const bad of [{ tools: [] }, { tools: ['ok', ''] }, { ghost_field: 1 }, { token_ceiling: -1 }]) {
      try {
        validateCapabilitySet(bad);
        expect.unreachable('capability_set invalide accepté : ' + JSON.stringify(bad));
      } catch (error) {
        expect(error).toBeInstanceOf(StateContractError);
        expect(codeOf(error)).toBe('INVALID_CAPABILITY_SET');
      }
    }
  });

  it('validateEndpointRegistration : valide normalisé, champs invalides refusés par code', () => {
    const reg = endpoint('a0pr-p1');
    expect(reg.endpoint_id).toMatch(/^a0pr-ep-/);
    expect(reg.status).toBe('probe_required');
    expect(reg.capability_set).toEqual({ tools: ['collab_append_event'] });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: 'phantom' }, 'INVALID_ENDPOINT_REGISTRATION'],
      [{ attestation_ref: '  ' }, 'INVALID_ENDPOINT_REGISTRATION'],
      [{ endpoint_id: '' }, 'INVALID_ENDPOINT_REGISTRATION'],
      [{ attestation_kind: 'sms' }, 'INVALID_ATTESTATION_KIND'],
      [{ capability_set: { tools: [] } }, 'INVALID_CAPABILITY_SET'],
    ];
    for (const [overrides, code] of cases) {
      try {
        endpoint('a0pr-x', overrides);
        expect.unreachable('enregistrement invalide accepté : ' + code);
      } catch (error) {
        expect(codeOf(error)).toBe(code);
      }
    }
  });

  it('validateSessionBinding : ids requis, sinon INVALID_SESSION_BINDING', () => {
    expect(validateSessionBinding({ session_id: 'a0pr-session', endpoint_id: 'a0pr-ep-1' }))
      .toEqual({ session_id: 'a0pr-session', endpoint_id: 'a0pr-ep-1' });
    try {
      validateSessionBinding({ session_id: '', endpoint_id: 'a0pr-ep-1' });
      expect.unreachable('session binding invalide accepté');
    } catch (error) {
      expect(error).toBeInstanceOf(StateContractError);
      expect(codeOf(error)).toBe('INVALID_SESSION_BINDING');
    }
  });

  it('provesDistinctPrincipals : même principal, même endpoint, même CIMD ou même session ne prouvent rien', () => {
    const a = endpoint('a0pr-p1');
    const b = endpoint('a0pr-p2');
    expect(provesDistinctPrincipals(a, b)).toBe(true);
    expect(provesDistinctPrincipals(a, endpoint('a0pr-p1'))).toBe(false); // même principal
    expect(provesDistinctPrincipals(a, endpoint('a0pr-p2', { endpoint_id: a.endpoint_id }))).toBe(false); // même endpoint
    const cimdA = endpoint('a0pr-p1', { attestation_kind: 'chat_cimd', attestation_ref: 'https://cimd.example/alice' });
    const cimdB = endpoint('a0pr-p2', { attestation_kind: 'chat_cimd', attestation_ref: 'https://cimd.example/alice' });
    expect(provesDistinctPrincipals(cimdA, cimdB)).toBe(false); // CIMD partagé : pas une preuve
    expect(provesDistinctPrincipals(a, b, 'a0pr-session')).toBe(false); // session partagée
    expect(provesDistinctPrincipals(a, endpoint('a0pr-p2', { attestation_ref: 'autre-ref' }))).toBe(true);
  });

  it('ensureSchema (migration 0005) : tables endpoints et session_bindings, contraintes tenues', async () => {
    await ensureSchema(db, true);
    const principal = uniq('principal');
    const first = uniq('ep');
    await db.prepare([
      'INSERT INTO endpoints (endpoint_id, principal_id, attestation_kind, attestation_ref, status, capability_set, registered_at)',
      "VALUES (?1, ?2, 'github_oidc', 'ref-a0', 'active', '{}', 1)",
    ].join(' ')).bind(first, principal).run();
    // UNIQUE (principal_id, attestation_kind, attestation_ref) : même triple refusé.
    await expect(db.prepare([
      'INSERT INTO endpoints (endpoint_id, principal_id, attestation_kind, attestation_ref, status, capability_set, registered_at)',
      "VALUES (?1, ?2, 'github_oidc', 'ref-a0', 'retired', '{}', 2)",
    ].join(' ')).bind(uniq('ep'), principal).run()).rejects.toThrow();
    // session_bindings : PK (session_id, endpoint_id), une session par endpoint.
    const session = uniq('session');
    await db.prepare('INSERT INTO session_bindings (session_id, endpoint_id) VALUES (?1, ?2)')
      .bind(session, first).run();
    await expect(db.prepare('INSERT INTO session_bindings (session_id, endpoint_id) VALUES (?1, ?2)')
      .bind(session, first).run()).rejects.toThrow();
    await db.prepare('INSERT INTO session_bindings (session_id, endpoint_id) VALUES (?1, ?2)')
      .bind(uniq('session'), first).run();
  });
});
