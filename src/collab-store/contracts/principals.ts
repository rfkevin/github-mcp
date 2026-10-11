/**
 * CC-4 A0 (point 4, plan CC-PLAN-4/v0.1 §3.1) — contrat principal / endpoint /
 * session : CONTRAT ET SCHÉMA SEULEMENT, aucune exécution d'agent dans ce lot.
 *
 * Un identifiant CIMD partagé n'est pas une preuve de participants distincts :
 * deux endpoints qui présentent la même attestation (même kind + même ref),
 * le même endpoint, ou la même session ne prouvent PAS deux principals
 * distincts (provesDistinctPrincipals). Les capacités d'un endpoint sont
 * deny-by-default : un champ absent ou vide n'autorise rien, sans joker.
 */
import { StateContractError } from '../../collab/contracts';

export const ATTESTATION_KINDS = ['oauth_client', 'github_oidc', 'provider_adapter', 'chat_cimd'] as const;
export type AttestationKind = (typeof ATTESTATION_KINDS)[number];

export type EndpointStatus = 'probe_required' | 'active' | 'retired';

/** Deny-by-default capability set: an absent or empty field authorizes nothing. */
export interface CapabilitySet {
  tools?: string[];
  repositories?: string[];
  branch_paths?: string[];
  network_providers?: string[];
  token_ceiling?: number;
  cost_ceiling?: number;
}

export interface EndpointRegistration {
  endpoint_id: string;
  principal_id: string;
  attestation_kind: AttestationKind;
  attestation_ref: string;
  status: EndpointStatus;
  capability_set: CapabilitySet;
}

export interface SessionBinding {
  session_id: string;
  endpoint_id: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENDPOINT_STATUSES: readonly EndpointStatus[] = ['probe_required', 'active', 'retired'];
const CAPABILITY_LIST_FIELDS = ['tools', 'repositories', 'branch_paths', 'network_providers'] as const;
const CAPABILITY_CEILING_FIELDS = ['token_ceiling', 'cost_ceiling'] as const;

function requireId(value: unknown, field: string, code: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new StateContractError(code, field + ' must match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}', field);
  }
  return value;
}

export function validateAttestationKind(kind: unknown): AttestationKind {
  if (typeof kind !== 'string' || !ATTESTATION_KINDS.includes(kind as AttestationKind)) {
    throw new StateContractError(
      'INVALID_ATTESTATION_KIND',
      'attestation_kind must be one of ' + ATTESTATION_KINDS.join(', '),
      'attestation_kind',
    );
  }
  return kind as AttestationKind;
}

export function validateCapabilitySet(set: unknown): CapabilitySet {
  if (set === undefined || set === null) return {}; // deny-by-default : rien autorisé.
  if (typeof set !== 'object' || Array.isArray(set)) {
    throw new StateContractError('INVALID_CAPABILITY_SET', 'capability_set must be an object', 'capability_set');
  }
  const record = set as Record<string, unknown>;
  for (const field of CAPABILITY_LIST_FIELDS) {
    const value = record[field];
    if (value === undefined) continue; // absent = rien autorisé pour ce champ.
    if (!Array.isArray(value) || value.length === 0
      || !value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 200)) {
      throw new StateContractError(
        'INVALID_CAPABILITY_SET',
        'capability_set.' + field + ' must be a non-empty array of non-empty strings (<= 200), no wildcards — deny-by-default',
        'capability_set',
      );
    }
  }
  for (const field of CAPABILITY_CEILING_FIELDS) {
    const value: unknown = record[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new StateContractError(
        'INVALID_CAPABILITY_SET',
        'capability_set.' + field + ' must be an integer >= 0',
        'capability_set',
      );
    }
  }
  for (const key of Object.keys(record)) {
    if (![...CAPABILITY_LIST_FIELDS, ...CAPABILITY_CEILING_FIELDS].includes(key as never)) {
      throw new StateContractError('INVALID_CAPABILITY_SET', 'capability_set has no field "' + key + '"', 'capability_set');
    }
  }
  return record as CapabilitySet;
}

export function validateEndpointRegistration(reg: unknown): EndpointRegistration {
  if (typeof reg !== 'object' || reg === null) {
    throw new StateContractError('INVALID_ENDPOINT_REGISTRATION', 'endpoint registration must be an object', 'endpoint_id');
  }
  const record = reg as Record<string, unknown>;
  const endpoint_id = requireId(record.endpoint_id, 'endpoint_id', 'INVALID_ENDPOINT_REGISTRATION');
  const principal_id = requireId(record.principal_id, 'principal_id', 'INVALID_ENDPOINT_REGISTRATION');
  const attestation_kind = validateAttestationKind(record.attestation_kind);
  if (typeof record.attestation_ref !== 'string' || !record.attestation_ref.trim() || record.attestation_ref.length > 256) {
    throw new StateContractError(
      'INVALID_ENDPOINT_REGISTRATION',
      'attestation_ref must be a non-empty string (<= 256)',
      'attestation_ref',
    );
  }
  if (typeof record.status !== 'string' || !ENDPOINT_STATUSES.includes(record.status as EndpointStatus)) {
    throw new StateContractError(
      'INVALID_ENDPOINT_REGISTRATION',
      'status must be one of ' + ENDPOINT_STATUSES.join(', '),
      'status',
    );
  }
  return {
    endpoint_id,
    principal_id,
    attestation_kind,
    attestation_ref: record.attestation_ref,
    status: record.status as EndpointStatus,
    capability_set: validateCapabilitySet(record.capability_set),
  };
}

export function validateSessionBinding(binding: unknown): SessionBinding {
  if (typeof binding !== 'object' || binding === null) {
    throw new StateContractError('INVALID_SESSION_BINDING', 'session binding must be an object', 'session_id');
  }
  const record = binding as Record<string, unknown>;
  const session_id = requireId(record.session_id, 'session_id', 'INVALID_SESSION_BINDING');
  const endpoint_id = requireId(record.endpoint_id, 'endpoint_id', 'INVALID_SESSION_BINDING');
  return { session_id, endpoint_id };
}

/**
 * §3.1 — deux endpoints ne prouvent des principals DISTINCTS que si aucun des
 * liens suivants n'existe : même principal_id, même endpoint_id, même couple
 * (attestation_kind, attestation_ref) — un CIMD partagé n'est pas une preuve
 * de participants distincts — ni, quand l'appelant fournit l'id de session
 * partagé, une même session.
 */
export function provesDistinctPrincipals(
  a: EndpointRegistration,
  b: EndpointRegistration,
  sharedSessionId?: string,
): boolean {
  if (a.principal_id === b.principal_id) return false;
  if (a.endpoint_id === b.endpoint_id) return false;
  if (a.attestation_kind === b.attestation_kind && a.attestation_ref === b.attestation_ref) return false;
  if (typeof sharedSessionId === 'string' && sharedSessionId.length > 0) return false;
  return true;
}
