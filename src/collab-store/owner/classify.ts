/**
 * CC-Owner V2 L3 — classification owner d'une demande d'agent (I7, /owner
 * only).
 *
 * Politique owner (cycle cc-owner-v2, consolidation seq 655, politique seq
 * 656) :
 * - une classification est un acte d'administration, pas une décision : la
 *   demande n'est ni approuvée ni refusée, et son événement n'est jamais
 *   modifié ni supprimé (append-only) ;
 * - une classification par demande, immuable : la PK (cycle_id,
 *   request_seq) de la migration 0011 interdit le re-classement ; un second
 *   essai sous un op distinct → REQUEST_ALREADY_CLASSIFIED (le rejeu de la
 *   même soumission reste duplicate, jugé avant toute garde — A05) ;
 * - la demande classée quitte la liste d'attente (elle ne bloque plus la
 *   clôture douce) mais reste visible dans l'audit (listClassified) ;
 * - la classification reste possible sur un cycle clos : drain des
 *   demandes restées sans décision, au même titre que decide.
 */
import { CollabStoreError, type StoredStoreEvent } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { ownerAppend, requestEvent, type OwnerWriteResult } from './decisions';
import { assertBindingPrecondition, bindingGuard, bindingKey, bindingPayload, bindingStatements, type OwnerRequestBinding } from './binding';
import type { OwnerProof } from './proof';

export const CLASSIFICATION_VERDICTS = ['invalid', 'blocked', 'duplicate', 'other'] as const;
export type ClassificationVerdict = (typeof CLASSIFICATION_VERDICTS)[number];

const MAX_NOTE = 500;

export interface ClassifyResult extends OwnerWriteResult {
  cycle_id: string;
  request_seq: number;
  verdict: ClassificationVerdict;
}

/**
 * Acte owner : classer une demande. `op` nomme la soumission (formulaire
 * /owner) ; la clé d'idempotence rend un double envoi inoffensif, un second
 * classement de la même demande sous une nouvelle clé →
 * REQUEST_ALREADY_CLASSIFIED.
 */
export async function classifyRequest(db: D1Database, input: {
  request_seq: number;
  verdict: string;
  note?: string;
  proof: OwnerProof;
  op: string;
  /** CC-Owner V2 L6 : approbation d’une demande classify_request — acte lié. */
  binding?: OwnerRequestBinding;
  now?: () => Date;
}): Promise<ClassifyResult> {
  if (input.proof.kind === 'delegated') {
    throw new CollabStoreError('DELEGATED_FORBIDDEN', 'La classification d’une demande est un acte owner non déléguable.');
  }
  if (!Number.isSafeInteger(input.request_seq) || input.request_seq <= 0) {
    throw new CollabStoreError('INVALID_REQUEST_ID', 'Numéro de demande (seq) invalide.');
  }
  if (!CLASSIFICATION_VERDICTS.includes(input.verdict as ClassificationVerdict)) {
    throw new CollabStoreError('INVALID_CLASSIFICATION', 'Verdict de classification : invalid, blocked, duplicate ou other.');
  }
  const verdict = input.verdict as ClassificationVerdict;
  const note = (input.note ?? '').trim().slice(0, MAX_NOTE);
  // CC-Owner V2 L6 : la demande exécutable déclare previous_seq null — la
  // classification n’observe aucun acte du même type (la PK 0011 scelle la
  // cible dans le même lot).
  if (input.binding) assertBindingPrecondition(input.binding, null);
  await ensureSchema(db);
  const request = await requestEvent(db, input.request_seq);
  if (!request) {
    throw new CollabStoreError('UNKNOWN_REQUEST', 'Aucune demande avec ce numéro (seq ' + input.request_seq + ').');
  }
  let requestId = '';
  try {
    const parsed = JSON.parse(request.payload_json) as { request_id?: unknown };
    if (typeof parsed.request_id === 'string') requestId = parsed.request_id;
  } catch {
    requestId = '';
  }
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  // L6 lié : clé de liaison (identité de la demande exécutable) ; la garde de
  // famille ?5 couvre les actes form ET liés de cette cible (prefix commun).
  const key = input.binding
    ? bindingKey('owner-request-classification:' + request.cycle_id + ':' + request.seq, input.binding)
    : 'owner-request-classification:' + request.cycle_id + ':' + request.seq + ':' + input.op;
  const bound = input.binding
    ? bindingGuard(input.binding, 'owner-request-classification:' + request.cycle_id + ':' + request.seq + ':')
    : null;
  // A05 : le contrôle d'idempotence précède toute garde — le rejeu de la même
  // soumission (même op) renvoie l'événement original (duplicate), même si la
  // demande est déjà classée ; REQUEST_ALREADY_CLASSIFIED ne vise qu'un
  // classement distinct.
  const replay = await db.prepare('SELECT * FROM events WHERE idempotency_key = ?1').bind(key)
    .first<StoredStoreEvent>();
  if (replay) {
    const stored = JSON.parse(replay.payload_json) as { verdict?: ClassificationVerdict };
    return { status: 'duplicate', event: replay, cycle_id: request.cycle_id, request_seq: request.seq,
      verdict: stored.verdict ?? verdict };
  }
  // Anti-re-classement : une classification existe déjà pour cette demande exacte.
  const prior = await db.prepare(
    'SELECT verdict FROM request_classifications WHERE cycle_id = ?1 AND request_seq = ?2'
  ).bind(request.cycle_id, request.seq).first<{ verdict: string }>();
  if (prior) {
    throw new CollabStoreError('REQUEST_ALREADY_CLASSIFIED',
      'Demande déjà classée (' + prior.verdict + ') : une classification par demande, immuable.');
  }
  let result: OwnerWriteResult;
  try {
    result = await ownerAppend(db, {
      cycleId: request.cycle_id,
      key,
      // L6 : bindingPayload en DERNIER — l’acte lié porte l’identité de la
      // demande EXÉCUTABLE (request_id/request_seq), sinon le rejeu de
      // l’approbation casserait (ALREADY_DECIDED au lieu de duplicate).
      payload: { action: 'classify_request', request_id: requestId, request_seq: request.seq, verdict,
        ...(note ? { note } : {}), ...(input.binding ? bindingPayload(input.binding) : {}) },
      proof: input.proof,
      extraGuard: {
        // PK (cycle_id, request_seq) : un classement concurrent gagne, le nôtre est refusé.
        // L6 lié : la garde de liaison (?4..?6) précède, la PK passe en ?7/?8.
        sql: bound
          ? '(' + bound.sql + ') AND NOT EXISTS (SELECT 1 FROM request_classifications WHERE cycle_id = ?7 AND request_seq = ?8)'
          : 'NOT EXISTS (SELECT 1 FROM request_classifications WHERE cycle_id = ?4 AND request_seq = ?5)',
        binds: (bound ? [...bound.binds, request.cycle_id, request.seq] : [request.cycle_id, request.seq]) as unknown[],
      },
      sideEffects: keyBind => [
        ...(input.binding ? bindingStatements(db, input.binding, input.proof, keyBind, input.now) : []),
        db.prepare([
        'INSERT INTO request_classifications (cycle_id, request_seq, verdict, note, event_seq, created_at)',
        'VALUES (?1, ?2, ?3, ?4, (SELECT seq FROM events WHERE idempotency_key = ?5), ?6)',
      ].join(' ')).bind(request.cycle_id, request.seq, verdict, note, keyBind, at)],
      now: input.now,
    });
  } catch (error) {
    // Course : une classification concurrente a gagné entre la lecture et le
    // lot ; garde annulée, rien n'est écrit — diagnostic typé.
    if (error instanceof CollabStoreError && error.code === 'OWNER_PRECONDITION_FAILED') {
      const concurrent = await db.prepare(
        'SELECT verdict FROM request_classifications WHERE cycle_id = ?1 AND request_seq = ?2'
      ).bind(request.cycle_id, request.seq).first<{ verdict: string }>();
      if (concurrent) {
        throw new CollabStoreError('REQUEST_ALREADY_CLASSIFIED',
          'Demande classée entre-temps (' + concurrent.verdict + ') : une classification par demande, immuable.');
      }
    }
    throw error;
  }
  return { ...result, cycle_id: request.cycle_id, request_seq: request.seq, verdict };
}
