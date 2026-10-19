/**
 * CC-5 l3d (incrément 2c-1) — phases souples B1 pilotées par le coordinateur.
 *
 * Contrat (plan CC-5 v0.3 B1 seq 260, précisions v0.4 C1 seq 264) : le
 * workflow P1-P6 devient une boîte à outils. Le coordinateur mandaté du cycle
 * (mandat L3c, `delegated_mandates`) peut, en le justifiant :
 *   - `round.add`   : ajouter un tour à la phase courante (ex. second tour de P2) ;
 *   - `phase.reopen`: rouvrir une phase antérieure ;
 *   - `phase.skip`  : sauter la phase courante si elle est facultative.
 * L'IA décide quoi faire ; le CODE vérifie ce qui est permis et exécute.
 *
 * Choix d'implémentation : chaque opération s'écrit comme un `phase.advance`
 * (rôle `coordinator`, payload `op` typé). Une seule frontière de ronde existe
 * donc dans tout le store : `phaseEntrySeq` (CR-F01), la garde « une
 * proposition par ronde », le scellement par phase et l'export CC-STATE-1 la
 * lisent déjà. Une nouvelle ronde repart de zéro pour les sorties attendues,
 * et les scellés de la ronde quittée sont révélés (jamais rouverts).
 *
 * Invariants, revérifiés DANS le lot d'écriture (garde collab_store_guard) :
 *   - appelant enregistré actif, titulaire logique du mandat du cycle à
 *     l'époque lue (famille #126 comprise) ; HALT absent ; cycle ouvert ;
 *   - CAS sur la révision ET la phase du cycle ;
 *   - au plus SOFT_EXTRA_ROUNDS_MAX tours supplémentaires par phase (3 tours au
 *     total) et SOFT_OPS_PER_CYCLE_MAX opérations souples par cycle ; au-delà,
 *     arbitrage de Kevin ;
 *   - `phase.skip` : jamais P5 (validation owner), ni une phase qui porte des
 *     conditions de sortie (gates), ni un tour scellé (sortie `proposal.submit`
 *     attendue ou scellé non révélé) ;
 *   - cible avec définition et conditions d'entrée satisfaites.
 * D12 n'est pas touché : les verdicts restent liés à leur couple head/base ;
 * s'ils changent après une réouverture, les anciens verdicts sont caducs.
 */
import { assertPhase, PHASES, type Phase } from '../../collab/contracts';
import { opIdClientFor, parseOpId } from '../contracts';
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { logicalIdentityOf } from '../identity/families';
import { activeMandate } from '../owner/delegation-execution';
import { assertAutomationRunning, HALT_ACTIVE_SQL } from '../owner/automation';
import { expireDueHypotheses } from '../memory/hypothesis-expiry';

export const SOFT_PHASE_OPS = ['round.add', 'phase.reopen', 'phase.skip'] as const;
export type SoftPhaseOp = (typeof SOFT_PHASE_OPS)[number];
/** Tours ajoutés (round.add + phase.reopen) au plus par phase : 1 tour normal + 2 = 3 tours. */
export const SOFT_EXTRA_ROUNDS_MAX = 2;
/** Budget d'opérations souples par cycle (valeur par défaut du plan B1). */
export const SOFT_OPS_PER_CYCLE_MAX = 10;
export const SOFT_REASON_MIN = 10;
export const SOFT_REASON_MAX = 500;
const SOFT_KEY_PREFIX = 'phase-soft:';
/** Phase de validation owner : jamais sautée (C1). */
const OWNER_VALIDATION_PHASE: Phase = 'P5';

export interface SoftPhaseInput {
  cycle_id: string;
  /** Identité serveur de l'appelant (jeton OAuth), jamais fournie par le client. */
  participant_id: string;
  op: SoftPhaseOp;
  /** Obligatoire pour phase.reopen ; sinon déduite (et vérifiée si fournie). */
  target_phase?: string;
  expected_revision: number;
  reason: string;
  op_id: string;
  now?: () => Date;
  conditionsSatisfied?: (conditions: string[]) => Promise<boolean> | boolean;
}

export interface SoftPhaseResult {
  status: 'applied' | 'duplicate';
  revision: number;
  event_seq: number;
  op: SoftPhaseOp;
  from: Phase;
  to: Phase;
}

interface DefinitionRow { entry_conditions: string; expected_outputs: string; exit_conditions: string }

function fail(code: string, message: string): never {
  throw new CollabStoreError(code, message);
}

function phaseIndex(phase: Phase): number {
  return PHASES.indexOf(phase);
}

function parseList(raw: string): unknown[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** Validation des entrées (forme seulement) ; lève SOFT_PHASE_INVALID. */
export function validateSoftPhaseInput(input: SoftPhaseInput): { op: SoftPhaseOp; reason: string; key: string } {
  if (!SOFT_PHASE_OPS.includes(input.op)) fail('SOFT_PHASE_INVALID', 'op : ' + SOFT_PHASE_OPS.join(', ') + '.');
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) {
    fail('SOFT_PHASE_INVALID', 'expected_rev : entier >= 0.');
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < SOFT_REASON_MIN || reason.length > SOFT_REASON_MAX) {
    fail('SOFT_PHASE_INVALID', 'reason : justification de ' + SOFT_REASON_MIN + ' à ' + SOFT_REASON_MAX + ' caractères (journalisée).');
  }
  if (input.target_phase !== undefined) assertPhase(input.target_phase);
  if (input.op === 'phase.reopen' && input.target_phase === undefined) {
    fail('SOFT_PHASE_INVALID', 'phase.reopen : target_phase obligatoire (phase antérieure à rouvrir).');
  }
  const parsed = parseOpId(input.op_id);
  if (parsed.client !== opIdClientFor(input.participant_id) || parsed.cycle !== input.cycle_id) {
    fail('INVALID_OP_ID', 'op_id : segment client = votre participant serveur, segment cycle = le cycle visé.');
  }
  return { op: input.op, reason, key: SOFT_KEY_PREFIX + input.op_id };
}

async function replay(db: D1Database, key: string, op: SoftPhaseOp, target: string | undefined, reason: string): Promise<SoftPhaseResult | null> {
  const row = await db.prepare('SELECT seq, expected_rev, payload_json FROM events WHERE idempotency_key = ?1')
    .bind(key).first<{ seq: number; expected_rev: number; payload_json: string }>();
  if (!row) return null;
  const payload = JSON.parse(row.payload_json) as { op: SoftPhaseOp; from: Phase; to: Phase; reason: string };
  if (payload.op !== op || payload.reason !== reason || (target !== undefined && payload.to !== target)) {
    fail('IDEMPOTENCY_CONFLICT', 'Même op_id, intention différente : incrémentez le compteur n.');
  }
  return { status: 'duplicate', revision: row.expected_rev + 1, event_seq: row.seq, op: payload.op, from: payload.from, to: payload.to };
}

/** Le mandat du cycle, s'il est tenu par l'appelant (identité logique). Sinon SOFT_PHASE_FORBIDDEN. */
async function holderEpoch(db: D1Database, cycleId: string, participantId: string): Promise<number> {
  const participant = await db.prepare('SELECT status FROM participants WHERE participant_id = ?1')
    .bind(participantId).first<{ status: string }>();
  const mandate = await activeMandate(db, cycleId);
  const holds = participant?.status === 'active' && mandate?.participant_id
    && await logicalIdentityOf(db, mandate.participant_id) === await logicalIdentityOf(db, participantId);
  if (!holds) {
    fail('SOFT_PHASE_FORBIDDEN', 'Réservé au coordinateur qui tient le mandat actif de ce cycle (nommé par Kevin sur /owner).');
  }
  return mandate!.epoch;
}

/** Opérations souples déjà faites : par phase cible (tours ajoutés) et pour tout le cycle. */
const SOFT_COUNT_SQL = [
  "SELECT COUNT(*) FROM events WHERE cycle_id = ?1 AND type = 'phase.advance' AND role = 'coordinator'",
  'AND json_valid(payload_json)',
].join(' ');
const EXTRA_ROUNDS_SQL = SOFT_COUNT_SQL
  + " AND json_extract(payload_json, '$.op') IN ('round.add', 'phase.reopen') AND json_extract(payload_json, '$.to') = ?9";

async function definition(db: D1Database, cycleId: string, phase: Phase): Promise<DefinitionRow> {
  const row = await db.prepare('SELECT entry_conditions, expected_outputs, exit_conditions FROM phase_definitions WHERE cycle_id = ?1 AND phase = ?2')
    .bind(cycleId, phase).first<DefinitionRow>();
  if (!row) fail('PHASE_DEFINITION_MISSING', 'Définition absente pour ' + phase + '.');
  return row;
}

function resolveTarget(op: SoftPhaseOp, current: Phase, requested: string | undefined): Phase {
  let target: Phase;
  if (op === 'round.add') {
    target = current;
  } else if (op === 'phase.skip') {
    const next = PHASES[phaseIndex(current) + 1];
    if (!next) fail('SOFT_PHASE_INVALID', 'Aucune phase après ' + current + ' : rien à sauter.');
    target = next;
  } else {
    target = assertPhase(requested!);
    if (phaseIndex(target) >= phaseIndex(current)) {
      fail('SOFT_PHASE_INVALID', 'phase.reopen : la cible doit précéder la phase courante (' + current + ').');
    }
  }
  if (requested !== undefined && requested !== target) {
    fail('SOFT_PHASE_INVALID', op + ' depuis ' + current + ' vise ' + target + ', pas ' + requested + '.');
  }
  return target;
}

export async function adjustPhase(db: D1Database, input: SoftPhaseInput): Promise<SoftPhaseResult> {
  await ensureSchema(db);
  const { op, reason, key } = validateSoftPhaseInput(input);
  // Garde d'identité avant tout effet, rejeu compris (même règle que collab_phase_advance).
  const epoch = await holderEpoch(db, input.cycle_id, input.participant_id);
  const replayed = await replay(db, key, op, input.target_phase, reason);
  if (replayed) return replayed;
  await assertAutomationRunning(db);

  const cycle = await db.prepare('SELECT phase, revision, status FROM cycles WHERE cycle_id = ?1')
    .bind(input.cycle_id).first<{ phase: string; revision: number; status: string }>();
  if (!cycle) fail('UNKNOWN_CYCLE', 'Cycle inconnu : ' + input.cycle_id);
  if (cycle.status !== 'open') fail('SOFT_PHASE_INVALID', 'Cycle fermé : aucune réorganisation.');
  const from = assertPhase(cycle.phase);
  if (cycle.revision !== input.expected_revision) {
    fail('STALE', 'Révision attendue ' + input.expected_revision + ', courante ' + cycle.revision + '.');
  }
  const to = resolveTarget(op, from, input.target_phase);
  const source = await definition(db, input.cycle_id, from);
  const target = await definition(db, input.cycle_id, to);

  if (op === 'phase.skip') {
    if (from === OWNER_VALIDATION_PHASE) fail('SOFT_PHASE_PROTECTED', 'P5 (validation de Kevin) ne se saute jamais.');
    if (parseList(source.exit_conditions).length > 0) {
      fail('SOFT_PHASE_PROTECTED', from + ' porte des conditions de sortie (gate) : phase non facultative.');
    }
    const sealedOutput = parseList(source.expected_outputs)
      .some(output => (output as { kind?: unknown })?.kind === 'proposal.submit');
    const unrevealed = await db.prepare('SELECT 1 AS ok FROM sealed_items WHERE cycle_id = ?1 AND phase = ?2 AND revealed_at IS NULL LIMIT 1')
      .bind(input.cycle_id, from).first<{ ok: number }>();
    if (sealedOutput || unrevealed) fail('SOFT_PHASE_SEALED', from + ' est un tour scellé : il ne se saute pas.');
  }
  const evaluate = input.conditionsSatisfied ?? (async (conditions: string[]) => conditions.length === 0);
  if (op !== 'round.add' && !await evaluate(parseList(target.entry_conditions) as string[])) {
    fail('PHASE_ENTRY_CONDITIONS_UNMET', 'Conditions d\'entrée de ' + to + ' non remplies.');
  }

  const totals = await db.prepare(SOFT_COUNT_SQL).bind(input.cycle_id).first<Record<string, number>>();
  const cycleOps = Object.values(totals ?? {})[0] ?? 0;
  if (cycleOps >= SOFT_OPS_PER_CYCLE_MAX) {
    fail('SOFT_PHASE_LIMIT', 'Budget de ' + SOFT_OPS_PER_CYCLE_MAX + ' réorganisations atteint pour ce cycle : résumez le désaccord et demandez l\'arbitrage de Kevin.');
  }
  let extraRounds = 0;
  if (op !== 'phase.skip') {
    const row = await db.prepare(EXTRA_ROUNDS_SQL.split('?9').join('?2')).bind(input.cycle_id, to).first<Record<string, number>>();
    extraRounds = Object.values(row ?? {})[0] ?? 0;
    if (extraRounds >= SOFT_EXTRA_ROUNDS_MAX) {
      fail('SOFT_PHASE_LIMIT', to + ' a déjà ' + (extraRounds + 1) + ' tours (maximum ' + (SOFT_EXTRA_ROUNDS_MAX + 1)
        + ') : résumez le désaccord et demandez l\'arbitrage de Kevin.');
    }
  }

  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  const payload = { op, from, to, reason, mandate_epoch: epoch, extra_rounds: op === 'phase.skip' ? null : extraRounds + 1 };
  const logical = (n: number) => 'COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?' + n + '), ?' + n + ')';
  // ?1 cycle, ?2 clé, ?3 révision, ?4 phase source, ?5 appelant, ?6 époque, ?7 budget cycle, ?8 tours max, ?9 cible, ?10 skip.
  const guard = [
    'INSERT INTO collab_store_guard (ok)',
    'SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE idempotency_key = ?2)',
    "AND EXISTS (SELECT 1 FROM cycles WHERE cycle_id = ?1 AND revision = ?3 AND phase = ?4 AND status = 'open')",
    'AND NOT ' + HALT_ACTIVE_SQL,
    "AND EXISTS (SELECT 1 FROM participants WHERE participant_id = ?5 AND status = 'active')",
    'AND EXISTS (SELECT 1 FROM delegated_mandates m WHERE m.cycle_id = ?1 AND m.epoch = ?6 AND m.participant_id IS NOT NULL',
    "  AND COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = m.participant_id), m.participant_id) = " + logical(5) + ')',
    'AND (' + SOFT_COUNT_SQL + ') < ?7',
    'AND (?10 = 1 OR (' + EXTRA_ROUNDS_SQL + ') < ?8)',
    'AND (?10 = 0 OR NOT EXISTS (SELECT 1 FROM sealed_items WHERE cycle_id = ?1 AND phase = ?4 AND revealed_at IS NULL))',
    'THEN 1 ELSE 0 END',
  ].join(' ');
  try {
    await db.batch([
      db.prepare(guard).bind(input.cycle_id, key, input.expected_revision, from, input.participant_id, epoch,
        SOFT_OPS_PER_CYCLE_MAX, SOFT_EXTRA_ROUNDS_MAX, to, op === 'phase.skip' ? 1 : 0),
      db.prepare([
        'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
        "VALUES (?1, ?2, 'phase.advance', ?3, '', 'coordinator', ?4, ?5, ?6, '')",
      ].join(' ')).bind(input.cycle_id, at, input.participant_id, JSON.stringify(payload), input.expected_revision, key),
      db.prepare('UPDATE cycles SET phase = ?2, revision = ?3 WHERE cycle_id = ?1 AND revision = ?4')
        .bind(input.cycle_id, to, input.expected_revision + 1, input.expected_revision),
      // CR-F04 : une transition avance la révision, donc les échéances du cycle.
      expireDueHypotheses(db, input.cycle_id),
      // La ronde quittée est close : ses scellés sont révélés (round.add compris), jamais rouverts.
      db.prepare('UPDATE sealed_items SET revealed_at = ?3 WHERE cycle_id = ?1 AND phase = ?2 AND revealed_at IS NULL')
        .bind(input.cycle_id, from, at),
      db.prepare('DELETE FROM collab_store_guard'),
    ]);
  } catch (error) {
    const winner = await replay(db, key, op, input.target_phase, reason).catch(() => null);
    if (winner) return winner;
    await assertAutomationRunning(db);
    const current = await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(input.cycle_id).first<{ revision: number }>();
    if ((current?.revision ?? 0) !== input.expected_revision) fail('STALE', 'Le cycle a bougé pendant la réorganisation.');
    if (error instanceof Error && /CHECK constraint/i.test(error.message)) {
      fail('SOFT_PHASE_PRECONDITION_FAILED', 'Mandat, budget ou scellé changé pendant l\'opération : rien n\'est écrit. Relisez l\'état et réessayez.');
    }
    throw error;
  }
  const event = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number }>();
  return { status: 'applied', revision: input.expected_revision + 1, event_seq: event!.seq, op, from, to };
}
