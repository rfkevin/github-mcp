/**
 * CC-8 S8a (CC-PLAN-8, consultation S8a — AGREE seq 1402/1403, AMEND seq 1404,
 * GO de Kevin) — réveil événementiel du planificateur d'exécutions API.
 *
 * Constat (2026-11-02, cc8-systeme-unique) : un réveil ne partait qu'au passage
 * du contrôleur (webhook GitHub ou passage programmé quart d'heure) ; une
 * question posée à un agent, un claim ou une preuve déposée attendaient le
 * prochain passage avant qu'une exécution soit créée pour y répondre.
 *
 * Principe : après une écriture APPLIQUÉE (jamais duplicate, STALE ni refusée)
 * d'un type réveil, le canal /collab/mcp (et le canal /owner pour les décisions)
 * programme le MÊME passage que le webhook via ctx.waitUntil — jamais bloquant
 * pour la réponse du canal. Garde-fous S1a/S1b-2 inchangés : le passage appelle
 * le planificateur existant (capacité, AGENT_PAUSED, politique unique) et les
 * étapes restent des alarmes du Durable Object, jamais du waitUntil.
 *
 * Anti-rafale : un bail D1 atomique (agent_run_pass_lease, singleton mutable)
 * limite à UN passage événementiel par PASS_LEASE_TTL_S ; le webhook et le
 * passage programmé quart d'heure restent inchangés — ce dernier demeure le
 * filet de sécurité si un réveil événementiel est perdu.
 */
import { agentRunPass, type WakeFn } from './orchestrator';
import { agentRunDb, wakeViaNamespace, type AgentRunObjectEnv } from './object';
import { ensureAgentRunSchema } from './schema';

/** Types d'événement dont l'application déclenche un passage (mission S8a, AMEND seq 1404). */
export const WAKE_EVENT_TYPES = ['clarify.ask', 'evidence.add', 'task.claim', 'task.status', 'task.handoff',
  'owner.decision', 'round.add'] as const;

/** Un événement mérite-t-il un passage ? clarify.ask ne réveille que si la question est adressée (to non vide). */
export function wakeWorthy(type: string, payloadJson: string): boolean {
  if (type === 'clarify.ask') {
    try {
      const payload = JSON.parse(payloadJson) as { to?: unknown };
      return typeof payload.to === 'string' && payload.to.length > 0;
    } catch {
      return false; // payload illisible : pas de réveil (l'écriture reste appliquée ; cron = filet)
    }
  }
  return (WAKE_EVENT_TYPES as readonly string[]).includes(type);
}

/** Durée du bail anti-rafale : au plus un passage événementiel par minute (D1 fait foi). */
export const PASS_LEASE_TTL_S = 60;

/**
 * Bail du passage événementiel : INSERT…ON CONFLICT…WHERE expiré (CAS D1, une
 * seule instruction). true = bail acquis, ce passage est le seul de la fenêtre.
 */
export async function acquireEventPassLease(db: D1Database, now: number, holder: string): Promise<boolean> {
  await ensureAgentRunSchema(db);
  const result = await db.prepare([
    'INSERT INTO agent_run_pass_lease (id, holder, expires_at) VALUES (1, ?1, ?2)',
    'ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at',
    '  WHERE agent_run_pass_lease.expires_at <= ?3',
  ].join(' ')).bind(holder, now + PASS_LEASE_TTL_S, now).run();
  return result.meta.changes === 1;
}

/** Événement appliqué présenté au réveil (champs minimaux du journal). */
export type WakeEvent = { type: string; payload_json: string };

/**
 * Fabrique le hook de réveil d'un canal. Inerte (fonction vide) hors service :
 * AGENT_RUNS_ENABLED n'est pas « true », binding AGENT_RUN ou base absents —
 * la réponse du canal ne dépend jamais de l'orchestrateur.
 */
export function eventWake(env: AgentRunObjectEnv, ctx: Pick<ExecutionContext, 'waitUntil'>,
  wake?: WakeFn): (event: WakeEvent) => void {
  // Même garde que scheduleAgentRunPass (src/index.ts) : hors cc3-test, rien n'est programmé.
  if (env.AGENT_RUNS_ENABLED !== 'true' || !env.AGENT_RUN) return () => undefined;
  const db = agentRunDb(env);
  if (!db) return () => undefined;
  const wakeFn = wake ?? wakeViaNamespace(env.AGENT_RUN);
  return event => {
    try {
      // Seule une écriture APPLIQUÉE d'un type réveil programme un passage : le hook
      // n'est jamais appelé sur duplicate, STALE ni refusé (appendWithWake, collab-store.ts).
      if (!wakeWorthy(event.type, event.payload_json)) return;
      ctx.waitUntil((async () => {
        const now = Math.floor(Date.now() / 1000);
        const holder = 'event-pass:' + crypto.randomUUID();
        // Anti-rafale : sans le bail, rien ne part (le passage programmé reprend).
        if (!await acquireEventPassLease(db, now, holder)) return;
        await agentRunPass(db, env, { now, deliverer: holder, wake: wakeFn }).catch(() => undefined);
      })());
    } catch {
      // Jamais bloquant : une erreur de programmation ne remonte pas au canal.
    }
  };
}
