/**
 * CC-8 S7 A1 — contexte unifié chat/API (chemin logique unique).
 *
 * Le dossier est le MÊME pour les deux canaux : le canal est une étiquette de
 * transport, jamais un orchestrateur ; le task_kind porte des privilèges, pas un
 * contenu (rappels owner seq1971/1974, plan de parité V2.2). Ce module ne lit pas
 * le store et n'importe pas engine.ts ni de compaction (mandat A1) : il reçoit
 * le packet déjà bâti par context/packet.ts (typage structurel, sans cycle
 * d'import) et les entrées du dossier, puis rend le contexte unique avec une
 * empreinte de parité — mêmes entrées, même empreinte, quel que soit le canal.
 */
import { fnv1a64 } from './fiche';
import {
  assertValidBudgetTokens,
  buildTaskDossier,
  DOSSIER_BUDGET_DEFAULT,
  type TaskDossier,
  type TaskDossierInput,
} from './task-dossier';

export type UnifiedChannel = 'chat' | 'api';

/** Compatible par typage structurel avec RolePacket (context/packet.ts). */
export interface UnifiedPacketLike {
  header: {
    cycle_id: string;
    phase: string;
    revision: number;
    status: string;
    participant_id: string;
    last_seen_seq: number;
  };
  role_card: { role: string; duty: string } | null;
  open_questions: readonly string[];
  refs?: { items: readonly string[]; complete: boolean };
  excluded_memory_ids?: readonly string[];
  budget: { max_tokens: number; estimated_tokens: number };
}

export interface UnifiedContextInput {
  channel: UnifiedChannel;
  packet: UnifiedPacketLike;
  dossier: TaskDossierInput;
  /** Porteur de privilèges uniquement : JAMAIS utilisé pour le contenu du dossier. */
  task_kind?: string | null;
}

export interface UnifiedContext {
  channel: UnifiedChannel;
  packet: UnifiedPacketLike;
  dossier: TaskDossier;
  /** Empreinte du dossier : mêmes entrées → même empreinte, canal et kind exclus. */
  dossier_fingerprint: string;
}

// Correction revue PR #303 (TS2322 + candidats Sonar unifiés) : pas de cast « as »,
// pas de coalescence « ?? » sur une valeur typée non nullable, pas de comparaison
// impossible (TS2367) — typage strict sûr via la surcharge Object.entries(o: {}).
// Sortie identique pour les données du dossier (chaînes, nombres, booléens,
// tableaux, objets simples) ; bigint rend « null » au lieu de lever (aucun bigint
// dans un dossier ; l'ordre des clés réplique le tri par défaut, UTF-16).
function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value !== 'object') return 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, val]) => JSON.stringify(key) + ':' + stableStringify(val))
    .join(',') + '}';
}

export function dossierFingerprint(dossier: TaskDossier): string {
  return fnv1a64(stableStringify(dossier));
}

export function buildUnifiedContext(input: UnifiedContextInput): UnifiedContext {
  // Correction revue GPT-6 PR303 objection 2 : le budget du packet est un
  // plafond approuvé — un budgetTokens explicite ne peut JAMAIS le dépasser.
  // Verdict testeur PR303 F1 : fail-closed — Math.max(1, …) clampait les
  // valeurs invalides et laissait NaN franchir toutes les limites ; tout
  // budget qui n'est pas un entier fini strictement positif (NaN, Infinity,
  // négatif, nul, fractionnaire) est refusé typé, côté packet ET côté dossier.
  assertValidBudgetTokens(input.packet.budget.max_tokens, 'packet.budget.max_tokens');
  if (input.dossier.budgetTokens !== undefined) {
    assertValidBudgetTokens(input.dossier.budgetTokens, 'dossier.budgetTokens');
  }
  const packetCeiling = input.packet.budget.max_tokens;
  const requested = input.dossier.budgetTokens ?? Math.min(packetCeiling, DOSSIER_BUDGET_DEFAULT);
  const budgetTokens = Math.min(requested, packetCeiling);
  const dossier = buildTaskDossier({ ...input.dossier, budgetTokens });
  return {
    channel: input.channel,
    packet: input.packet,
    dossier,
    dossier_fingerprint: dossierFingerprint(dossier),
  };
}

/** Parité chat/API : violations = différences de dossier pour les MÊMES entrées.
 * Le canal ne peut différer que par l'étiquette channel — jamais par le contenu. */
export function unifiedParityViolations(a: UnifiedContext, b: UnifiedContext): string[] {
  const violations: string[] = [];
  if (a.dossier_fingerprint !== b.dossier_fingerprint) violations.push('dossier_fingerprint');
  if (stableStringify(a.dossier) !== stableStringify(b.dossier)) violations.push('dossier');
  return violations;
}
