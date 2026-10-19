/**
 * CC-5 L3b — pilote d'un passage agent API.
 *
 * Orchestre : persona → bail → assembleur D3 → (appel free optionnel).
 * N'exécute pas de verdict D12. 0 €. Fail-closed sur HALT, bail tenu,
 * outil interdit, persona absente.
 *
 * L'appel LLM réel passe par dispatchFreeInvocation (executors) quand un
 * wake_key A1 est fourni ; sinon le pilote s'arrête après l'assemblage
 * (mode dry-run / préparation).
 */
import { assertAutomationRunning } from '../owner/automation';
import { assembleAgentContext, serializeAgentPacket, type AgentContextPacket } from './assembler';
import { acquireAgentLease, releaseAgentLease, type AgentLease } from './lease';
import { assertApiPersona, AgentDenied } from './persona';
import { assertApiToolAllowed, assertNotD12Verdict } from './tools';

export type PilotMode = 'assemble_only' | 'prepare';

export interface PilotInput {
  cycleId: string;
  participantId: string;
  taskId?: string;
  workerId: string;
  mode?: PilotMode;
  budgetTokens?: number;
  lastSeenSeq?: number;
  /** Outil demandé par le runtime (vérifié allowlist). */
  requestedTool?: string;
  /** Payload candidat (refusé s'il ressemble à un verdict D12). */
  candidatePayload?: unknown;
  now?: number;
}

export type PilotResult =
  | { status: 'assembled'; packet: AgentContextPacket; lease: AgentLease; packet_bytes: number }
  | { status: 'denied'; reason: string }
  | { status: 'halted' };

/**
 * Un passage du pilote. Toujours libère le bail en fin de chemin nominal
 * (released append-only) pour permettre un rappel ultérieur.
 */
export async function runAgentPilot(db: D1Database, input: PilotInput): Promise<PilotResult> {
  try {
    await assertAutomationRunning(db);
  } catch {
    return { status: 'halted' };
  }
  try {
    assertApiPersona(input.participantId);
    if (input.requestedTool) assertApiToolAllowed(input.requestedTool);
    if (input.candidatePayload !== undefined) assertNotD12Verdict(input.candidatePayload);
  } catch (error) {
    const reason = error instanceof AgentDenied ? error.reason : 'agent_denied';
    return { status: 'denied', reason };
  }

  let lease: AgentLease;
  try {
    lease = await acquireAgentLease(db, {
      cycleId: input.cycleId,
      participantId: input.participantId,
      taskId: input.taskId,
      workerId: input.workerId,
      now: input.now,
    });
  } catch (error) {
    const reason = error instanceof AgentDenied ? error.reason : 'lease_denied';
    return { status: 'denied', reason };
  }

  try {
    const packet = await assembleAgentContext(db, {
      participantId: input.participantId,
      cycleId: input.cycleId,
      taskId: input.taskId,
      budgetTokens: input.budgetTokens,
      lastSeenSeq: input.lastSeenSeq,
    });
    const serialized = serializeAgentPacket(packet);
    return {
      status: 'assembled',
      packet,
      lease,
      packet_bytes: new TextEncoder().encode(serialized).byteLength,
    };
  } catch (error) {
    const reason = error instanceof Error && 'code' in error
      ? String((error as { code?: string }).code ?? error.message)
      : 'assemble_failed';
    return { status: 'denied', reason };
  } finally {
    // Incrément 1 : le bail ne couvre que la fenêtre d'assemblage (N2 Vibe).
    // Échec de release non silencieux sauf bail déjà absent.
    try {
      await releaseAgentLease(db, {
        cycleId: input.cycleId,
        participantId: input.participantId,
        taskId: input.taskId,
        workerId: input.workerId,
        now: input.now !== undefined ? input.now + 1 : undefined,
      });
    } catch (error) {
      if (!(error instanceof AgentDenied && error.reason === 'agent_lease_not_held')) {
        if (!(error instanceof AgentDenied)) throw error;
      }
    }
  }
}
