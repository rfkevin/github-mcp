/**
 * CC8 — Contrat de continuité indépendant du fournisseur.
 *
 * Le journal D1, les mandats, les preuves et le prochain travail sont portables.
 * Les identifiants de conversation et états de pensée propriétaires ne le sont pas.
 * Ce module ne déclenche aucune API et n'active aucune capacité native.
 */

export type NativeContinuityKind = 'server_session' | 'signed_tool_history';

/** Tout fournisseur futur est accepté sans modifier une énumération centrale. */
export interface ProviderContinuationCapabilities {
  provider: string;
  model: string;
  /** Déclaré uniquement si l'adaptateur a effectivement implémenté ce protocole. */
  nativeKinds?: readonly NativeContinuityKind[];
}

/** Identifiant opaque : uniquement côté serveur, jamais livré à un autre fournisseur. */
export interface NativeContinuationReference {
  provider: string;
  model: string;
  kind: NativeContinuityKind;
  reference: string;
}

export type ContinuationDecision =
  | { mode: 'native'; reference: NativeContinuationReference }
  | { mode: 'portable'; reason: 'no_native_state' | 'provider_changed' | 'model_changed' | 'unsupported_protocol' };

/** La reprise universelle D1 reste le défaut et le repli, même pour les API natives. */
export function chooseContinuation(
  next: ProviderContinuationCapabilities,
  previous: NativeContinuationReference | null | undefined,
): ContinuationDecision {
  if (!previous?.reference) return { mode: 'portable', reason: 'no_native_state' };
  if (next.provider !== previous.provider) return { mode: 'portable', reason: 'provider_changed' };
  if (next.model !== previous.model) return { mode: 'portable', reason: 'model_changed' };
  if (!(next.nativeKinds ?? []).includes(previous.kind)) return { mode: 'portable', reason: 'unsupported_protocol' };
  return { mode: 'native', reference: previous };
}
