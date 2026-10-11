/**
 * CR-F01 — seq of the most recent phase.advance that *entered* this phase.
 * Events with seq <= this value belong to a prior visit and must not satisfy
 * the current round's expected_outputs. 0 = first visit (no prior entry event).
 *
 * CC-4 A0 : extrait de phases/engine.ts — le store (garde
 * PROPOSAL_ALREADY_SUBMITTED, « une sortie par ronde ») a besoin de la même
 * frontière de ronde sans importer le moteur ni créer un cycle d'imports.
 */
export async function phaseEntrySeq(db: D1Database, cycleId: string, phase: string): Promise<number> {
  const row = await db.prepare([
    'SELECT MAX(seq) AS n FROM events',
    "WHERE cycle_id = ?1 AND type = 'phase.advance'",
    'AND json_valid(payload_json)',
    "AND json_extract(payload_json, '$.to') = ?2",
  ].join(' ')).bind(cycleId, phase).first<{ n: number | null }>();
  return row?.n ?? 0;
}
