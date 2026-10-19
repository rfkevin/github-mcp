/**
 * CC-5 L5 (révision 5, vague 2) — schéma interne du chercheur planifié (D3).
 *
 * Tables internes au lot L5, jamais dans le schéma canonique gelé
 * (src/collab-store/schema/0001_init.sql, possédé par C1) : le pattern est
 * celui des migrations internes du store (0005/0007/0008/0009) — SQL portable
 * (CREATE IF NOT EXISTS, aucune option moteur), créé dans UN lot D1, cache
 * process-local par WeakSet comme ensureSchema.
 *
 * Invariants du chercheur (incrément 1) :
 * - lecture seule sur events, memory_entries, cycles… : un passage ne modifie
 *   JAMAIS le registre canonique ; ses résultats vivent dans ces tables
 *   internes (le résumé n'est pas une source d'autorité, D3-b) ;
 * - aucun texte d'entrée mémoire n'est stocké : les scopes participant: sont
 *   privés (X2/CRB-R1), les findings ne portent que ids/scopes/kinds/compteurs ;
 * - fail-closed : HALT (owner_flags) → aucun passage enregistré ; cycle
 *   inconnu → refus typé.
 */
import { ensureSchema } from '../store/schema';

export const RESEARCH_SCHEMA = [
  [
    'CREATE TABLE IF NOT EXISTS research_passes (',
    '  pass_id TEXT PRIMARY KEY,',
    '  cycle_id TEXT,',
    '  at INTEGER NOT NULL,',
    '  findings_count INTEGER NOT NULL,',
    '  snapshot_sha256 TEXT NOT NULL,',
    "  status TEXT NOT NULL DEFAULT 'recorded'",
    ')',
  ].join('\n'),
  [
    'CREATE TABLE IF NOT EXISTS research_findings (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  pass_id TEXT NOT NULL REFERENCES research_passes(pass_id),',
    '  cycle_id TEXT,',
    '  kind TEXT NOT NULL,',
    '  scope TEXT,',
    '  detail_json TEXT NOT NULL,',
    '  at INTEGER NOT NULL',
    ')',
  ].join('\n'),
  'CREATE INDEX IF NOT EXISTS idx_research_findings_pass ON research_findings(pass_id)',
  'CREATE INDEX IF NOT EXISTS idx_research_findings_kind ON research_findings(kind)',
];

/** Kinds de findings émis par un passage du chercheur (incrément 1). */
export const RESEARCH_FINDING_KINDS = [
  'scope_stats',
  'cap_pressure',
  'archive_first',
  'consolidation_candidate',
  'journal_growth',
] as const;
export type ResearchFindingKind = (typeof RESEARCH_FINDING_KINDS)[number];

/** Erreur typée du module recherche (fail-closed). */
export class ResearchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ResearchError';
  }
}

const RESEARCH_ENSURED = new WeakSet<object>();

/**
 * Crée les tables internes du chercheur si absentes (idempotent ; force pour
 * les fixtures de test dont la base est réinitialisée sous un même binding).
 */
export async function ensureResearchSchema(db: D1Database, force = false): Promise<void> {
  if (!force && RESEARCH_ENSURED.has(db as unknown as object)) return;
  await ensureSchema(db, force);
  await db.batch(RESEARCH_SCHEMA.map(statement => db.prepare(statement)));
  RESEARCH_ENSURED.add(db as unknown as object);
}
