import { assertPhase, type Phase } from '../../collab/contracts';
import { validatePhaseDefinition, type PhaseDefinition } from '../contracts';
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';

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

async function outputsSatisfied(db: D1Database, def: PhaseDefinition): Promise<boolean> {
  for (const expected of def.expected_outputs) {
    const count = await db.prepare(
      'SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND role = ?2 AND type = ?3'
    ).bind(def.cycle_id, expected.role, expected.kind).first<{ n: number }>();
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
        'AND COALESCE((SELECT revision FROM cycles WHERE cycle_id = ?2), 0) = ?3 THEN 1 ELSE 0 END',
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
      db.prepare(
        'UPDATE sealed_items SET revealed_at = ?3 WHERE cycle_id = ?1 AND phase = ?2 AND revealed_at IS NULL'
      ).bind(input.cycle_id, facts.phase, at),
      db.prepare('DELETE FROM collab_store_guard'),
    ]);
  } catch (error) {
    const winner = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number }>();
    if (winner) return { status: 'duplicate', revision: input.expected_revision + 1, event_seq: winner.seq };
    const current = await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(input.cycle_id).first<{ revision: number }>();
    if ((current?.revision ?? 0) !== input.expected_revision) {
      throw new CollabStoreError('STALE', 'Le cycle a avancé pendant la transition.');
    }
    throw error;
  }
  const event = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number }>();
  return { status: 'applied', revision: input.expected_revision + 1, event_seq: event!.seq };
}
