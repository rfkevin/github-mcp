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

/** Fabrique par défaut : Workers AI via le binding du Worker. */
export function workersAiFactory(ai: WorkersAiBinding | undefined): AdapterFactory {
  return endpoint => {
    if (!ai) throw new CollabStoreError('EXECUTOR_UNAVAILABLE', 'Binding Workers AI absent de cet environnement.');
    return createWorkersAiAdapter(ai, endpoint.attestation_ref);
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

/**
 * Réserve le pire cas en neurons sur le registre journalier (UTC) ; au-delà du
 * budget : EXECUTOR_NEURON_BUDGET, rien d'écrit, aucun appel.
 */
export async function reserveNeurons(db: D1Database, neurons: number, budget: number, now: Date): Promise<string> {
  const key = neuronKey(now);
  try {
    await db.batch([
      db.prepare('INSERT INTO quota_counters (day, writes) VALUES (?1, 0) ON CONFLICT(day) DO NOTHING').bind(key),
      db.prepare('INSERT INTO collab_store_guard (ok) SELECT CASE WHEN (SELECT writes FROM quota_counters WHERE day = ?1) + ?2 <= ?3 THEN 1 ELSE 0 END')
        .bind(key, neurons, budget),
      db.prepare('UPDATE quota_counters SET writes = writes + ?2 WHERE day = ?1').bind(key, neurons),
      db.prepare('DELETE FROM collab_store_guard'),
    ]);
  } catch {
    const row = await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(key).first<{ writes: number }>();
    throw new CollabStoreError('EXECUTOR_NEURON_BUDGET', 'Budget gratuit du jour insuffisant : ' + (row?.writes ?? 0) + ' + ' + neurons
      + ' neurons > ' + budget + '. Aucun appel n’est fait ; réessayez après 00:00 UTC.');
  }
  return key;
}

/** Ramène une réserve au réel mesuré (jamais au-dessus de la réserve). */
export async function settleNeurons(db: D1Database, key: string, reserved: number, actual: number): Promise<void> {
  const refund = reserved - Math.min(Math.max(actual, 0), reserved);
  if (refund > 0) await db.prepare('UPDATE quota_counters SET writes = MAX(writes - ?2, 0) WHERE day = ?1').bind(key, refund).run();
}

/** Consomme une unité du plafond quotidien de l'endpoint (garde dans le lot) ; au-delà : EXECUTOR_DAILY_CAP, rien d'écrit. */
export async function consumeDailyCap(db: D1Database, endpointId: string, cap: number, now: Date): Promise<number> {
  const key = 'exec:' + endpointId + ':' + now.toISOString().slice(0, 10);
  try {
    await db.batch([
      db.prepare('INSERT INTO quota_counters (day, writes) VALUES (?1, 0) ON CONFLICT(day) DO NOTHING').bind(key),
      db.prepare('INSERT INTO collab_store_guard (ok) SELECT CASE WHEN (SELECT writes FROM quota_counters WHERE day = ?1) < ?2 THEN 1 ELSE 0 END')
        .bind(key, cap),
      db.prepare('UPDATE quota_counters SET writes = writes + 1 WHERE day = ?1').bind(key),
      db.prepare('DELETE FROM collab_store_guard'),
    ]);
  } catch {
    throw new CollabStoreError('EXECUTOR_DAILY_CAP', 'Plafond quotidien de ' + cap + ' appels atteint pour ' + endpointId + ' : réessayez demain.');
  }
  const row = await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(key).first<{ writes: number }>();
  return row?.writes ?? cap;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'EXECUTOR_ERROR';
}

/**
 * Sonde owner (bouton /owner) : un appel réel, paquet fixe défini par le
 * serveur, résultat (provenance, latence, usage, empreinte) enregistré comme
 * owner.decision. C'est la seule preuve qui permet ensuite d'activer l'endpoint.
 */
export async function probeEndpoint(db: D1Database, factory: AdapterFactory, input: {
  endpoint_id: string;
  proof: OwnerProof;
  op: string;
  daily_cap?: number;
  neuron_budget?: number;
  now?: () => Date;
}): Promise<OwnerWriteResult & { ok: boolean; error?: string; error_detail?: string }> {
  await ensureSchema(db);
  const key = PROBE_KEY_PREFIX + input.endpoint_id + ':' + input.op;
  const replay = await db.prepare('SELECT * FROM events WHERE idempotency_key = ?1').bind(key).first<OwnerWriteResult['event']>();
  if (replay) {
    const payload = JSON.parse(replay.payload_json) as { ok?: boolean; error?: string; error_detail?: string };
    return { status: 'duplicate', event: replay, ok: payload.ok === true,
      ...(payload.error ? { error: payload.error } : {}), ...(payload.error_detail ? { error_detail: payload.error_detail } : {}) };
  }
  await assertAutomationRunning(db);
  const endpoint = await loadEndpoint(db, input.endpoint_id);
  if (!endpoint || endpoint.status === 'retired' || endpoint.attestation_kind !== 'provider_adapter') {
    throw new CollabStoreError('ENDPOINT_NOT_PROBEABLE', 'Endpoint ' + input.endpoint_id + ' introuvable, retiré ou non provider_adapter.');
  }
  const adapter = factory(endpoint);
  const now = input.now?.() ?? new Date();
  const nonce = crypto.randomUUID().slice(0, 8);
  const ceiling = endpoint.capability_set.token_ceiling;
  const call = { control: PROBE_CONTROL, data: 'nonce: ' + nonce, max_tokens: Math.min(PROBE_MAX_TOKENS, ceiling ?? PROBE_MAX_TOKENS) };
  const worst = adapter.worstCaseNeurons(call);
  await consumeDailyCap(db, endpoint.endpoint_id, input.daily_cap ?? DEFAULT_DAILY_CAP, now);
  const neuronLedger = await reserveNeurons(db, worst, input.neuron_budget ?? DEFAULT_NEURON_BUDGET, now);
  const started = Date.now();
  let ok = false;
  let error: string | undefined;
  let errorDetail: string | undefined;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let outputSha = '';
  try {
    const result = await adapter.generate(call);
    usage = result.usage;
    await settleNeurons(db, neuronLedger, worst, adapter.neuronsFor(result.usage));
    outputSha = await sha256Hex(result.text);
    ok = result.text.includes('CC4-PROBE-OK') && result.text.includes(nonce);
    if (!ok) error = 'PROBE_OUTPUT_MISMATCH';
  } catch (caught) {
    error = errorCode(caught);
    // Seuls nos propres messages (codes typés) sont conservés : jamais un texte libre du fournisseur.
    if (caught instanceof StateContractError || caught instanceof CollabStoreError) errorDetail = caught.message.slice(0, 300);
  }
  const written = await ownerAppend(db, {
    cycleId: REGISTRY_CYCLE,
    key,
    payload: {
      action: 'endpoint_probe', endpoint_id: endpoint.endpoint_id, principal_id: endpoint.principal_id,
      attestation_ref: endpoint.attestation_ref, provider: adapter.provider, model: adapter.model,
      ok, latency_ms: Date.now() - started, usage, output_sha256: outputSha, ...(error ? { error } : {}),
      ...(errorDetail ? { error_detail: errorDetail } : {}),
    },
    proof: input.proof,
    sideEffects: () => [],
    now: input.now,
  });
  return { ...written, ok, ...(error ? { error } : {}), ...(errorDetail ? { error_detail: errorDetail } : {}) };
}

export interface DispatchOutcome {
  status: 'succeeded' | 'attempt_failed' | 'busy' | 'terminal';
  invocation: InvocationRecord;
  /** Texte produit (jamais persisté ; seule son empreinte l'est). */
  output?: string;
  error?: string;
}

function capabilityDenied(message: string): CollabStoreError {
  return new CollabStoreError('EXECUTOR_CAPABILITY_DENIED', message);
}

/** Capacités deny-by-default de l'endpoint pour un appel LLM gratuit. */
export function assertLlmCapabilities(endpoint: StoredEndpoint, maxTokens: number): void {
  const caps = endpoint.capability_set;
  if (!caps.tools?.includes(LLM_TOOL)) throw capabilityDenied('Capacité ' + LLM_TOOL + ' absente pour ' + endpoint.endpoint_id + '.');
  if (!caps.network_providers?.includes(WORKERS_AI_PROVIDER)) {
    throw capabilityDenied('Fournisseur ' + WORKERS_AI_PROVIDER + ' non autorisé pour ' + endpoint.endpoint_id + '.');
  }
  if (caps.token_ceiling === undefined || maxTokens > caps.token_ceiling) {
    throw capabilityDenied('max_tokens ' + maxTokens + ' au-delà du plafond ' + (caps.token_ceiling ?? 'absent') + '.');
  }
}

/**
 * Exécute une invocation A1 sur son endpoint par l'API gratuite. Les
 * instructions de contrôle (`control`) viennent du code serveur, jamais d'un
 * agent ; `input_packet` doit être exactement celui enregistré (empreinte).
 */
export async function dispatchFreeInvocation(db: D1Database, factory: AdapterFactory, input: {
  wake_key: string;
  worker_id: string;
  control: string;
  input_packet: string;
  max_tokens: number;
  lease_seconds?: number;
  daily_cap?: number;
  neuron_budget?: number;
  budget_scope?: string;
  now?: () => Date;
}): Promise<DispatchOutcome> {
  await ensureSchema(db);
  const service = new InvocationService(db, { now: input.now });
  const invocation = await service.getByWakeKey(input.wake_key);
  if (!invocation) throw new CollabStoreError('INVOCATION_UNKNOWN', 'wake_key inconnu.');
  if (invocation.state === 'succeeded' || invocation.state === 'failed') return { status: 'terminal', invocation };
  if (invocation.state === 'leased' || invocation.state === 'running') return { status: 'busy', invocation };
  await assertAutomationRunning(db);
  const endpoint = await loadEndpoint(db, invocation.endpoint_id);
  if (!endpoint || endpoint.status !== 'active' || endpoint.attestation_kind !== 'provider_adapter') {
    throw new CollabStoreError('ENDPOINT_NOT_ACTIVE', 'Endpoint ' + invocation.endpoint_id + ' absent, non actif ou non provider_adapter.');
  }
  if (endpoint.principal_id !== invocation.principal_id) {
    throw new CollabStoreError('ENDPOINT_PRINCIPAL_MISMATCH',
      'L’endpoint ' + endpoint.endpoint_id + ' appartient à ' + endpoint.principal_id + ', pas à ' + invocation.principal_id + '.');
  }
  assertLlmCapabilities(endpoint, input.max_tokens);
  if (await sha256Hex(input.input_packet) !== invocation.input_hash) {
    throw new CollabStoreError('INVOCATION_INPUT_MISMATCH', 'Le paquet fourni ne correspond pas à l’empreinte enregistrée de l’invocation.');
  }
  const adapter = factory(endpoint);
  const call = { control: input.control, data: input.input_packet, max_tokens: input.max_tokens };
  // Revue #117 R3 : validations locales AVANT quota et bail — une erreur de configuration
  // ne consomme ni le plafond, ni une tentative A1, et n'appelle pas le fournisseur.
  adapter.validate(call);
  const worst = adapter.worstCaseNeurons(call);
  const now = input.now?.() ?? new Date();
  await consumeDailyCap(db, endpoint.endpoint_id, input.daily_cap ?? DEFAULT_DAILY_CAP, now);
  const neuronLedger = await reserveNeurons(db, worst, input.neuron_budget ?? DEFAULT_NEURON_BUDGET, now);
  let lease;
  try {
    lease = await service.lease(input.wake_key, input.worker_id, input.lease_seconds ?? 120,
      { max_cost_cents: 0, scope: input.budget_scope });
  } catch (error) {
    await settleNeurons(db, neuronLedger, worst, 0);
    throw error;
  }
  if (lease.status !== 'leased') {
    await settleNeurons(db, neuronLedger, worst, 0);
    return { status: lease.status, invocation: lease.invocation };
  }
  await service.markRunning(input.wake_key, input.worker_id);
  const evidence = ['provider:' + adapter.provider, 'model:' + adapter.model];
  let result;
  try {
    result = await adapter.generate(call);
  } catch (caught) {
    // Pire cas conservé : un appel interrompu (délai) a pu consommer chez le fournisseur.
    // Seul l'échec du fournisseur devient une tentative échouée ; une erreur du store remonte telle quelle.
    const code = errorCode(caught);
    const failed = await service.fail(input.wake_key, input.worker_id, code, { operations: 1 }, evidence, 0);
    return { status: 'attempt_failed', invocation: failed, error: code };
  }
  await settleNeurons(db, neuronLedger, worst, adapter.neuronsFor(result.usage));
  const done = await service.succeed(input.wake_key, input.worker_id, result.text,
    { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, operations: 1 }, evidence, 0);
  return { status: 'succeeded', invocation: done, output: result.text };
}
