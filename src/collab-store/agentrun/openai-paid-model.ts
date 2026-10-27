/**
 * CC-7 L2 (PR 2.2, plan CC-PLAN-7 v0.2 S2) — socle des adaptateurs payants
 * compatibles OpenAI du canal API (Z.ai en 2.1, xAI en 2.2) : un ModelClient
 * avec appel d'outils (tool_calls), derrière l'enveloppe de coût PAR
 * PARTICIPANT (paid-model.ts) et le registre des tarifs daté
 * (executors/model-rates.ts, deny-by-default).
 *
 * CC-7 L2 (PR 2.3) : les gardes de coût et d'idempotence sont extraites dans
 * le noyau commun paid-protocol.ts, paramétré par protocole ; ce fichier ne
 * porte plus que le protocole OpenAI (en-tête Bearer, corps chat/completions,
 * lecture choices[].message) et l'assemblage de l'hôte. Anthropic (protocole
 * Messages distinct, anthropic-model.ts) réutilise le même noyau : aucune
 * garde dupliquée.
 */
import type { ModelClient } from './engine';
import { prepareProviderCall } from './paid-model';
import { readModelResponse } from './workers-ai-model';
import { createPaidProtocolModel, type PaidModelCore, type PaidProtocol } from './paid-protocol';

// Compat PR 2.1/2.2 : les enveloppes fines Z.ai et xAI importent le cœur
// commun et la lecture du registre depuis ce module.
export { parsePaidProviderRef } from './paid-protocol';
export type { PaidModelCore } from './paid-protocol';

/** Le fournisseur apporte son secret, son endpoint constant et ses options de corps. */
export interface OpenAiPaidModelOptions extends PaidModelCore {
  /** Secret serveur du fournisseur (posé par Kevin seul sur le Worker). */
  secret: string | undefined;
  /** Endpoint constant serveur du fournisseur (jamais une URL du modèle). */
  url: string;
  /** Fournisseur : préfixe d'erreur (<fournisseur>_error) et délai par défaut (providerTimeoutMs). */
  provider: string;
  /** Options de corps propres au fournisseur (ex. thinking désactivé pour Z.ai). */
  requestOptions?: Readonly<Record<string, unknown>>;
  /** CC-7 L8 : modèle gratuit vérifié (provider-models.ts) — coût 0, aucune enveloppe. */
  free?: boolean;
}

/** Protocole OpenAI : en-tête Bearer, messages système au début, outils en wrapper function. */
const OPENAI_PROTOCOL: PaidProtocol = {
  headers(secret: string) {
    return { Authorization: 'Bearer ' + secret };
  },
  prepare(input) {
    const prepared = prepareProviderCall(input.schemas, input.system, {
      messages: input.messages, tools: input.tools, task_kind: input.taskKind,
    });
    return {
      body: {
        model: input.model, messages: prepared.messages, max_tokens: input.maxOutputTokens,
        ...(input.requestOptions ?? {}), ...(prepared.tools.length ? { tools: prepared.tools } : {}),
      },
      bound: prepared.bound,
    };
  },
  parse: readModelResponse,
};

/** Modèle payant compatible OpenAI : même contrat ModelClient que les chemins Workers AI, coût borné par l'enveloppe par participant. */
export function createOpenAiPaidModel(options: OpenAiPaidModelOptions): ModelClient {
  return createPaidProtocolModel({ ...options, protocol: OPENAI_PROTOCOL });
}
