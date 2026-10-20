/**
 * CC-5 l3d (incrément 2c-2) — demande de correction ciblée du coordinateur (B1).
 *
 * Le coordinateur qui tient le mandat L3c du cycle peut demander à l'AUTEUR
 * d'une tâche des corrections précises (1 à 10 points), sans passer par un
 * verdict D12 : ce n'est ni une relecture ni un test, et cela ne compte jamais
 * comme avis. Le contrôleur réveille alors l'auteur (`address_correction`)
 * jusqu'à sa prochaine soumission (evidence.add citant une PR avec head et
 * base) ; tant que la demande est ouverte, la tâche n'est pas annoncée
 * `merge_ready` (fail-closed : retarder, jamais autoriser).
 *
 * L'événement `correction.request` est écrit par le serveur seulement : le type
 * n'est pas dans EVENT_TYPES, un agent ne peut pas le forger par
 * collab_append_event. Garde dans le lot : mandat à l'époque lue, HALT, cycle
 * ouvert à la révision attendue, tâche existante et non terminée.
 */
import { cycleMandateEpoch, mandateGuardSql, settleGuardedWrite } from '../coordinator/mandate';
import { expireDueHypotheses } from '../memory/hypothesis-expiry';
import { assertAutomationRunning, HALT_ACTIVE_SQL } from '../owner/automation';
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { opIdClientFor, parseOpId } from '../contracts';

export const CORRECTION_ITEMS_MAX = 10;
export const CORRECTION_ITEM_MAX = 300;
export const CORRECTION_REASON_MAX = 500;
const CORRECTION_KEY_PREFIX = 'correction:';
const TASK_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface CorrectionInput {
  cycle_id: string;
  /** Identité serveur de l'appelant (jeton OAuth). */
  participant_id: string;
  task_id: string;
  items: string[];
  reason?: string;
  expected_revision: number;
  op_id: string;
  now?: () => Date;
}

export interface CorrectionResult {
  status: 'applied' | 'duplicate';
  revision: number;
  event_seq: number;
  task_id: string;
  items: number;
}

function fail(code: string, message: string): never {
  throw new CollabStoreError(code, message);
}

/** Forme seulement : tâche, 1 à 10 points non vides et bornés, raison bornée, op_id de l'appelant. */
export function validateCorrection(input: CorrectionInput): { items: string[]; reason: string; key: string } {
  if (typeof input.task_id !== 'string' || !TASK_RE.test(input.task_id)) fail('CORRECTION_INVALID', 'task : identifiant de tâche invalide.');
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > CORRECTION_ITEMS_MAX) {
    fail('CORRECTION_INVALID', 'items : 1 à ' + CORRECTION_ITEMS_MAX + ' points de correction.');
  }
  const items = input.items.map(item => (typeof item === 'string' ? item.trim() : ''));
  if (items.some(item => !item || item.length > CORRECTION_ITEM_MAX)) {
    fail('CORRECTION_INVALID', 'items : chaque point est un texte non vide de ' + CORRECTION_ITEM_MAX + ' caractères au plus.');
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length > CORRECTION_REASON_MAX) fail('CORRECTION_INVALID', 'reason : ' + CORRECTION_REASON_MAX + ' caractères au plus.');
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) fail('CORRECTION_INVALID', 'expected_rev : entier >= 0.');
  const parsed = parseOpId(input.op_id);
  if (parsed.client !== opIdClientFor(input.participant_id) || parsed.cycle !== input.cycle_id) {
    fail('INVALID_OP_ID', 'op_id : segment client = votre participant serveur, segment cycle = le cycle visé.');
  }
  return { items, reason, key: CORRECTION_KEY_PREFIX + input.op_id };
}

async function replay(db: D1Database, key: string, input: CorrectionInput, items: string[], reason: string): Promise<CorrectionResult | null> {
  const row = await db.prepare('SELECT seq, expected_rev, payload_json FROM events WHERE idempotency_key = ?1')
    .bind(key).first<{ seq: number; expected_rev: number; payload_json: string }>();
  if (!row) return null;
  const payload = JSON.parse(row.payload_json) as { task: string; items: string[]; reason: string };
  // Intention d'un op_id : tâche, points, raison ET révision attendue (revue GPT-6 #179).
  if (payload.task !== input.task_id || payload.reason !== reason || row.expected_rev !== input.expected_revision
    || JSON.stringify(payload.items) !== JSON.stringify(items)) {
    fail('IDEMPOTENCY_CONFLICT', 'Même op_id, intention différente : incrémentez le compteur n.');
  }
  return { status: 'duplicate', revision: row.expected_rev + 1, event_seq: row.seq, task_id: payload.task, items: payload.items.length };
}

export async function requestCorrection(db: D1Database, input: CorrectionInput): Promise<CorrectionResult> {
  await ensureSchema(db);
  const { items, reason, key } = validateCorrection(input);
  const epoch = await cycleMandateEpoch(db, input.cycle_id, input.participant_id, 'CORRECTION_FORBIDDEN');
  const replayed = await replay(db, key, input, items, reason);
  if (replayed) return replayed;
  await assertAutomationRunning(db);

  const cycle = await db.prepare('SELECT revision, status FROM cycles WHERE cycle_id = ?1')
    .bind(input.cycle_id).first<{ revision: number; status: string }>();
  if (!cycle) fail('UNKNOWN_CYCLE', 'Cycle inconnu : ' + input.cycle_id);
  if (cycle.status !== 'open') fail('CORRECTION_INVALID', 'Cycle fermé : aucune demande de correction.');
  if (cycle.revision !== input.expected_revision) {
    fail('STALE', 'Révision attendue ' + input.expected_revision + ', courante ' + cycle.revision + '.');
  }
  const task = await db.prepare('SELECT status FROM tasks WHERE cycle_id = ?1 AND task_id = ?2')
    .bind(input.cycle_id, input.task_id).first<{ status: string }>();
  if (!task) fail('TASK_UNKNOWN', 'Tâche inconnue dans ce cycle : ' + input.task_id + '.');
  if (task.status === 'done' || task.status === 'verified') fail('TASK_CLOSED', 'Tâche terminée (' + task.status + ') : aucune correction à demander.');

  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  const payload = { task: input.task_id, items, reason, mandate_epoch: epoch };
  // ?1 cycle, ?2 clé, ?3 révision, ?4 appelant, ?5 époque, ?6 tâche.
  const guard = [
    'INSERT INTO collab_store_guard (ok)',
    'SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE idempotency_key = ?2)',
    "AND EXISTS (SELECT 1 FROM cycles WHERE cycle_id = ?1 AND revision = ?3 AND status = 'open')",
    'AND NOT ' + HALT_ACTIVE_SQL,
    'AND ' + mandateGuardSql('?1', '?5', '?4'),
    "AND EXISTS (SELECT 1 FROM tasks WHERE cycle_id = ?1 AND task_id = ?6 AND status NOT IN ('done', 'verified'))",
    'THEN 1 ELSE 0 END',
  ].join(' ');
  try {
    await db.batch([
      db.prepare(guard).bind(input.cycle_id, key, input.expected_revision, input.participant_id, epoch, input.task_id),
      db.prepare([
        'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
        "VALUES (?1, ?2, 'correction.request', ?3, '', 'coordinator', ?4, ?5, ?6, '')",
      ].join(' ')).bind(input.cycle_id, at, input.participant_id, JSON.stringify(payload), input.expected_revision, key),
      db.prepare('UPDATE cycles SET revision = ?2 WHERE cycle_id = ?1 AND revision = ?3')
        .bind(input.cycle_id, input.expected_revision + 1, input.expected_revision),
      // Comme tout ajout au journal : la révision avance, donc les échéances du cycle (CR-F04).
      expireDueHypotheses(db, input.cycle_id),
      db.prepare('DELETE FROM collab_store_guard'),
    ]);
  } catch (error) {
    return settleGuardedWrite(db, { error, cycleId: input.cycle_id, expectedRevision: input.expected_revision,
      replay: () => replay(db, key, input, items, reason),
      preconditionCode: 'CORRECTION_PRECONDITION_FAILED',
      preconditionMessage: 'Mandat ou tâche changé pendant la demande : rien n\'est écrit. Relisez l\'état et réessayez.' });
  }
  const event = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number }>();
  return { status: 'applied', revision: input.expected_revision + 1, event_seq: event!.seq, task_id: input.task_id, items: items.length };
}
