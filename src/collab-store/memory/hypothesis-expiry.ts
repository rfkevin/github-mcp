/**
 * CC-3 CR-F04 (github-mcp#96, contre-revue Codex #79/6096598889) — expiration
 * des hypothèses, isolée par cycle.
 *
 * Référence temporelle (décision Kevin, 2026-10-10) : une hypothèse expire
 * quand SON cycle d'origine — celui dont l'append l'a proposée ou renouvelée,
 * mémorisé dans `expires_cycle` — atteint `expires_rev`. La révision d'un
 * autre cycle n'est jamais comparée à `expires_rev` : les révisions sont des
 * compteurs par cycle, sans ordre commun.
 *
 * Raccordement au lifecycle : chaque transaction qui fait avancer la révision
 * d'un cycle (append du journal, décision owner, transition de phase, demande
 * d'alarme mémoire) inclut `expireDueHypotheses(db, cycle)`. L'hypothèse due
 * passe `retired` (pierre tombale, jamais d'effacement) DANS la transaction
 * qui atteint son échéance : aucune lecture ni export ne la voit active
 * ensuite, sans balayage global ni écriture à la lecture. Idempotent (seules
 * les lignes active/candidate encore dues changent), une requête indexée par
 * transaction, sans plafond applicatif.
 *
 * Renouvellement (décision Kevin) : une consolidation qui reste au niveau
 * `hypothesis` ouvre une fenêtre complète depuis le cycle qui consolide ; une
 * hausse de confiance (preuve pair F03) retire l'expiration.
 */

export interface ExpiringRow {
  confidence: string;
  expires_rev: number | null;
  expires_cycle?: string | null;
}

/**
 * Retire, dans la transaction appelante, les hypothèses de `cycleId` dont
 * l'échéance est atteinte par la révision COURANTE de ce cycle. À placer
 * APRÈS la mise à jour de révision du batch : la sous-requête lit alors la
 * nouvelle révision. Les autres cycles ne sont jamais touchés.
 */
export function expireDueHypotheses(db: D1Database, cycleId: string): D1PreparedStatement {
  return db.prepare([
    "UPDATE memory_entries SET status = 'retired'",
    "WHERE expires_cycle = ?1 AND confidence = 'hypothesis' AND status IN ('active', 'candidate')",
    '  AND expires_rev <= COALESCE((SELECT revision FROM cycles WHERE cycle_id = ?1), 0)',
  ].join(' ')).bind(cycleId);
}

/** Vrai pour une hypothèse soumise à expiration (cycle d'origine connu). */
export function expiresInCycle(row: ExpiringRow): row is ExpiringRow & { expires_rev: number; expires_cycle: string } {
  return row.confidence === 'hypothesis' && row.expires_rev != null && row.expires_cycle != null;
}

/**
 * L'hypothèse est-elle échue à la révision `revision` de son cycle d'origine ?
 * `revision` doit être une révision de `row.expires_cycle`, jamais d'un autre cycle.
 */
export function isDueAt(row: ExpiringRow, revision: number): boolean {
  return expiresInCycle(row) && row.expires_rev <= revision;
}
