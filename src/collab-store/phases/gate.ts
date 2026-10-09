/**
 * CC-3 F5 / A07 — transitions de phase explicitement permises.
 * Une avance n'est acceptée que si la cible a une définition, que ses
 * entry_conditions sont satisfaites, et que le rejeu d'une réponse perdue
 * est détecté avant STALE (clé indépendante de la phase observée).
 */
import type { Phase } from '../../collab/contracts';
import { assertPhase } from '../../collab/contracts';
import { CollabStoreError } from '../store/collab-store';
import { advanceByPolicy, inspectPhase } from './engine';
import { ensureSchema } from '../store/schema';

const ALLOWED: Record<string, readonly string[]> = {
  P1: ['P2'],
  P2: ['P3', 'P1'],
  P3: ['P4', 'P2'],
  P4: ['P5', 'P3'],
  P5: ['P6', 'P4'],
  P6: [],
};

export function allowedNextPhases(from: string): readonly string[] {
  return ALLOWED[from] ?? [];
}

export function assertAllowedTransition(from: string, to: string): void {
  assertPhase(from);
  assertPhase(to);
  if (!allowedNextPhases(from).includes(to)) {
    throw new CollabStoreError(
      'PHASE_TRANSITION_FORBIDDEN',
      'Transition ' + from + ' -> ' + to + ' non autorisée.',
    );
  }
}

/**
 * A07 — rejeu avant toute validation dépendante de l'état courant.
 * La clé policy inclut la phase *source* observée au premier succès ;
 * après avance, facts.phase a changé. On retrouve donc l'événement par
 * (cycle, expected_rev, payload.to) — intention stable, pas la phase
 * courante.
 */
async function findReplay(
  db: D1Database,
  cycleId: string,
  expectedRevision: number,
  nextPhase: string,
): Promise<{ seq: number } | null> {
  return db.prepare([
    "SELECT seq FROM events WHERE cycle_id = ?1 AND type = 'phase.advance'",
    'AND expected_rev = ?2 AND json_valid(payload_json)',
    "AND json_extract(payload_json, '$.to') = ?3 LIMIT 1",
  ].join(' ')).bind(cycleId, expectedRevision, nextPhase).first<{ seq: number }>();
}

export async function advanceGuarded(db: D1Database, input: {
  cycle_id: string;
  expected_revision: number;
  /** Ignored for authorization: policy is taken from the current phase definition. */
  policy_id?: string;
  next_phase: Phase;
  now?: () => Date;
  conditionsSatisfied?: (conditions: string[]) => Promise<boolean> | boolean;
}): Promise<{ status: 'applied' | 'duplicate'; revision: number; event_seq: number }> {
  await ensureSchema(db);
  assertPhase(input.next_phase);

  const replay = await findReplay(db, input.cycle_id, input.expected_revision, input.next_phase);
  if (replay) {
    return { status: 'duplicate', revision: input.expected_revision + 1, event_seq: replay.seq };
  }

  const facts = await inspectPhase(db, input.cycle_id);
  assertAllowedTransition(facts.phase, input.next_phase);

  // Policy authority is server-side only (A07 / C3): never trust a client-forged policy_id.
  const policyId = facts.definition.auto_advance;
  if (!policyId || policyId === 'none') {
    throw new CollabStoreError(
      'POLICY_NOT_AUTHORIZED',
      'Aucune policy auto_advance pour la phase courante ' + facts.phase + '.',
    );
  }

  const target = await db.prepare(
    'SELECT entry_conditions FROM phase_definitions WHERE cycle_id = ?1 AND phase = ?2',
  ).bind(input.cycle_id, input.next_phase).first<{ entry_conditions: string }>();
  if (!target) {
    throw new CollabStoreError('PHASE_DEFINITION_MISSING', 'Définition absente pour ' + input.next_phase + '.');
  }
  const entry = JSON.parse(target.entry_conditions) as string[];
  const evaluate = input.conditionsSatisfied ?? (async (conditions: string[]) => conditions.length === 0);
  if (!await evaluate(entry)) {
    throw new CollabStoreError('PHASE_ENTRY_CONDITIONS_UNMET', 'Conditions d\'entrée non remplies.');
  }

  return advanceByPolicy(db, {
    cycle_id: input.cycle_id,
    expected_revision: input.expected_revision,
    policy_id: policyId,
    next_phase: input.next_phase,
    now: input.now,
    conditionsSatisfied: input.conditionsSatisfied,
  });
}
