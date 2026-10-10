/**
 * CC-3 CR-F02 (github-mcp#93, contre-revue Codex #79/6096598889) — reprise owner
 * d'une pause des activations mémoire.
 *
 * Une alarme C4 (croissance nette, invariant touché, réfutations) met les
 * activations d'un scope en pause et ouvre une nouvelle occurrence. Le parcours
 * prévu (guide §9) est raccordé de bout en bout :
 * 1. dans la transaction qui pose la pause, une `owner.request` système est
 *    déposée dans le cycle `memory-alarms`, avec l'identifiant exact de cette
 *    occurrence (`mem-pause-<sha256(scope)[0:20]>-<occurrence>`) ;
 * 2. Kevin la tranche sur /owner (canal C5 authentifié, décision liée à la seq) ;
 * 3. une approbation de l'occurrence courante lève la pause DANS la transaction
 *    de la décision, et fixe la base de croissance à la taille approuvée.
 * Une approbation qui ne vise aucune pause courante (autre scope, occurrence
 * ancienne ou future) est refusée sans écriture ; un refus maintient la pause.
 *
 * Module sans import du store ni du MemoryStore (ce dernier l'importe) : il
 * fournit des clés, des identifiants et des statements à joindre aux batchs.
 */

export const PAUSE_REQUEST_PREFIX = 'mem-pause-';
/** Cycle système qui porte les demandes owner déposées par les alarmes mémoire. */
export const MEMORY_ALARM_CYCLE = 'memory-alarms';
/** Participant réservé (non enregistrable, C5) : aucun agent ne peut parler en son nom. */
export const MEMORY_ALARM_PARTICIPANT = 'system';

export const pauseKey = (scope: string): string => `mem:pause:${scope}`;
export const occurrenceKey = (scope: string): string => `mem:occ:${scope}`;
export const baselineKey = (scope: string): string => `mem:base:${scope}`;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Pause-clearing approvals are bound to the scope's current pause occurrence. */
export async function pauseRequestId(scope: string, occurrence: number): Promise<string> {
  return PAUSE_REQUEST_PREFIX + (await sha256Hex(scope)).slice(0, 20) + '-' + occurrence;
}

export function isPauseRequestId(requestId: string): boolean {
  return requestId.startsWith(PAUSE_REQUEST_PREFIX);
}

export type PauseReason = 'growth' | 'invariant' | 'refute';

/**
 * Statements qui déposent l'owner.request de l'occurrence ouverte DANS la même
 * transaction, seulement si l'occurrence a avancé depuis `occurrenceBefore`
 * (une alarme de croissance est conditionnelle) et une seule fois par
 * occurrence (clé d'idempotence `memory-pause:<scope>:<occurrence>`). Le cycle
 * `memory-alarms` suit la même règle de révision que le journal (expected_rev
 * = révision avant l'événement, puis +1).
 */
export async function alarmRequestStatements(
  db: D1Database,
  scope: string,
  occurrenceBefore: number,
  reason: PauseReason,
  at: number,
): Promise<D1PreparedStatement[]> {
  const occurrence = '(SELECT writes FROM quota_counters WHERE day = ?2)';
  const raised = `${occurrence} > ?3 AND NOT EXISTS (SELECT 1 FROM events WHERE idempotency_key = ?4 || ${occurrence})`;
  const idPrefix = PAUSE_REQUEST_PREFIX + (await sha256Hex(scope)).slice(0, 20) + '-';
  const keyPrefix = `memory-pause:${scope}:`;
  const summary = [
    `'Activations mémoire en pause (alarme ' || ?6 || ') dans le scope ' || ?5 || ', occurrence ' || ${occurrence}`,
    `'. Approuver lève cette pause et prend la taille actuelle du scope comme nouvelle base de croissance ; refuser la maintient.'`,
  ].join(' || ');
  return [
    db.prepare(`INSERT INTO cycles (cycle_id, revision) SELECT ?1, 0 WHERE ${raised} ON CONFLICT(cycle_id) DO NOTHING`)
      .bind(MEMORY_ALARM_CYCLE, occurrenceKey(scope), occurrenceBefore, keyPrefix),
    db.prepare([
      'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
      `SELECT ?1, ?7, 'owner.request', ?8, '', 'system',`,
      `  json_object('request_id', ?9 || ${occurrence}, 'summary', ${summary}, 'kind', 'memory.pause',`,
      `    'scope', ?5, 'occurrence', ${occurrence}, 'reason', ?6),`,
      `  (SELECT revision FROM cycles WHERE cycle_id = ?1), ?4 || ${occurrence}, ''`,
      `WHERE ${raised}`,
    ].join(' ')).bind(MEMORY_ALARM_CYCLE, occurrenceKey(scope), occurrenceBefore, keyPrefix, scope, reason, at,
      MEMORY_ALARM_PARTICIPANT, idPrefix),
    db.prepare([
      'UPDATE cycles SET revision = revision + 1 WHERE cycle_id = ?1',
      `AND EXISTS (SELECT 1 FROM events WHERE idempotency_key = ?3 || ${occurrence} AND expected_rev = cycles.revision)`,
    ].join(' ')).bind(MEMORY_ALARM_CYCLE, occurrenceKey(scope), keyPrefix),
  ];
}

export interface PauseOccurrence {
  scope: string;
  occurrence: number;
}

/**
 * La pause courante qu'un identifiant de demande désigne exactement, ou null.
 * Seules les pauses actives sont candidates ; l'identifiant est recalculé côté
 * serveur depuis (scope, occurrence courante) : le contenu d'une demande n'est
 * jamais cru. Une requête D1 (jointure pause ↔ occurrence), quel que soit le
 * nombre de scopes.
 */
export async function currentPauseOf(db: D1Database, requestId: string): Promise<PauseOccurrence | null> {
  if (!isPauseRequestId(requestId)) return null;
  const { results } = await db.prepare([
    "SELECT substr(p.day, 11) AS scope, COALESCE(o.writes, 0) AS occurrence FROM quota_counters p",
    "LEFT JOIN quota_counters o ON o.day = 'mem:occ:' || substr(p.day, 11)",
    "WHERE p.day LIKE 'mem:pause:%' AND p.writes > 0",
  ].join(' ')).all<PauseOccurrence>();
  for (const row of results) {
    if (await pauseRequestId(row.scope, row.occurrence) === requestId) return row;
  }
  return null;
}

/**
 * Garde SQL de la reprise, évaluée dans la transaction de la décision : la
 * pause est toujours posée et son occurrence n'a pas avancé depuis la lecture.
 * `firstBind` est le premier numéro de paramètre libre du garde appelant.
 */
export function resumeGuard(pause: PauseOccurrence, firstBind: number): { sql: string; binds: unknown[] } {
  const [p, o, n] = [firstBind, firstBind + 1, firstBind + 2];
  return {
    sql: `EXISTS (SELECT 1 FROM quota_counters WHERE day = ?${p} AND writes > 0)`
      + ` AND COALESCE((SELECT writes FROM quota_counters WHERE day = ?${o}), 0) = ?${n}`,
    binds: [pauseKey(pause.scope), occurrenceKey(pause.scope), pause.occurrence],
  };
}

/**
 * Effets de la reprise, dans le batch de la décision owner : la pause est
 * levée et la base de croissance devient la taille active approuvée (sans
 * quoi chaque activation suivante rouvrirait aussitôt une alarme). L'occurrence
 * ne change pas : la prochaine alarme ouvre l'occurrence suivante.
 */
export function resumeStatements(db: D1Database, pause: PauseOccurrence): D1PreparedStatement[] {
  return [
    db.prepare('UPDATE quota_counters SET writes = 0 WHERE day = ?1').bind(pauseKey(pause.scope)),
    db.prepare([
      'INSERT OR REPLACE INTO quota_counters (day, writes)',
      "SELECT ?1, MAX(1, (SELECT COUNT(*) FROM memory_entries WHERE status = 'active' AND scope = ?2))",
    ].join(' ')).bind(baselineKey(pause.scope), pause.scope),
  ];
}
