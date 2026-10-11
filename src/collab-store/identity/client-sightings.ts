/**
 * CC-3 — clients OAuth authentifiés observés sur /collab/mcp (UNKNOWN_CLIENT
 * pour les clients CIMD). Un client CIMD (client_id = URL publique de
 * métadonnées, ex. claude.ai, chatgpt.com) est lu à la demande par la
 * bibliothèque OAuth et jamais stocké : listClients() ne le contient pas, donc
 * son pseudonyme `unregistered:…` ne pouvait pas être retrouvé sur /owner.
 *
 * Règle de confiance : seul le client_id porté par un jeton VALIDÉ est
 * enregistré (appel de resolveTokenParticipant depuis le contexte d'outil),
 * jamais une valeur déclarée par un appelant. L'enregistrement n'accorde
 * aucune identité : il permet seulement à l'owner, authentifié sur /owner,
 * d'associer ce client par son pseudonyme.
 */
import { ensureSchema } from '../store/schema';

/** Idempotent : le premier passage fait foi, un rejeu n'écrit aucune ligne. */
export async function recordClientSighting(db: D1Database, clientId: string, pseudonym: string, now = Date.now()): Promise<void> {
  await ensureSchema(db);
  await db.prepare('INSERT OR IGNORE INTO oauth_client_sightings (oauth_client_id, pseudonym, first_seen) VALUES (?1, ?2, ?3)')
    .bind(clientId, pseudonym, Math.floor(now / 1000)).run();
}

/** Identifiants bruts observés sous ce pseudonyme (à revérifier par l'appelant). */
export async function sightedClientIds(db: D1Database, pseudonym: string): Promise<string[]> {
  await ensureSchema(db);
  const { results } = await db.prepare('SELECT oauth_client_id FROM oauth_client_sightings WHERE pseudonym = ?1 ORDER BY oauth_client_id')
    .bind(pseudonym).all<{ oauth_client_id: string }>();
  return results.map(row => row.oauth_client_id);
}
