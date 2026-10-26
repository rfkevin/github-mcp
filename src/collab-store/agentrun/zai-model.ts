/**
 * CC-7 L2 (PR 2.1, plan CC-PLAN-7 v0.2 S2) — adaptateur Z.ai du canal API :
 * enveloppe fine autour du socle commun openai-paid-model.ts (PR 2.2) : secret
 * LLM_KEY_ZAI, endpoint constant ZAI_CHAT_COMPLETIONS_URL, thinking désactivé
 * pour la famille glm-5.3 (précédent glm-4.7-flash : le raisonnement consomme
 * max_tokens avant la réponse ; option à revalider à l'activation, aucun appel
 * avant le GO de Kevin + secret). Toutes les gardes (enveloppe PAR PARTICIPANT,
 * registre daté deny-by-default, réservation/règlement au pire cas, rejeu
 * fail-closed) vivent dans le socle.
 */
import type { ApiModelRate } from '../executors/model-rates';
import { ZAI_CHAT_COMPLETIONS_URL } from '../executors/openai-compatible';
import type { ModelClient } from './engine';
import { createOpenAiPaidModel, parsePaidProviderRef, type PaidModelCore } from './openai-paid-model';

export interface ZaiModelOptions extends PaidModelCore {
  /** Environnement serveur : secret LLM_KEY_ZAI (posé par Kevin seul sur le Worker). */
  env: { LLM_KEY_ZAI?: string };
}

/** Le canal API demande des réponses directes : le raisonnement est coupé (précédent glm-4.7-flash). */
const ZAI_REQUEST_OPTIONS = { thinking: { type: 'disabled' } } as const;

/** Référence Z.ai du registre daté : deny-by-default, aucun repli inter-familles. */
export function parseZaiRef(ref: string): { model: string; rate: ApiModelRate } {
  return parsePaidProviderRef(ref, 'zai');
}

/** Modèle Z.ai : même contrat ModelClient que les chemins Workers AI, coût borné par l'enveloppe par participant. */
export function createZaiModel(options: ZaiModelOptions): ModelClient {
  return createOpenAiPaidModel({ ...options, secret: options.env.LLM_KEY_ZAI,
    url: ZAI_CHAT_COMPLETIONS_URL, provider: 'zai', requestOptions: ZAI_REQUEST_OPTIONS });
}
