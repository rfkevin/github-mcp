/**
 * CC-8 S1a (CC-PLAN-8, synthèse seq 1262, validée par Kevin) — capacité réelle d'un agent API.
 *
 * Constat du 2026-11-01 (cc8-systeme-unique) : le planificateur créait des exécutions pour des agents
 * qui ne pouvaient pas tourner (Claude, Grok : aucune clé ni budget dans leur famille). Elles échouaient
 * aussitôt en MODEL_BUDGET_EXHAUSTED mais occupaient les places du passage (PLAN_LIMIT), si bien que
 * Gemini, dernier de la liste, n'était jamais servi.
 *
 * `runCapacity` répond AVANT toute création : l'agent a-t-il, maintenant, un modèle abordable pour ce
 * type d'exécution ? Même calcul que le choix réel d'une étape (participantPolicy + budgetState +
 * chooseModel, sans préférence : un modèle abordable existe-t-il dans la chaîne ?). Sans politique par
 * agent, le repli historique (participantModelRoute) reste la référence. Lecture seule, aucun appel réseau.
 */
import { budgetState, chooseModel, participantPolicy, type PolicyEnv } from './model-policy';
import { participantModelRoute } from './provider-models';

export interface RunCapacity {
  capable: boolean;
  /** Modèle qui serait choisi (capable) ou refus typé `CODE : détail` (incapable). */
  reason: string;
}

function errorText(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  return (typeof code === 'string' ? code + ' : ' : '') + message;
}

export async function runCapacity(db: D1Database, env: object, participantId: string, cycleId: string | null,
  kind: string, now: Date): Promise<RunCapacity> {
  let policy;
  try {
    policy = participantPolicy(env as PolicyEnv, participantId);
  } catch (error) {
    return { capable: false, reason: 'MODEL_POLICY_INVALID : ' + errorText(error) };
  }
  if (!policy) {
    const route = participantModelRoute(env as Parameters<typeof participantModelRoute>[0], participantId);
    return route ? { capable: true, reason: route.ref } : { capable: false, reason: 'NO_MODEL : aucune politique ni modèle global' };
  }
  const budget = await budgetState(db, policy.envelope, participantId, cycleId, now);
  try {
    return { capable: true, reason: chooseModel(env as PolicyEnv, policy, kind, budget, null).ref };
  } catch (error) {
    return { capable: false, reason: errorText(error) };
  }
}
