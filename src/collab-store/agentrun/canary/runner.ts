/**
 * CC-8 S5 — runner canary. Un seul devoir : exécuter le rejeu stratifié et
 * tracer le rapport. Aucun réseau, aucune écriture store (lecture du journal
 * seule), aucun paquet brut : les prompts viennent bornés de replay.ts.
 *
 * Rapport rejouable : pour un même journal et un même CanaryCaller, deux
 * passes produisent le même rapport (ordre stable, now fourni par l'appelant
 * pour la reproductibilité). Coût, quotas et latence réels tracés (v0.2
 * seq 1270) ; cost_ratio neutre (1.0, cost_measured=false) quand un tarif
 * manque — le prix reste jugé par la décision pure F2 (priceNotHigher).
 */
import { CANARY_TASK_KINDS, type CanaryTaskKind, type PromoteRate } from '../promote';
import { CANARY_MIN_PER_KIND, journalEventsForReplay, selectReplayTasks, type ReplayTask } from './replay';

export interface CanaryCallOutcome {
  readonly ok: boolean;
  readonly in_tokens: number;
  readonly out_tokens: number;
  readonly latency_ms: number;
  /** Quota fournisseur refusé pendant l'appel : tracé, pas fatal. */
  readonly quota_rejected?: boolean;
  /** Fuite d'identité détectée dans la sortie : fail-closed côté F2. */
  readonly identity_leak?: boolean;
  readonly error?: string;
}

/** Un appel canary = un prompt de rejeu sur la candidate. Fourni par l'appelant. */
export interface CanaryCaller {
  /** Provenance déclarée des appels : simulation (tests, préparation) ou réel. */
  readonly provenance: 'simulation' | 'real';
  call(task: ReplayTask): Promise<CanaryCallOutcome>;
}

export interface CanaryCallRecord {
  readonly seq: number;
  readonly kind: CanaryTaskKind;
  readonly source_hash: string;
  readonly ok: boolean;
  readonly in_tokens: number;
  readonly out_tokens: number;
  readonly latency_ms: number;
}

export interface CanaryReport {
  readonly cycle_id: string;
  readonly candidate_ref: string;
  /** Provenance des appels : auto_apply F2 exige real, sinon simulation. */
  readonly provenance: 'simulation' | 'real';
  readonly created_at: string;
  readonly calls: number;
  readonly failures: number;
  readonly calls_by_kind: Readonly<Partial<Record<CanaryTaskKind, number>>>;
  readonly replay: readonly CanaryCallRecord[];
  /** Coût mesuré du panier sur la candidate (micro-cents ; 0 en simulation). */
  readonly cost_micro_cents: number;
  /** Coût moyen panier candidate vs actuel (1.0 = égal ou non mesuré). */
  readonly cost_ratio: number;
  /** false si un tarif manque : cost_ratio neutre, jamais inventé. */
  readonly cost_measured: boolean;
  /** Latence moyenne par appel (ms), tracée (v0.2). */
  readonly avg_latency_ms: number;
  readonly quota_rejections: number;
  readonly identity_leak: boolean;
  readonly critical_error: boolean;
  /** Déficit d'événements rejouables par type (canary incomplet → propose seulement). */
  readonly insufficient: Readonly<Partial<Record<CanaryTaskKind, number>>>;
}

export interface RunCanaryOptions {
  readonly cycle_id: string;
  readonly candidate_ref: string;
  readonly caller: CanaryCaller;
  readonly current_rate?: PromoteRate | null;
  readonly candidate_rate?: PromoteRate | null;
  readonly per_kind?: number;
  readonly now?: () => Date;
}

/** Coût d'un panier en micro-cents (tarif en cents par million de jetons). */
function basketMicroCents(rate: PromoteRate, inTokens: number, outTokens: number): number {
  const other = rate.other_per_m ?? 0;
  return Math.max(0, Math.round(inTokens * rate.input_per_m + outTokens * (rate.output_per_m + other)));
}

export async function runCanary(db: D1Database, options: RunCanaryOptions): Promise<CanaryReport> {
  const perKind = options.per_kind ?? CANARY_MIN_PER_KIND;
  // Fail-closed (relecture GPT-6) : seule une provenance déclarée real vaut
  // réel, toute autre valeur (ou absence) est une simulation.
  const provenance = options.caller.provenance === 'real' ? 'real' : 'simulation';
  const tasks = await selectReplayTasks(await journalEventsForReplay(db, options.cycle_id), perKind);
  const byKind: Partial<Record<CanaryTaskKind, number>> = {};
  const insufficient: Partial<Record<CanaryTaskKind, number>> = {};
  for (const kind of CANARY_TASK_KINDS) byKind[kind] = 0;
  for (const kind of CANARY_TASK_KINDS) {
    const have = tasks.filter((task) => task.kind === kind).length;
    if (have < perKind) insufficient[kind] = perKind - have;
  }
  const replay: CanaryCallRecord[] = [];
  let failures = 0;
  let inTokens = 0;
  let outTokens = 0;
  let latencyTotal = 0;
  let quotaRejections = 0;
  let identityLeak = false;
  let criticalError = false;
  for (const task of tasks) {
    byKind[task.kind] = (byKind[task.kind] ?? 0) + 1;
    let outcome: CanaryCallOutcome | null = null;
    try {
      outcome = await options.caller.call(task);
    } catch {
      criticalError = true;
    }
    const ok = outcome !== null && outcome.ok;
    if (!ok) failures += 1;
    const record: CanaryCallRecord = {
      seq: task.seq,
      kind: task.kind,
      source_hash: task.source_hash,
      ok,
      in_tokens: outcome?.in_tokens ?? 0,
      out_tokens: outcome?.out_tokens ?? 0,
      latency_ms: outcome?.latency_ms ?? 0,
    };
    replay.push(record);
    inTokens += record.in_tokens;
    outTokens += record.out_tokens;
    latencyTotal += record.latency_ms;
    if (outcome?.quota_rejected === true) quotaRejections += 1;
    if (outcome?.identity_leak === true) identityLeak = true;
  }
  const candidateBasket = options.candidate_rate
    ? basketMicroCents(options.candidate_rate, inTokens, outTokens)
    : null;
  const currentBasket = options.current_rate
    ? basketMicroCents(options.current_rate, inTokens, outTokens)
    : null;
  const costMeasured = candidateBasket !== null && currentBasket !== null && currentBasket > 0;
  const calls = tasks.length;
  return {
    cycle_id: options.cycle_id,
    candidate_ref: options.candidate_ref,
    provenance,
    created_at: (options.now ?? (() => new Date()))().toISOString(),
    calls,
    failures,
    calls_by_kind: byKind,
    replay,
    cost_micro_cents: costMeasured ? (candidateBasket ?? 0) : 0,
    cost_ratio: costMeasured ? (candidateBasket ?? 0) / (currentBasket ?? 1) : 1.0,
    cost_measured: costMeasured,
    avg_latency_ms: calls > 0 ? Math.round((latencyTotal / calls) * 10) / 10 : 0,
    quota_rejections: quotaRejections,
    identity_leak: identityLeak,
    critical_error: criticalError,
    insufficient,
  };
}
