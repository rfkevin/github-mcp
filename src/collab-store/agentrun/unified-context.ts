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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort()
    .map(key => JSON.stringify(key) + ':' + stableStringify(record[key]))
    .join(',') + '}';
}

export function dossierFingerprint(dossier: TaskDossier): string {
  return fnv1a64(stableStringify(dossier));
}

export function buildUnifiedContext(input: UnifiedContextInput): UnifiedContext {
  const budgetTokens = input.dossier.budgetTokens
    ?? Math.min(Math.max(1, input.packet.budget.max_tokens), DOSSIER_BUDGET_DEFAULT);
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
