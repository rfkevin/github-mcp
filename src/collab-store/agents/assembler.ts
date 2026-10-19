/**
 * CC-5 L3b — assembleur de contexte D3 pour agents API.
 *
 * Construit un paquet borné (budget tokens) à partir du packet de rôle existant
 * (context/packet.ts) + persona + outils allowlistés. Aucun secret, aucun
 * chemin d'écriture D12. Fail-closed si le budget minimal dépasse le plafond.
 */
import { buildRolePacket, type RolePacket, type PacketOptions } from '../context/packet';
import type { ResolveContextInput } from '../context/resolution';
import { assertApiPersona, type AgentPersona } from './persona';
import { API_AGENT_TOOLS } from './tools';

/** Budget tokens par défaut pour un agent API (modèles free, context serré). */
export const API_AGENT_PACKET_BUDGET = 3_000;

export interface AgentContextPacket {
  persona: Pick<AgentPersona, 'participant_id' | 'display' | 'system_duty' | 'preferred_free_model'>;
  channel: 'api';
  /** Outils autorisés — copie serveur, pas client. */
  tools: readonly string[];
  /** Interdiction explicite des verdicts D12 sur ce canal. */
  constraints: {
    d12_verdicts: 'forbidden';
    max_cost_cents: 0;
    free_models_only: true;
  };
  role_packet: RolePacket;
}

export interface AssembleInput {
  participantId: string;
  cycleId: string;
  taskId?: string;
  lastSeenSeq?: number;
  /** Budget tokens (plafonné à API_AGENT_PACKET_BUDGET). */
  budgetTokens?: number;
  c0BaselineTokens?: number;
}

/**
 * Assemble le contexte d'un passage agent API.
 * persona + outils + role packet borné. Aucune écriture store.
 */
export async function assembleAgentContext(
  db: D1Database,
  input: AssembleInput,
): Promise<AgentContextPacket> {
  const persona = assertApiPersona(input.participantId);
  const budget = Math.min(
    API_AGENT_PACKET_BUDGET,
    Math.max(500, input.budgetTokens ?? API_AGENT_PACKET_BUDGET),
  );
  const resolve: ResolveContextInput = {
    participant_id: input.participantId,
    cycle: input.cycleId,
    ...(input.taskId ? { task: input.taskId } : {}),
  };
  const options: PacketOptions = {
    c0BaselineTokens: input.c0BaselineTokens ?? 12_000,
    approvedBudgetTokens: budget,
    lastSeenSeq: input.lastSeenSeq ?? 0,
  };
  const rolePacket = await buildRolePacket(db, resolve, options);
  return {
    persona: {
      participant_id: persona.participant_id,
      display: persona.display,
      system_duty: persona.system_duty,
      preferred_free_model: persona.preferred_free_model,
    },
    channel: 'api',
    tools: [...API_AGENT_TOOLS],
    constraints: {
      d12_verdicts: 'forbidden',
      max_cost_cents: 0,
      free_models_only: true,
    },
    role_packet: rolePacket,
  };
}

/** Sérialisation stable pour empreinte / prompt (sans horloge). */
export function serializeAgentPacket(packet: AgentContextPacket): string {
  return JSON.stringify(packet);
}
