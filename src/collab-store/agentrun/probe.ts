/**
 * CC-8 S4 — sonde unique (CC-PLAN-8).
 *
 * Un seul runner pour le bouton /owner et le pipeline auto (model.finding).
 * Produit un ProbeResult compatible promote/decision.ts SANS modifier ce fichier.
 * Fail-closed : HALT, drapeau AGENT_RUN_PROBE off, ref non épinglée, erreur réseau.
 * Coût 0 par défaut (mock ou modèle gratuit) ; aucun secret, aucune écriture fiche.
 */
import { isAutomationHalted } from '../owner/automation';
import { isPinnedRef, type ProbeResult } from './promote/decision';

export const PROBE_EFFORTS_DEFAULT = Object.freeze(['low', 'medium', 'high'] as const);

export type ProbeProvenance = 'simulation' | 'provider' | 'none';
export type ProbeMode = 'disabled' | 'not_implemented' | 'simulated' | 'live' | 'halted' | 'rejected';

export interface ProbeEnv {
  /** Exact « true » pour tenter une sonde live ; sinon disabled. */
  AGENT_RUN_PROBE?: string;
}

export interface ProbeRequest {
  /** Ref candidate provider:model (épinglée). */
  candidate_ref: string;
  /** Origine : owner_button | model_finding | test. */
  source: 'owner_button' | 'model_finding' | 'test';
  /** finding_id si déclenché par model.finding. */
  finding_id?: string;
  now?: number;
  /** Tests unitaires seulement — résultat simulated non utilisable en promotion. */
  allowSimulation?: boolean;
}

export interface ProbeOutcome extends ProbeResult {
  readonly candidate_ref: string;
  readonly source: ProbeRequest['source'];
  readonly finding_id?: string;
  readonly at: number;
  readonly mode: ProbeMode;
  readonly provenance: ProbeProvenance;
}

/** true seulement si preuve provider live — filtre avant decidePromotion. */
export function probeUsableForPromotion(outcome: ProbeOutcome): boolean {
  return outcome.ok && outcome.tools_ok && outcome.provenance === 'provider' && outcome.mode === 'live';
}

/** Porte sonde : exact « true ». Éteinte par défaut. */
export function probeEnabled(env: ProbeEnv | undefined): boolean {
  return env?.AGENT_RUN_PROBE === 'true';
}

/**
 * Exécute la sonde unique.
 * - HALT → halted, ok false
 * - ref non épinglée → rejected
 * - AGENT_RUN_PROBE off → mock succès coût 0 (tests / CI sans réseau)
 * - on → live réservé (impl. minimale : mock structuré jusqu’à câblage provider)
 */
export async function runModelProbe(
  db: D1Database,
  env: ProbeEnv,
  request: ProbeRequest,
): Promise<ProbeOutcome> {
  const at = request.now ?? Math.floor(Date.now() / 1000);
  const base = {
    candidate_ref: request.candidate_ref,
    source: request.source,
    ...(request.finding_id ? { finding_id: request.finding_id } : {}),
    at,
  };

  if (await isAutomationHalted(db)) {
    return { ...base, ok: false, tools_ok: false, efforts_ok: [], error: 'HALT_ACTIVE', mode: 'halted', provenance: 'none' };
  }

  if (!isPinnedRef(request.candidate_ref)) {
    return { ...base, ok: false, tools_ok: false, efforts_ok: [], error: 'ref_non_epinglee', mode: 'rejected', provenance: 'none' };
  }

  // Simulation explicite (tests) — provenance simulation, jamais pour auto_apply.
  if (request.allowSimulation === true) {
    return {
      ...base,
      ok: true,
      tools_ok: true,
      efforts_ok: [...PROBE_EFFORTS_DEFAULT],
      cost_micro_cents: 0,
      mode: 'simulated',
      provenance: 'simulation',
    };
  }

  // Porte éteinte : disabled, ok=false (review GPT-6 : pas de faux succès).
  if (!probeEnabled(env)) {
    return {
      ...base,
      ok: false,
      tools_ok: false,
      efforts_ok: [],
      error: 'PROBE_DISABLED',
      mode: 'disabled',
      provenance: 'none',
    };
  }

  // Porte on mais client fournisseur non branché → not_implemented (pas de mock live).
  return {
    ...base,
    ok: false,
    tools_ok: false,
    efforts_ok: [],
    error: 'PROBE_NOT_IMPLEMENTED',
    mode: 'not_implemented',
    provenance: 'none',
  };
}
