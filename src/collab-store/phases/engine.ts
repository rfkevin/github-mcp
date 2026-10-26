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
  /** CC-7 L6b : détail par sortie attendue (réveils du contrôleur). */
  outputs: PhaseOutputStatus[];
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

/** CC-7 L6b : état d'une sortie attendue de la phase courante (titulaires du rôle, producteurs, manquants). */
export interface PhaseOutputStatus {
  role: string;
  kind: string;
  count: number;
  task_id: string | null;
  states: string[] | null;
  /** Identités logiques qui ont produit la sortie dans la visite courante (dernier état admis si `states`). */
  producers: string[];
  /** Identités logiques qui tiennent le rôle (sur la tâche nommée, sinon sur une tâche du cycle), avec une tâche où elles le tiennent. */
  holders: Array<{ who: string; task_id: string }>;
  satisfied: boolean;
  /** seq de l'entrée dans la phase (0 = première visite) : borne de la visite courante. */
  entry_seq: number;
}

const ACTIVE_TASK_STATUSES = new Set(['accepted', 'in_progress', 'review', 'proposed']);

/**
 * Sorties attendues de la visite courante (CR-F01 : seules les contributions après
 * l'entrée dans la phase comptent). #126 : un id historique tient le rôle de toute
 * sa famille logique, et la famille ne compte qu'une fois.
 * CC-7 L6b : `states` facultatif — seule compte l'identité dont la DERNIÈRE
 * contribution de la visite a un `state` de la liste (un vote OBJECTION ne compte
 * pas, et un AGREE suivi d'une OBJECTION non plus).
 */
export async function phaseOutputStatus(db: D1Database, def: PhaseDefinition): Promise<PhaseOutputStatus[]> {
  const entrySeq = await phaseEntrySeq(db, def.cycle_id, def.phase);
  const eventIdentity = "COALESCE((SELECT family_id FROM participant_identity_families ef WHERE ef.participant_id = e.participant_id), e.participant_id)";
  const ownerIdentity = "COALESCE((SELECT family_id FROM participant_identity_families tf WHERE tf.participant_id = t.owner_pid), t.owner_pid)";
  const reviewerIdentity = "COALESCE((SELECT family_id FROM participant_identity_families tf WHERE tf.participant_id = t.reviewer_pid), t.reviewer_pid)";
  const testerIdentity = "COALESCE((SELECT family_id FROM participant_identity_families tf WHERE tf.participant_id = t.tester_pid), t.tester_pid)";
  const roleChecks = [
    "((?3 = 'author' OR ?3 = 'owner') AND " + ownerIdentity + ' = ' + eventIdentity + ')',
    "(?3 = 'reviewer' AND " + reviewerIdentity + ' = ' + eventIdentity + ')',
    "(?3 = 'tester' AND " + testerIdentity + ' = ' + eventIdentity + ')',
  ];
  const { results: taskRows } = await db.prepare([
    'SELECT t.task_id, t.status,', ownerIdentity, 'AS owner,', reviewerIdentity, 'AS reviewer,', testerIdentity, 'AS tester',
    'FROM tasks t WHERE t.cycle_id = ?1 ORDER BY t.task_id',
  ].join(' ')).bind(def.cycle_id).all<{ task_id: string; status: string; owner: string; reviewer: string; tester: string }>();
  const out: PhaseOutputStatus[] = [];
  for (const expected of def.expected_outputs) {
    const lines = [
      'SELECT ' + eventIdentity + " AS who, CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json, '$.state') END AS state",
      'FROM events e',
      'WHERE e.cycle_id = ?1 AND e.type = ?2',
      'AND e.seq > ?4',
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
    lines.push('ORDER BY e.seq');
    const { results } = await db.prepare(lines.join(' ')).bind(...params).all<{ who: string; state: unknown }>();
    const states = expected.states ?? null;
    const latest = new Map<string, unknown>();
    for (const row of results) latest.set(row.who, row.state);
    const producers = [...latest.entries()]
      .filter(([, state]) => !states || (typeof state === 'string' && states.includes(state)))
      .map(([who]) => who).sort((a, b) => a.localeCompare(b));
    const field = expected.role === 'reviewer' ? 'reviewer' : expected.role === 'tester' ? 'tester'
      : (expected.role === 'author' || expected.role === 'owner') ? 'owner' : null;
    const holders = new Map<string, string>();
    if (field) {
      const scoped = taskRows.filter(row => !expected.task_id || row.task_id === expected.task_id);
      // Une tâche active d'abord (l'agent y agit), sinon n'importe quelle tâche où l'identité tient le rôle.
      for (const row of [...scoped.filter(r => ACTIVE_TASK_STATUSES.has(r.status)), ...scoped]) {
        if (!holders.has(row[field])) holders.set(row[field], row.task_id);
      }
    }
    out.push({ role: expected.role, kind: expected.kind, count: expected.count, task_id: expected.task_id ?? null, states,
      producers, holders: [...holders.entries()].map(([who, task_id]) => ({ who, task_id })).sort((a, b) => a.who.localeCompare(b.who)),
      satisfied: producers.length >= expected.count, entry_seq: entrySeq });
  }
  return out;
}


export async function inspectPhase(db: D1Database, cycleId: string): Promise<PhaseFacts & { revision: number; phase: Phase }> {
  await ensureSchema(db);
  const cycle = await db.prepare('SELECT phase, revision FROM cycles WHERE cycle_id = ?1')
    .bind(cycleId).first<{ phase: Phase; revision: number }>();
  if (!cycle) throw new CollabStoreError('UNKNOWN_CYCLE', 'Cycle inconnu : ' + cycleId);
  assertPhase(cycle.phase);
  const def = await definition(db, cycleId, cycle.phase);
  const outputs = await phaseOutputStatus(db, def);
  return { phase: cycle.phase, revision: cycle.revision, definition: def, outputs,
    outputsSatisfied: outputs.every(output => output.satisfied) };
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
