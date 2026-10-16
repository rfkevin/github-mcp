/**
 * CC-4 A3 — exécution par l'API gratuite : sonde owner et dispatch d'une
 * invocation A1.
 *
 * Garde-fous, dans l'ordre :
 * 1. arrêt d'urgence (A2) ;
 * 2. endpoint inscrit par le propriétaire, actif (sonde réussie), lié au
 *    principal de l'invocation, attestation `provider_adapter` ;
 * 3. capacités deny-by-default : `llm.generate`, fournisseur `workers-ai`,
 *    plafond de jetons explicite ;
 * 4. paquet d'entrée identique à l'empreinte enregistrée par A1 ;
 * 5. validations locales de l'appel (limites, taille) — avant tout quota ;
 * 6. plafond quotidien d'appels par endpoint ;
 * 7. réserve du PIRE CAS en neurons sur le registre journalier du compte,
 *    refusée avant l'appel si elle dépasserait le budget (sous les 10 000
 *    neurons gratuits par jour) : aucune facturation possible, même sur un
 *    compte Workers Paid (revue #117 R1) ;
 * 8. bail A1 + réserve budgétaire 0 € (chemin gratuit), solde à la clôture.
 * Le texte produit n'est pas persisté : seule son empreinte l'est (A1 §3.3).
 */
import { StateContractError } from '../../collab/contracts';
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { sha256Hex } from '../store/hash';
import { assertAutomationRunning } from '../owner/automation';
import { ownerAppend, REGISTRY_CYCLE, type OwnerWriteResult } from '../owner/decisions';
import type { OwnerProof } from '../owner/proof';
import { InvocationService, type InvocationRecord } from '../invocations';
import { createWorkersAiAdapter, WORKERS_AI_PROVIDER, type LlmAdapter, type WorkersAiBinding } from './adapter';
import {
  createOpenAiCompatibleAdapter, groqFreeAttestedFromEnv, openAiCompatibleProviderOf,
  type OpenAiCompatibleEnv, type OpenAiCompatibleOptions,
} from './openai-compatible';
import {
  createGeminiAdapter, geminiFreeAttestedFromEnv, geminiProviderOf, type GeminiEnv,
} from './gemini';
import { loadEndpoint, PROBE_KEY_PREFIX, type StoredEndpoint } from './registry';

export const DEFAULT_DAILY_CAP = 50;
/** Budget journalier de neurons du chemin gratuit (allocation Cloudflare : 10 000/jour, remise à 00:00 UTC). */
export const DEFAULT_NEURON_BUDGET = 8_000;
export const MAX_NEURON_BUDGET = 9_500;
export const LLM_TOOL = 'llm.generate';
/** Assez large pour une réponse d'une ligne même si le modèle raisonne un peu ; borné par token_ceiling. */
const PROBE_MAX_TOKENS = 256;
const PROBE_CONTROL = 'Tu es une sonde technique. Réponds exactement par une seule ligne : CC4-PROBE-OK suivi du nonce présent dans les données. Rien d’autre.';

export type AdapterFactory = (endpoint: StoredEndpoint) => LlmAdapter;

export interface ProviderAdapterEnv extends OpenAiCompatibleEnv, GeminiEnv {
  AI?: WorkersAiBinding;
}

/** Fabrique historique conservée pour les tests/consommateurs Workers AI directs. */
export function workersAiFactory(ai: WorkersAiBinding | undefined): AdapterFactory {
  return endpoint => {
    if (!ai) throw new CollabStoreError('EXECUTOR_UNAVAILABLE', 'Binding Workers AI absent de cet environnement.');
    return createWorkersAiAdapter(ai, endpoint.attestation_ref);
  };
}

/**
 * Fabrique universelle A3c. Le préfixe de l'attestation choisit uniquement une
 * entrée codée côté serveur ; aucune URL ni clé n'est issue du registre.
 *
 * Gemini / Groq Free : freeProjectAttested dérivé **uniquement** des vars
 * serveur Owner (GEMINI_/GROQ_FREE_PROJECT_ATTESTED=true + PUBLIC_ORIGIN
 * CC3-test). Jamais true en dur, jamais client / registre / présence de clé.
 */
export function providerAdapterFactory(env: ProviderAdapterEnv, options: OpenAiCompatibleOptions = {}): AdapterFactory {
  return endpoint => {
    if (endpoint.attestation_ref.startsWith(WORKERS_AI_PROVIDER + ':')) {
      if (!env.AI) throw new CollabStoreError('EXECUTOR_UNAVAILABLE', 'Binding Workers AI absent de cet environnement.');
      return createWorkersAiAdapter(env.AI, endpoint.attestation_ref);
    }
    if (geminiProviderOf(endpoint.attestation_ref)) {
      return createGeminiAdapter(env, endpoint.attestation_ref, {
        ...options,
        freeProjectAttested: geminiFreeAttestedFromEnv(env),
      });
    }
    if (openAiCompatibleProviderOf(endpoint.attestation_ref)) {
      return createOpenAiCompatibleAdapter(env, endpoint.attestation_ref, {
        ...options,
        freeProjectAttested: groqFreeAttestedFromEnv(env),
      });
    }
    throw new StateContractError('EXECUTOR_UNSUPPORTED', 'Fournisseur de l’endpoint non pris en charge.', 'executor');
  };
}

export function parseDailyCap(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : DEFAULT_DAILY_CAP;
}

export function parseNeuronBudget(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_NEURON_BUDGET ? parsed : DEFAULT_NEURON_BUDGET;
}

function neuronKey(now: Date): string {
  return 'neurons:workers-ai:' + now.toISOString().slice(0, 10);
}
