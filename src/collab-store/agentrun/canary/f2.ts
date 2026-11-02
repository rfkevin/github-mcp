/**
 * CC-8 S5 — branchement F2. Le rapport canary alimente decidePromotion
 * (promote/decision.ts, décision pure CC-7) SANS la modifier : les
 * contre-exemples CC-7 restent exacts — 1 appel, type manquant, alias
 * latest, tarifs NaN, efforts invalides, fuite, erreur critique →
 * reject/propose, jamais auto.
 *
 * Sortie = tâche de promotion : un verdict propose/auto_apply produit une
 * PromotionTaskProposal consommée par S6 (bêta) ; un reject ne produit rien.
 * AGENT_RUN_PROMOTE_AUTO reste éteint en production : auto_apply n'y survient
 * jamais ; la politique future reste une décision de Kevin (/owner).
 */
import { sha256Hex } from '../../store/hash';
import {
  decidePromotion,
  type CanaryResult,
  type ProbeResult,
  type PromoteDecision,
  type PromoteRate,
} from '../promote';
import type { CanaryReport } from './runner';

export interface PromotionTaskProposal {
  readonly cycle_id: string;
  readonly current_ref: string;
  readonly candidate_ref: string;
  readonly verdict: 'propose' | 'auto_apply';
  readonly reasons: readonly string[];
  /** Empreinte canonique du rapport canary (traçabilité, rejouable). */
  readonly report_hash: string;
  readonly canary_calls: number;
  /** La tâche de promotion ouvre la bêta (S6), jamais un basculement direct. */
  readonly next: 'beta';
}

export interface BranchF2Input {
  readonly cycle_id: string;
  readonly current_ref: string;
  readonly candidate_ref: string;
  readonly same_family: boolean;
  readonly current_rate: PromoteRate | null;
  readonly candidate_rate: PromoteRate | null;
  readonly candidate_still_free: boolean;
  readonly current_is_free: boolean;
  readonly probe: ProbeResult;
  readonly report: CanaryReport;
  /** Politique owner (AGENT_RUN_PROMOTE_AUTO) : éteinte en production. */
  readonly auto_policy_enabled: boolean;
  readonly paid_ceiling_ok: boolean;
}

export interface PromotionOutcome {
  readonly decision: PromoteDecision;
  readonly proposal: PromotionTaskProposal | null;
}

/** Vue CanaryResult (contrat CC-7) d'un rapport S5 — champs portés tels quels. */
export function canaryResultOf(report: CanaryReport): CanaryResult {
  return {
    calls: report.calls,
    failures: report.failures,
    cost_ratio: report.cost_ratio,
    identity_leak: report.identity_leak,
    critical_error: report.critical_error,
    calls_by_kind: report.calls_by_kind,
  };
}

/** Empreinte canonique du rapport (clés triées une fois, rejouable). */
export function reportHashOf(report: CanaryReport): string {
  const canonical = JSON.stringify(report, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
      return Object.fromEntries(entries);
    }
    return value;
  });
  return sha256Hex(canonical);
}

/** Branchement : rapport canary + sonde → décision F2 → tâche de promotion ou rien. */
export function branchCanaryToF2(input: BranchF2Input): PromotionOutcome {
  const decision = decidePromotion({
    current_ref: input.current_ref,
    candidate_ref: input.candidate_ref,
    same_family: input.same_family,
    current_rate: input.current_rate,
    candidate_rate: input.candidate_rate,
    candidate_still_free: input.candidate_still_free,
    current_is_free: input.current_is_free,
    probe: input.probe,
    canary: canaryResultOf(input.report),
    auto_policy_enabled: input.auto_policy_enabled,
    paid_ceiling_ok: input.paid_ceiling_ok,
  });
  if (decision.verdict === 'reject') return { decision, proposal: null };
  return {
    decision,
    proposal: {
      cycle_id: input.cycle_id,
      current_ref: input.current_ref,
      candidate_ref: input.candidate_ref,
      verdict: decision.verdict,
      reasons: decision.reasons,
      report_hash: reportHashOf(input.report),
      canary_calls: input.report.calls,
      next: 'beta',
    },
  };
}
