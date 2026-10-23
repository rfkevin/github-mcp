import { assertPhase, type Phase } from '../../collab/contracts';
import { validatePhaseDefinition, type PhaseDefinition } from '../contracts';
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { phaseEntrySeq } from './entry-seq';
import { expireDueHypotheses } from '../memory/hypothesis-expiry';
import { assertAutomationRunning, HALT_ACTIVE_SQL } from '../owner/automation';
import { CYCLE_OPEN_GUARD } from '../owner/close';

export interface PhaseFacts {
  definition: PhaseDefinition;
  outputsSatisfied: boolean;
}

async function definition(db: D1Database, cycleId: string, phase: string): Promise<PhaseDefinition> {
  const row = await db.prepare([
    'SELECT cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance',
    'FROM phase_definitions WHERE cycle_id = ?1 AND phase = ?2',
  ].join(' ')).bind(cycleId, phase).first<{
    cycle_id: string; phase: Phase; entry_conditions: string; expected_outputs: string; exit_conditions: string; auto_advance: string;
  }>();
  if (!row) throw new CollabStoreError('PHASE_DEFINITION_MISSING', 'Définition absente pour ' + phase + '.');
  return validatePhaseDefinition({
    cycle_id: row.cycle_id,
    phase: row.phase,
    entry_conditions: JSON.parse(row.entry_conditions),
    expected_outputs: JSON.parse(row.expected_outputs),
    exit_conditions: JSON.parse(row.exit_conditions),
    auto_advance: row.auto_advance,
  });
}

// phaseEntrySeq (CR-F01) vit dans ./entry-seq : partagé avec le store (CC-4 A0,
// garde « une sortie par ronde ») sans importer le moteur ni créer de cycle
// d'imports.

async function outputsSatisfied(db: D1Database, def: PhaseDefinition): Promise<boolean> {
  // CR-F01: only count contributions from the *current* visit to this phase.
  const entrySeq = await phaseEntrySeq(db, def.cycle_id, def.phase);
  for (const expected of def.expected_outputs) {
    // #126 : un id historique (gpt6/sol) tient le rôle de toute sa famille
    // logique, mais la famille ne compte qu'une fois dans COUNT(DISTINCT).
    const eventIdentity = "COALESCE((SELECT family_id FROM participant_identity_families ef WHERE ef.participant_id = e.participant_id), e.participant_id)";
    const ownerIdentity = "COALESCE((SELECT family_id FROM participant_identity_families tf WHERE tf.participant_id = t.owner_pid), t.owner_pid)";
    const reviewerIdentity = "COALESCE((SELECT family_id FROM participant_identity_families tf WHERE tf.participant_id = t.reviewer_pid), t.reviewer_pid)";
    const testerIdentity = "COALESCE((SELECT family_id FROM participant_identity_families tf WHERE tf.participant_id = t.tester_pid), t.tester_pid)";
    const lines = [
      'SELECT COUNT(DISTINCT ' + eventIdentity + ') AS n',
      'FROM events e',
      'WHERE e.cycle_id = ?1 AND e.type = ?2',
      'AND e.seq > ?4',
    ];
    const roleChecks = [
      "((?3 = 'author' OR ?3 = 'owner') AND " + ownerIdentity + ' = ' + eventIdentity + ')',
      "(?3 = 'reviewer' AND " + reviewerIdentity + ' = ' + eventIdentity + ')',
      "(?3 = 'tester' AND " + testerIdentity + ' = ' + eventIdentity + ')',
    ];
    const params: unknown[] = [def.cycle_id, expected.kind, expected.role, entrySeq];
    if (expected.task_id) {
      lines.push(
        'AND json_valid(e.payload_json)',
        "AND json_extract(e.payload_json, '$.task') = ?5",
        'AND EXISTS (SELECT 1 FROM tasks t WHERE t.cycle_id = e.cycle_id AND t.task_id = ?5 AND ('
          + roleChecks.join(' OR ') + '))',
      );
      params.push(expected.task_id);
    } else {
      lines.push(
        'AND EXISTS (SELECT 1 FROM tasks t WHERE t.cycle_id = e.cycle_id AND (' + roleChecks.join(' OR ') + '))',
      );
    }
    const count = await db.prepare(lines.join(' ')).bind(...params).first<{ n: number }>();
    if ((count?.n ?? 0) < expected.count) return false;
  }
  return true;
}

export async function inspectPhase(db: D1Database, cycleId: string): Promise<PhaseFacts & { revision: number; phase: Phase }> {
  await ensureSchema(db);
  const cycle = await db.prepare('SELECT phase, revision FROM cycles WHERE cycle_id = ?1')
    .bind(cycleId).first<{ phase: Phase; revision: number }>();
  if (!cycle) throw new CollabStoreError('UNKNOWN_CYCLE', 'Cycle inconnu : ' + cycleId);
  assertPhase(cycle.phase);
  const def = await definition(db, cycleId, cycle.phase);
  return { phase: cycle.phase, revision: cycle.revision, definition: def, outputsSatisfied: await outputsSatisfied(db, def) };
}

export async function advanceByPolicy(db: D1Database, input: {
  cycle_id: string;
  expected_revision: number;
  policy_id: string;
  next_phase: Phase;
  now?: () => Date;
  conditionsSatisfied?: (conditions: string[]) => Promise<boolean> | boolean;
}): Promise<{ status: 'applied' | 'duplicate'; revision: number; event_seq: number }> {
  await ensureSchema(db);
  assertPhase(input.next_phase);
  const facts = await inspectPhase(db, input.cycle_id);
  if (facts.revision !== input.expected_revision) {
    throw new CollabStoreError('STALE', 'Révision attendue ' + input.expected_revision + ', courante ' + facts.revision + '.');
  }
  if (facts.definition.auto_advance === 'none' || facts.definition.auto_advance !== input.policy_id) {
    throw new CollabStoreError('POLICY_NOT_AUTHORIZED', 'La policy ne correspond pas à auto_advance.');
  }
  if (!facts.outputsSatisfied) throw new CollabStoreError('PHASE_OUTPUTS_INCOMPLETE', 'Sorties attendues incomplètes.');
  const evaluate = input.conditionsSatisfied ?? (async conditions => conditions.length === 0);
  if (!await evaluate(facts.definition.exit_conditions)) {
    throw new CollabStoreError('PHASE_EXIT_CONDITIONS_UNMET', 'Conditions de sortie non remplies.');
  }

  const key = ['policy', input.cycle_id, input.policy_id, facts.phase, input.next_phase, input.expected_revision].join(':');
  const existing = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number }>();
  if (existing) return { status: 'duplicate', revision: input.expected_revision + 1, event_seq: existing.seq };

  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  try {
    await db.batch([
      db.prepare([
        'INSERT INTO collab_store_guard (ok)',
        'SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE idempotency_key = ?1)',
        'AND COALESCE((SELECT revision FROM cycles WHERE cycle_id = ?2), 0) = ?3',
        // CC-Owner V2 L5 (contre-revue Claude seq 671) : un cycle clos ne change
        // plus de phase — statut revérifié dans le lot, comme pour les appends (L1).
        'AND ' + CYCLE_OPEN_GUARD,
        // CC-4 A2 (revue #115 R1) : l'avance par policy est automatique — un arrêt
        // d'urgence posé après le pré-check annule le lot (garde dans la transaction).
        'AND NOT ' + HALT_ACTIVE_SQL + ' THEN 1 ELSE 0 END',
      ].join(' ')).bind(key, input.cycle_id, input.expected_revision),
      db.prepare([
        'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
        "VALUES (?1, ?2, 'phase.advance', ?3, '', 'policy', ?4, ?5, ?6, ?7)",
      ].join(' ')).bind(
        input.cycle_id,
        at,
        'policy:' + input.policy_id,
        JSON.stringify({ from: facts.phase, to: input.next_phase, policy_id: input.policy_id }),
        input.expected_revision,
        key,
        'policy:' + input.policy_id,
      ),
      db.prepare('UPDATE cycles SET phase = ?2, revision = ?3 WHERE cycle_id = ?1 AND revision = ?4')
        .bind(input.cycle_id, input.next_phase, input.expected_revision + 1, input.expected_revision),
      // CR-F04 (#96) : une transition avance la révision, donc les échéances du cycle.
      expireDueHypotheses(db, input.cycle_id),
      // Reveal only still-sealed items for the *leaving* phase. Items from a prior
      // completed visit already have revealed_at set; new-round seals stay NULL until this advance.
      db.prepare(
        'UPDATE sealed_items SET revealed_at = ?3 WHERE cycle_id = ?1 AND phase = ?2 AND revealed_at IS NULL'
      ).bind(input.cycle_id, facts.phase, at),
      db.prepare('DELETE FROM collab_store_guard'),
    ]);
  } catch (error) {
    const winner = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number }>();
    if (winner) return { status: 'duplicate', revision: input.expected_revision + 1, event_seq: winner.seq };
    await assertAutomationRunning(db);
    const current = await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(input.cycle_id).first<{ revision: number }>();
    if ((current?.revision ?? 0) !== input.expected_revision) {
      throw new CollabStoreError('STALE', 'Le cycle a avancé pendant la transition.');
    }
    // CC-Owner V2 L5 (contre-revue Claude seq 671) : cycle clos entre-temps →
    // CYCLE_CLOSED. Le rejeu d’une avance déposée avant clôture reste duplicate
    // (contrôlé ci-dessus) ; une écriture en vol reste STALE puis CYCLE_CLOSED au
    // nouvel essai — même convention que la garde des appends (L1).
    const closed = await db.prepare('SELECT status FROM cycles WHERE cycle_id = ?1').bind(input.cycle_id).first<{ status: string }>();
    if (closed?.status === 'closed') {
      throw new CollabStoreError('CYCLE_CLOSED', 'Cycle clos par le propriétaire : aucune avance de phase.');
    }
    throw error;
  }
  const event = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number }>();
  return { status: 'applied', revision: input.expected_revision + 1, event_seq: event!.seq };
}
