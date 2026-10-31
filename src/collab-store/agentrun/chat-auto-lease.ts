/**
 * CC-7 L15 (décision de Kevin du 2026-10-31) — le bail du chat est pris AUTOMATIQUEMENT.
 *
 * Constat (seq 1157 et 1160 du cycle cc7-api-auto) : le bail du chat (fencing 7a, outil
 * collab_preempt_agent_run, CC-7 L1) existait mais personne ne le prenait ; un chat qui codait
 * plus de 15 minutes sans rien écrire laissait le planificateur lancer l'API du même agent sur
 * la même tâche, et une exécution déjà partie continuait d'écrire après le retour du chat.
 *
 * Règle : toute écriture d'un chat (canal MCP collab_append_event, jamais le canal API) qui porte
 * une tâche et dont le type marque un travail sur cette tâche prend ou renouvelle le bail du chat
 * pour CHAT_AUTO_HOLD_SECONDS, pour chaque identité équivalente de l'agent (#126). Effets, tous
 * déjà portés par le moteur :
 * - createRun refuse toute nouvelle exécution API sur la tâche (« chat_holds_lease ») ;
 * - une exécution API en vol sur la tâche passe « preempted » et perd ses écritures suivantes.
 * Une tâche passée done / verified par le chat libère le bail. Le chat garde l'outil explicite
 * collab_preempt_agent_run (jusqu'à 24 h) et collab_release_agent_run (fin de session).
 */
import { preemptByChat, releaseChat } from './engine';
import { taskOfPayload } from '../context/active-work';

/** Durée du bail pris automatiquement, renouvelée à chaque écriture du chat sur la tâche. */
export const CHAT_AUTO_HOLD_SECONDS = 3600;

/** Types d'événement qui marquent un travail du chat sur une tâche. */
export const CHAT_AUTO_LEASE_TYPES: ReadonlySet<string> = new Set([
  'task.claim', 'task.status', 'task.handoff', 'checkpoint', 'evidence.add',
]);

/** Statuts de fin de tâche : le chat a fini, le bail est rendu. */
const FINISHED_STATUSES: ReadonlySet<string> = new Set(['done', 'verified']);

export type ChatLeaseEffect =
  | { task: string; action: 'held'; held_until: number }
  | { task: string; action: 'released' };

function finishedStatus(type: string, payloadJson: string): boolean {
  if (type !== 'task.status') return false;
  try {
    const payload = JSON.parse(payloadJson) as { task?: { status?: unknown } };
    return typeof payload?.task?.status === 'string' && FINISHED_STATUSES.has(payload.task.status);
  } catch {
    return false;
  }
}

/**
 * Prend, renouvelle ou rend le bail du chat après une écriture APPLIQUÉE du canal chat.
 * Renvoie null si l'événement ne porte pas de tâche ou n'est pas un travail sur une tâche.
 */
export async function applyChatAutoLease(db: D1Database, event: {
  cycle_id: string; type: string; at: number; payload_json: string;
}, identities: readonly string[]): Promise<ChatLeaseEffect | null> {
  if (!CHAT_AUTO_LEASE_TYPES.has(event.type)) return null;
  const task = taskOfPayload(event.payload_json);
  if (!task || !identities.length) return null;
  if (finishedStatus(event.type, event.payload_json)) {
    for (const participantId of identities) {
      await releaseChat(db, { cycleId: event.cycle_id, participantId, taskId: task, now: event.at });
    }
    return { task, action: 'released' };
  }
  for (const participantId of identities) {
    await preemptByChat(db, { cycleId: event.cycle_id, participantId, taskId: task, now: event.at, holdSeconds: CHAT_AUTO_HOLD_SECONDS });
  }
  return { task, action: 'held', held_until: event.at + CHAT_AUTO_HOLD_SECONDS };
}
