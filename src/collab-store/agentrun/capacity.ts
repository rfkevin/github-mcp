/**
 * CC-8 S1a (CC-PLAN-8, synthèse seq 1262, validée par Kevin) — capacité réelle d'un agent API.
 *
 * Constat du 2026-11-01 (cc8-systeme-unique) : le planificateur créait des exécutions pour des agents
 * qui ne pouvaient pas tourner (Claude, Grok : aucune clé ni budget dans leur famille). Elles échouaient
 * aussitôt en MODEL_BUDGET_EXHAUSTED mais occupaient les places du passage (PLAN_LIMIT), si bien que
 * Gemini, dernier de la liste, n'était jamais servi.
 *
 * `runCapacity` répond AVANT toute création : l'agent a-t-il, maintenant, un modèle abordable pour ce
 * type d'exécution ? Lecture seule, aucun appel réseau.
 * - Avec politique par agent : même calcul que le choix réel d'une étape (participantPolicy +
 *   budgetState + chooseModel, sans préférence : un modèle abordable existe-t-il dans la chaîne ?).
 * - Sans politique (référence unique participantModelRoute) : mêmes règles que la fabrique
 *   createProviderModel, évaluées par modelOption — fournisseur et registre (gratuit permis ou tarif
 *   daté), palier (AGENT_RUN_MODEL n'accepte qu'un gratuit), clé ou binding présent, attestation du
 *   gratuit — puis, pour un modèle payant, l'enveloppe de l'agent (budget restant jour et cycle).
 * - Ni politique ni référence : refus typé NO_MODEL.
 */
import { budgetState, chooseModel, modelOption, participantEnvelope, participantPolicy, type PolicyEnv } from './model-policy';
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
  const policyEnv = env as PolicyEnv;
  let policy;
  try {
    policy = participantPolicy(policyEnv, participantId);
  } catch (error) {
    return { capable: false, reason: 'MODEL_POLICY_INVALID : ' + errorText(error) };
  }
  if (policy) {
    const budget = await budgetState(db, policy.envelope, participantId, cycleId, now);
    try {
      return { capable: true, reason: chooseModel(policyEnv, policy, kind, budget, null).ref };
    } catch (error) {
      return { capable: false, reason: errorText(error) };
    }
  }
  const route = participantModelRoute(env as Parameters<typeof participantModelRoute>[0], participantId);
  if (!route) return { capable: false, reason: 'NO_MODEL : aucune politique ni modèle global' };
  const option = modelOption(policyEnv, route.ref, kind, null);
  if (option.tier === 'unavailable') {
    return { capable: false, reason: 'MODEL_ROUTE_REFUSED : ' + route.ref + ' — ' + (option.reason ?? 'indisponible') };
  }
  if (route.tier === 'free' && option.tier !== 'free') {
    return { capable: false, reason: 'MODEL_ROUTE_REFUSED : ' + route.ref + ' — AGENT_RUN_MODEL n’accepte qu’un modèle gratuit permis' };
  }
  if (option.tier === 'paid') {
    const budget = await budgetState(db, participantEnvelope(policyEnv, participantId), participantId, cycleId, now);
    const cost = option.est_step_cents ?? Number.POSITIVE_INFINITY;
    if (cost > budget.day_limit - budget.day_spent || cost > budget.cycle_limit - budget.cycle_spent) {
      return { capable: false, reason: 'MODEL_BUDGET_EXHAUSTED : ' + route.ref + ' (' + cost + 'c par étape) ; budget restant jour '
        + (budget.day_limit - budget.day_spent) + 'c, cycle ' + (budget.cycle_limit - budget.cycle_spent) + 'c' };
    }
  }
  return { capable: true, reason: route.ref };
}
