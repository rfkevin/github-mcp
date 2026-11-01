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
 * - Sans politique (référence unique participantModelRoute et son palier auto / free / paid) : la
 *   résolution PURE partagée avec la fabrique (resolveProviderRoute : fournisseur, liste gratuite ou
 *   payante, palier forcé, attestation, tarif daté), puis clé ou binding présent, puis, pour un canal
 *   payant, l'enveloppe de l'agent financée et le coût estimé d'une étape dans le budget restant.
 * - Ni politique ni référence : refus typé NO_MODEL.
 */
import { apiModelRate, centsOfApiTokens } from '../executors/model-rates';
import { resolveEffectiveMaxTokens } from '../executors/task-profiles';
import { budgetState, chooseModel, credentialPresent, ESTIMATE_INPUT_TOKENS, participantEnvelope, resolveParticipantPolicy,
  type PolicyEnv } from './model-policy';
import { centsOfNeurons, envelopeFunded, PAID_MODEL_RATES } from './paid-model';
import { participantModelRoute, resolveProviderRoute, type ProviderRoute } from './provider-models';

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
  let resolved: ProviderRoute;
  try {
    resolved = resolveProviderRoute(route.ref, route.tier, policyEnv, policyEnv.AI !== undefined && policyEnv.AI !== null);
  } catch (error) {
    return { capable: false, reason: 'MODEL_ROUTE_REFUSED : ' + route.ref + ' (palier ' + route.tier + ') — ' + errorText(error) };
  }
  if (!credentialPresent(policyEnv, route.ref)) {
    return { capable: false, reason: 'MODEL_ROUTE_REFUSED : ' + route.ref + ' — clé ou binding absent' };
  }
  if (resolved.free) return { capable: true, reason: route.ref };
  // Canal payant : enveloppe de l'agent financée (refus de la fabrique sinon) et une étape dans le budget restant.
  const envelope = participantEnvelope(policyEnv, participantId);
  const budget = await budgetState(db, envelope, participantId, cycleId, now);
  const cost = paidStepCents(resolved, route.ref, kind);
  if (!envelopeFunded(envelope) || cost > budget.day_limit - budget.day_spent || cost > budget.cycle_limit - budget.cycle_spent) {
    return { capable: false, reason: 'MODEL_BUDGET_EXHAUSTED : ' + route.ref + ' (palier ' + route.tier + ', ' + cost + 'c par étape) ; budget restant jour '
      + (budget.day_limit - budget.day_spent) + 'c, cycle ' + (budget.cycle_limit - budget.cycle_spent) + 'c' };
  }
  return { capable: true, reason: route.ref };
}

/** Coût estimé prudent d'une étape payante (même entrée estimée que la politique, sortie plafonnée du type de tâche). */
function paidStepCents(resolved: ProviderRoute, ref: string, kind: string): number {
  const output = resolveEffectiveMaxTokens({ task_kind: kind });
  if (resolved.provider === 'workers-ai') {
    const rates = PAID_MODEL_RATES[resolved.model];
    return centsOfNeurons(Math.ceil((ESTIMATE_INPUT_TOKENS * rates.input_per_m + output * rates.output_per_m) / 1_000_000));
  }
  const rate = apiModelRate(ref);
  return rate ? centsOfApiTokens(rate, ESTIMATE_INPUT_TOKENS, output) : Number.POSITIVE_INFINITY;
}
