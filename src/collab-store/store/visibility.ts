/**
 * CC-3 CR-C (github-mcp#88, constat GPT6-01) — visibilité des événements du
 * journal selon l'identité serveur du lecteur.
 *
 * Les scopes mémoire `participant:<id>` sont privés (CRB-R1) : le packet ne les
 * montre qu'à leur propriétaire, mais le journal conservait le payload brut des
 * événements memory.* et le renvoyait à tout lecteur (collab_get_delta,
 * collab_get_context include_delta, delta d'une erreur STALE). Ce module filtre
 * ces sorties : un événement memory.* qui touche le scope privé d'un autre
 * participant est rendu avec un payload réduit aux métadonnées nécessaires au
 * lifecycle (id, version), sans texte, preuves ni champ libre.
 *
 * Règles (fail-closed) :
 * - le lecteur est l'identité serveur (jamais un participant_id fourni par le
 *   client) ; un client non enregistré est un lecteur anonyme (null) ;
 * - l'auteur d'un événement voit toujours son propre événement tel qu'écrit ;
 * - sinon, un événement memory.* est masqué si son scope est `participant:<x>`
 *   avec x ≠ lecteur, ou si son scope ne peut pas être déterminé ;
 * - seq, cycle_id, at, type, participant_id, expected_rev et idempotency_key
 *   sont conservés : curseurs de reprise, révisions et preuves d'idempotence
 *   restent intacts.
 * Le journal stocké n'est pas modifié (append-only) ; seul le rendu change.
 */
import type { StoredStoreEvent } from './collab-store';

const MEMORY_EVENT_TYPES = new Set(['memory.propose', 'memory.review', 'memory.consolidate', 'memory.retire']);

/** Marqueur du payload masqué (contrat public, documenté dans le guide). */
export const REDACTED_MEMORY_MARKER = 'private_scope';

function memoryOf(event: StoredStoreEvent): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(event.payload_json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const memory = (parsed as Record<string, unknown>).memory;
    return memory && typeof memory === 'object' && !Array.isArray(memory) ? memory as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isForeignPrivate(scope: string, viewer: string | null): boolean {
  return scope.startsWith('participant:') && (viewer === null || scope !== 'participant:' + viewer);
}

function redacted(event: StoredStoreEvent, memory: Record<string, unknown> | null): StoredStoreEvent {
  const kept: Record<string, unknown> = {};
  if (memory && typeof memory.id === 'string') kept.id = memory.id;
  if (memory && typeof memory.version === 'number' && Number.isSafeInteger(memory.version)) kept.version = memory.version;
  // Tous les champs libres de l'auteur sont vidés, y compris model_meta (migration
  // 0002, aucun chemin d'écriture public aujourd'hui : défense en profondeur).
  return {
    ...event,
    ...('model_meta' in event ? { model_meta: '' } : {}),
    session_id: '',
    role: '',
    evidence_ref: '',
    payload_json: JSON.stringify({ memory: kept, redacted: REDACTED_MEMORY_MARKER }),
  };
}

/**
 * Rend `events` pour `viewer` (participant enregistré, ou null pour un client
 * non enregistré). Lecture seule ; une requête par id mémoire distinct au plus.
 */
export async function redactEventsFor(
  db: D1Database,
  viewer: string | null,
  events: StoredStoreEvent[],
): Promise<StoredStoreEvent[]> {
  const scopesById = new Map<string, Promise<string[]>>();
  const scopesOf = (id: string): Promise<string[]> => {
    let pending = scopesById.get(id);
    if (!pending) {
      pending = db.prepare('SELECT DISTINCT scope FROM memory_entries WHERE id = ?1').bind(id)
        .all<{ scope: string }>().then(({ results }) => results.map(row => row.scope));
      scopesById.set(id, pending);
    }
    return pending;
  };
  return Promise.all(events.map(async (event) => {
    if (!MEMORY_EVENT_TYPES.has(event.type)) return event;
    if (viewer !== null && event.participant_id === viewer) return event;
    const memory = memoryOf(event);
    if (!memory) return redacted(event, null);
    const scopes: string[] = [];
    // memory.propose déclare son scope ; les autres types le tiennent de l'id.
    if (event.type === 'memory.propose' && typeof memory.scope === 'string') scopes.push(memory.scope);
    if (typeof memory.id === 'string') scopes.push(...await scopesOf(memory.id));
    // Scope indéterminable (propose sans id ni scope lisible, id inconnu) : masqué.
    if (scopes.length === 0) return redacted(event, memory);
    return scopes.some(scope => isForeignPrivate(scope, viewer)) ? redacted(event, memory) : event;
  }));
}
