/**
 * CC-7 L2 (PR 2.2, plan CC-PLAN-7 v0.2 S2) — adaptateur xAI du canal API :
 * enveloppe fine autour du socle commun openai-paid-model.ts : secret
 * LLM_KEY_XAI, endpoint constant XAI_CHAT_COMPLETIONS_URL, timeout 60 s
 * (providerTimeoutMs('xai')). Aucune option de raisonnement dans le corps :
 * xAI gère le raisonnement côté modèle, les variantes non-reasoning sont des
 * références distinctes du registre (ex. xai:grok-4.20-0309-non-reasoning).
 * Toutes les gardes (enveloppe PAR PARTICIPANT, registre daté
 * deny-by-default, réservation/règlement au pire cas, rejeu fail-closed)
 * vivent dans le socle. Secret posé par Kevin seul sur le Worker ; aucun
 * appel avant le GO de Kevin + secret.
 */
import type { ApiModelRate } from '../executors/model-rates';
import { XAI_CHAT_COMPLETIONS_URL } from '../executors/openai-compatible';
import type { ModelClient } from './engine';
import { createOpenAiPaidModel, parsePaidProviderRef, type PaidModelCore } from './openai-paid-model';

export interface XaiModelOptions extends PaidModelCore {
  /** Environnement serveur : secret LLM_KEY_XAI (posé par Kevin seul sur le Worker). */
  env: { LLM_KEY_XAI?: string };
}

/** Référence xAI du registre daté : deny-by-default, aucun repli inter-familles. */
export function parseXaiRef(ref: string): { model: string; rate: ApiModelRate } {
  return parsePaidProviderRef(ref, 'xai');
}

/** Modèle xAI : même contrat ModelClient que les chemins Workers AI, coût borné par l'enveloppe par participant. */
export function createXaiModel(options: XaiModelOptions): ModelClient {
  return createOpenAiPaidModel({ ...options, secret: options.env.LLM_KEY_XAI,
    url: XAI_CHAT_COMPLETIONS_URL, provider: 'xai' });
}
