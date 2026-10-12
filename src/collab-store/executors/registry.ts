/**
 * CC-4 A3 (plan §3.1, §4.1) — registre des endpoints d'exécution et matrice
 * de capacités.
 *
 * - Un endpoint n'est enregistré, modifié ou activé que par le propriétaire
 *   (demande exécutable `register_endpoint` approuvée sur /owner) : aucun
 *   agent ne s'octroie un endpoint ni ne change ses capacités (§6.6).
 * - Le principal d'un endpoint est immuable : le lier à un autre participant
 *   exige un nouvel endpoint_id (D12 repose sur des principals distincts).
 * - `active` exige une sonde réussie, enregistrée APRÈS la dernière
 *   (ré)inscription, pour la même attestation : jamais d'activation sur
 *   simple déclaration (§4.1 « no row becomes active from self-report »).
 * - Le statut et les capacités sont deny-by-default (contrat A0).
 */
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import {
  validateCapabilitySet, validateEndpointRegistration, type CapabilitySet, type EndpointRegistration, type EndpointStatus,
} from '../contracts/principals';
import { ownerAppend, REGISTRY_CYCLE, type OwnerWriteResult } from '../owner/decisions';
import { assertBindingPrecondition, bindingGuard, bindingKey, bindingPayload, bindingStatements, type OwnerRequestBinding } from '../owner/binding';
import type { OwnerProof } from '../owner/proof';

export const ENDPOINT_KEY_PREFIX = 'owner:endpoint:';
export const PROBE_KEY_PREFIX = 'owner:probe:';

export interface StoredEndpoint extends EndpointRegistration {
  registered_at: number;
}

export interface CapabilityRow extends StoredEndpoint {
  last_probe: { ok: boolean; at: number; seq: number; model: string; latency_ms: number } | null;
}

type EndpointRow = {
  endpoint_id: string; principal_id: string; attestation_kind: string; attestation_ref: string;
  status: string; capability_set: string; registered_at: number;
};

function parseRow(row: EndpointRow): StoredEndpoint {
  let capabilities: CapabilitySet = {};
  try {
    capabilities = row.capability_set ? validateCapabilitySet(JSON.parse(row.capability_set)) : {};
  } catch {
    capabilities = {}; // illisible = rien autorisé (deny-by-default)
  }
  return {
    endpoint_id: row.endpoint_id, principal_id: row.principal_id,
    attestation_kind: row.attestation_kind as StoredEndpoint['attestation_kind'], attestation_ref: row.attestation_ref,
    status: row.status as EndpointStatus, capability_set: capabilities, registered_at: row.registered_at,
  };
}

export async function loadEndpoint(db: D1Database, endpointId: string): Promise<StoredEndpoint | null> {
  await ensureSchema(db);
  const row = await db.prepare('SELECT * FROM endpoints WHERE endpoint_id = ?1').bind(endpointId).first<EndpointRow>();
  return row ? parseRow(row) : null;
}

/** seq du dernier acte owner sur un endpoint (inscription/modification), null s'il n'y en a pas. */
export async function latestEndpointActSeq(db: D1Database, endpointId: string): Promise<number | null> {
  await ensureSchema(db);
  const row = await db.prepare(
    "SELECT MAX(seq) AS seq FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND substr(idempotency_key, 1, length(?2)) = ?2",
  ).bind(REGISTRY_CYCLE, ENDPOINT_KEY_PREFIX + endpointId + ':').first<{ seq: number | null }>();
  return row?.seq ?? null;
}

/** Dernière sonde enregistrée pour un endpoint. */
export async function latestProbe(db: D1Database, endpointId: string): Promise<{ seq: number; at: number; payload: Record<string, unknown> } | null> {
  await ensureSchema(db);
  const row = await db.prepare([
    "SELECT seq, at, payload_json FROM events WHERE cycle_id = ?1 AND type = 'owner.decision'",
    'AND substr(idempotency_key, 1, length(?2)) = ?2 ORDER BY seq DESC LIMIT 1',
  ].join(' ')).bind(REGISTRY_CYCLE, PROBE_KEY_PREFIX + endpointId + ':').first<{ seq: number; at: number; payload_json: string }>();
  if (!row) return null;
  try {
    return { seq: row.seq, at: row.at, payload: JSON.parse(row.payload_json) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Matrice §4.1 : un endpoint par ligne, avec sa dernière sonde. */
export async function capabilityMatrix(db: D1Database): Promise<CapabilityRow[]> {
  await ensureSchema(db);
  const { results } = await db.prepare('SELECT * FROM endpoints ORDER BY principal_id, endpoint_id LIMIT 200').all<EndpointRow>();
  const rows: CapabilityRow[] = [];
  for (const row of results) {
    const endpoint = parseRow(row);
    const probe = await latestProbe(db, endpoint.endpoint_id);
    rows.push({ ...endpoint, last_probe: probe ? {
      ok: probe.payload.ok === true, at: probe.at, seq: probe.seq,
      model: String(probe.payload.model ?? ''), latency_ms: Number(probe.payload.latency_ms ?? 0),
    } : null });
  }
  return rows;
}

/**
 * Activation : une sonde réussie, pour CETTE attestation, enregistrée après
 * le dernier acte d'inscription de l'endpoint. Sinon ENDPOINT_PROBE_REQUIRED.
 */
async function assertActivable(db: D1Database, reg: EndpointRegistration, existing: StoredEndpoint | null): Promise<void> {
  if (reg.status !== 'active') return;
  if (!existing) {
    throw new CollabStoreError('ENDPOINT_PROBE_REQUIRED', 'Endpoint inconnu : inscrivez-le d’abord en probe_required, sondez-le, puis activez-le.');
  }
  const probe = await latestProbe(db, reg.endpoint_id);
  const lastAct = await latestEndpointActSeq(db, reg.endpoint_id);
  const fresh = probe && probe.payload.ok === true && probe.payload.attestation_ref === reg.attestation_ref
    && (lastAct === null || probe.seq > lastAct);
  if (!fresh || existing.attestation_ref !== reg.attestation_ref) {
    throw new CollabStoreError('ENDPOINT_PROBE_REQUIRED',
      'Aucune sonde réussie de ' + reg.endpoint_id + ' (' + reg.attestation_ref + ') depuis sa dernière inscription : activation refusée.');
  }
}

/**
 * Inscrit, modifie ou active un endpoint (canal owner seulement). Avec `binding`,
 * c'est l'exécution d'une demande approuvée : acte et décision dans le même lot.
 */
export async function registerEndpoint(db: D1Database, input: {
  registration: unknown;
  proof: OwnerProof;
  op?: string;
  binding?: OwnerRequestBinding;
  now?: () => Date;
}): Promise<OwnerWriteResult & { endpoint: EndpointRegistration }> {
  await ensureSchema(db);
  const reg = validateEndpointRegistration(input.registration);
  const existing = await loadEndpoint(db, reg.endpoint_id);
  if (existing && existing.principal_id !== reg.principal_id) {
    throw new CollabStoreError('ENDPOINT_PRINCIPAL_IMMUTABLE',
      'L’endpoint ' + reg.endpoint_id + ' appartient à ' + existing.principal_id + ' : créez un autre endpoint_id pour ' + reg.principal_id + '.');
  }
  const taken = await db.prepare(
    'SELECT endpoint_id FROM endpoints WHERE principal_id = ?1 AND attestation_kind = ?2 AND attestation_ref = ?3 AND endpoint_id <> ?4',
  ).bind(reg.principal_id, reg.attestation_kind, reg.attestation_ref, reg.endpoint_id).first<{ endpoint_id: string }>();
  if (taken) {
    throw new CollabStoreError('ENDPOINT_ATTESTATION_TAKEN', 'Attestation déjà portée par l’endpoint ' + taken.endpoint_id + '.');
  }
  await assertActivable(db, reg, existing);
  if (input.binding) assertBindingPrecondition(input.binding, await latestEndpointActSeq(db, reg.endpoint_id));
  if (!input.binding && !input.op) throw new CollabStoreError('INVALID_OWNER_OP', 'op requis hors demande liée.');
  const prefix = ENDPOINT_KEY_PREFIX + reg.endpoint_id;
  const key = input.binding ? bindingKey(prefix, input.binding) : prefix + ':' + input.op;
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  const binding = input.binding;
  const result = await ownerAppend(db, {
    cycleId: REGISTRY_CYCLE,
    key,
    payload: { action: 'register_endpoint', ...reg, ...(binding ? bindingPayload(binding) : {}) },
    proof: input.proof,
    ...(binding ? { extraGuard: bindingGuard(binding, prefix + ':') } : {}),
    sideEffects: eventKey => [
      ...(binding ? bindingStatements(db, binding, input.proof, eventKey, input.now) : []),
      db.prepare([
        'INSERT INTO endpoints (endpoint_id, principal_id, attestation_kind, attestation_ref, status, capability_set, registered_at)',
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
        'ON CONFLICT(endpoint_id) DO UPDATE SET attestation_kind = excluded.attestation_kind,',
        '  attestation_ref = excluded.attestation_ref, status = excluded.status, capability_set = excluded.capability_set,',
        '  registered_at = excluded.registered_at',
        '  WHERE endpoints.principal_id = excluded.principal_id',
      ].join(' ')).bind(reg.endpoint_id, reg.principal_id, reg.attestation_kind, reg.attestation_ref, reg.status,
        JSON.stringify(reg.capability_set), at),
    ],
    now: input.now,
  });
  return { ...result, endpoint: reg };
}
