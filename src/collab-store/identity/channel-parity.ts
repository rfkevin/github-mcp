/**
 * CC-7 L1 — parité des canaux (S1).
 *
 * Un participant est une identité serveur unique. Chat et API sont des canaux
 * d'accès, jamais des sources de droits. Toute autorisation (append, phase,
 * outils MCP, baux) s'appuie uniquement sur participant_id (+ rôle tâche),
 * jamais sur un champ « channel ».
 *
 * Ce module formalise le contrat pour les tests et les futurs appelants : un
 * argument channel optionnel est accepté pour la télémétrie, mais ignoré pour
 * les décisions de sécurité.
 */

/** Canaux d'accès reconnus (informels, non autorisants). */
export type AccessChannel = 'chat' | 'api' | 'unknown';

/** Normalise une étiquette de canal ; valeur inconnue → 'unknown'. */
export function normalizeAccessChannel(raw: unknown): AccessChannel {
  if (raw === 'chat' || raw === 'api') return raw;
  return 'unknown';
}

/**
 * Les droits ne dépendent pas du canal. Deux appels avec le même participant
 * et des canaux différents doivent produire la même décision d'autorisation.
 * Utilisé en tests pour figer le contrat S1.
 */
export function authorizationKey(participantId: string, _channel?: AccessChannel): string {
  return participantId;
}

/** True si left et right donnent la même clé d'autorisation (parité). */
export function sameAuthorization(left: string, right: string, channelLeft?: AccessChannel, channelRight?: AccessChannel): boolean {
  return authorizationKey(left, channelLeft) === authorizationKey(right, channelRight);
}
