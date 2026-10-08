/**
 * CC-3 F5 / A07 — transitions de phase explicitement permises.
 * Une avance n'est acceptée que si la cible a une définition, que ses
 * entry_conditions sont satisfaites, et que le rejeu d'une réponse perdue
 * est détecté avant STALE.
 */
import type { Phase } from '../../collab/contracts';
import { assertPhase } from '../../collab/contracts';
import { CollabStoreError } from '../store/collab-store';
import { advanceByPolicy, inspectPhase } from './engine';

const ALLOWED: Record<string, readonly string[]> = {
  framing: ['proposals', 'closed'],
  proposals: ['objections', 'vote', 'closed'],
  objections: ['vote', 'proposals', 'closed'],
  vote: ['implementation', 'closed'],
  implementation: ['review', 'closed'],
  review: ['done', 'implementation', 'closed'],
  done: ['closed'],
  closed: [],
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

function policyKey(cycleId: string, policyId: string, from: string, to: string, revision: number): string {
  return ['policy', cycleId, policyId, from, to, revision].join(':');
}

export async function advanceGuarded(db: D1Database, input: {
  cycle_id: string;
  expected_revision: number;
  policy_id: string;
  next_phase: Phase;
  now?: () => Date;
  conditionsSatisfied?: (conditions: string[]) => Promise<boolean> | boolean;
}): Promise<{ status: 'applied' | 'duplicate'; revision: number; event_seq: number }> {
  const facts = await inspectPhase(db, input.cycle_id);
  assertAllowedTransition(facts.phase, input.next_phase);
  const key = policyKey(input.cycle_id, input.policy_id, facts.phase, input.next_phase, input.expected_revision);
  const replay = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number }>();
  if (replay) return { status: 'duplicate', revision: input.expected_revision + 1, event_seq: replay.seq };
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
  return advanceByPolicy(db, input);
}
