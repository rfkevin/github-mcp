/**
 * CC-4 A2 (plan §8) — liaison d'une exécution owner à la demande approuvée.
 *
 * Quand le propriétaire approuve une demande exécutable, l'acte (installation
 * de phases, import d'état) est écrit comme UN seul owner.decision qui porte
 * aussi la décision : request_id, request_seq et l'empreinte du payload sont
 * dans son payload, et la ligne owner_decisions est insérée dans le MÊME lot
 * CAS. La garde vérifie dans la transaction que la demande n'est pas déjà
 * tranchée et que la précondition (dernier acte du même type sur le cycle)
 * est toujours vraie ; sinon tout le lot est annulé : aucun effet.
 */
import { CollabStoreError } from '../store/collab-store';
import type { OwnerProof } from './proof';

export interface OwnerRequestBinding {
  request_id: string;
  request_seq: number;
  payload_sha256: string;
  /** seq du dernier acte du même type sur le cycle cible au dépôt de la demande (null : aucun). */
  expected_previous_seq: number | null;
}

/** Précondition lue hors transaction (diagnostic lisible) ; la garde SQL la revérifie dans le lot. */
export function assertBindingPrecondition(binding: OwnerRequestBinding, currentPreviousSeq: number | null): void {
  if (currentPreviousSeq !== binding.expected_previous_seq) {
    throw new CollabStoreError('OWNER_PRECONDITION_FAILED',
      'La demande attendait le dernier acte au seq ' + (binding.expected_previous_seq ?? 'aucun') + ', le cycle est au seq '
      + (currentPreviousSeq ?? 'aucun') + ' : l’état a changé depuis le dépôt, rien n’est exécuté. L’agent doit redéposer une demande à jour.');
  }
}

/** Clé d'idempotence de l'acte lié : une seule exécution par demande (seq) et par payload. */
export function bindingKey(prefixWithCycle: string, binding: OwnerRequestBinding): string {
  return prefixWithCycle + ':req-' + binding.request_seq + ':' + binding.payload_sha256.slice(0, 32);
}

export function bindingPayload(binding: OwnerRequestBinding): Record<string, unknown> {
  return { request_id: binding.request_id, request_seq: binding.request_seq, payload_sha256: binding.payload_sha256,
    decision: 'approve', expected_previous_seq: binding.expected_previous_seq };
}

/**
 * Garde transactionnelle (ownerAppend : ?1 clé, ?2 cycle, ?3 révision, puis ?4…) :
 * demande non tranchée ET dernier acte du même type inchangé.
 */
export function bindingGuard(binding: OwnerRequestBinding, previousKeyPrefix: string, proof?: OwnerProof): { sql: string; binds: unknown[] } {
  const delegated = proof?.kind === 'delegated' ? [
    'AND EXISTS (SELECT 1 FROM delegated_mandates m WHERE m.cycle_id = ?2 AND m.participant_id = ?7 AND m.epoch = ?8 AND m.family_id = COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?7), ?7))',
    "AND EXISTS (SELECT 1 FROM delegated_approvals a WHERE a.request_id = ?4 AND a.cycle_id = ?2 AND a.epoch = ?8 AND a.used = 0 AND a.action = 'install_phases' AND a.reviewer_pid = ?9 AND a.reviewer_family = ?10 AND a.params_hash = ?11 AND a.expires_at = ?12 AND a.max_cost_cents = ?13)",
    "AND NOT EXISTS (SELECT 1 FROM owner_flags WHERE name = 'halt' AND value = '1')",
    'AND ?12 > unixepoch()',
    "AND EXISTS (SELECT 1 FROM participants WHERE participant_id = ?7 AND status = 'active')",
    "AND EXISTS (SELECT 1 FROM participants WHERE participant_id = ?9 AND status = 'active')",
    'AND COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?9), ?9) = ?10',
    'AND COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?7), ?7) != ?10',
    "AND EXISTS (SELECT 1 FROM events e WHERE e.seq = ?14 AND e.cycle_id = ?2 AND e.type = 'owner.request' AND e.participant_id != ?9 AND COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = e.participant_id), e.participant_id) != ?10 AND json_valid(e.payload_json) AND json_extract(e.payload_json, '$.request_id') = ?4 AND json_extract(e.payload_json, '$.action') = 'install_phases' AND json_extract(e.payload_json, '$.params.cycle_id') = ?2 AND json_extract(e.payload_json, '$.payload_sha256') = ?11 AND json_extract(e.payload_json, '$.expires_at') = ?12 AND COALESCE(json_extract(e.payload_json, '$.max_cost_cents'), 0) = ?13)",
    'AND (?13 = 0 OR EXISTS (SELECT 1 FROM budget_envelopes WHERE scope = ?2 AND limit_cents - reserved_cents - spent_cents >= ?13))',
  ].join(' ') : '';
  return {
    sql: [
      'NOT EXISTS (SELECT 1 FROM owner_decisions WHERE request_id = ?4)',
      "AND COALESCE((SELECT MAX(seq) FROM events WHERE cycle_id = ?2 AND type = 'owner.decision' AND substr(idempotency_key, 1, length(?5)) = ?5), 0) = ?6",
      delegated,
    ].join(' '),
    binds: [binding.request_id, previousKeyPrefix, binding.expected_previous_seq ?? 0,
      ...(proof?.kind === 'delegated' ? [proof.subject, proof.epoch, proof.reviewer_pid, proof.reviewer_family, proof.params_hash, proof.expires_at, proof.max_cost_cents, binding.request_seq] : [])],
  };
}

/** La ligne owner_decisions de l'approbation, dans le même lot que l'acte. */
export function bindingStatements(db: D1Database, binding: OwnerRequestBinding, proof: OwnerProof, eventKey: string,
  now?: () => Date): D1PreparedStatement[] {
  const at = Math.floor((now?.() ?? new Date()).getTime() / 1000);
  return [
    ...(proof.kind === 'delegated' ? [
      db.prepare('UPDATE delegated_approvals SET used = 1 WHERE request_id = ?1 AND used = 0').bind(binding.request_id),
      ...(proof.max_cost_cents > 0 ? [db.prepare('UPDATE budget_envelopes SET spent_cents = spent_cents + ?2 WHERE scope = ?1').bind(proof.cycle_id, proof.max_cost_cents)] : []),
    ] : []),
    db.prepare([
    'INSERT INTO owner_decisions (request_id, decision, access_subject, at, event_seq)',
    "VALUES (?1, 'approve', ?2, ?3, (SELECT seq FROM events WHERE idempotency_key = ?4))",
  ].join(' ')).bind(binding.request_id, proof.kind + ':' + proof.subject, at, eventKey)];
}
