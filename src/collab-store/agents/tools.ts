/**
 * CC-5 L3b — allowlist d'outils pour agents API (deny-by-default).
 *
 * Interdit explicitement toute émission de verdict D12 (evidence AGREE/PASS/
 * AMEND au couple head/base) depuis le canal API. Les verdicts restent sur
 * le canal chat/MCP authentifié des collaborateurs humains.
 */
import { AgentDenied } from './persona';

/** Outils autorisés pour un passage agent API (lecture + propositions non-D12). */
export const API_AGENT_TOOLS = [
  'collab_get_context',
  'collab_list_executors',
  'memory.propose',
  'clarify.ask',
] as const;

export type ApiAgentTool = (typeof API_AGENT_TOOLS)[number];

/** Outils toujours refusés sur le canal API, même si un futur dispatch les expose. */
export const API_AGENT_FORBIDDEN = [
  'evidence.add',
  'owner.decision',
  'owner.request',
  'delegation.approve',
  'collab_delegate_owner',
  'collab_append_event',
  'merge',
  'deploy',
  'halt',
] as const;

/**
 * Formes de payload evidence qui constitueraient un verdict D12.
 * Un agent API ne peut pas les produire.
 */
const D12_VERDICT = /^(AGREE|PASS|APPROVE|OK|AMEND|BLOCK|CHANGES[_ ]REQUESTED|FAIL|REJECT)\b/i;

export function assertApiToolAllowed(tool: string): ApiAgentTool {
  if ((API_AGENT_FORBIDDEN as readonly string[]).includes(tool)) {
    throw new AgentDenied('tool_forbidden_on_api_channel');
  }
  if (!(API_AGENT_TOOLS as readonly string[]).includes(tool)) {
    throw new AgentDenied('tool_not_allowlisted');
  }
  return tool as ApiAgentTool;
}

/**
 * Refuse tout payload qui ressemble à un verdict D12 (state/verdict + head/base).
 * Fail-closed : payload illisible → refus.
 */
export function assertNotD12Verdict(payload: unknown): void {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AgentDenied('invalid_payload');
  }
  const record = payload as Record<string, unknown>;
  // state | verdict | review : fail-closed si le texte ressemble à un verdict D12
  // (y compris un « OK » libre en tête — N4 revue Vibe, documenté).
  const state = typeof record.state === 'string' ? record.state
    : typeof record.verdict === 'string' ? record.verdict
      : typeof record.review === 'string' ? record.review : '';
  if (state && D12_VERDICT.test(state.trim())) {
    throw new AgentDenied('d12_verdict_forbidden_on_api_channel');
  }
  // evidence.add avec kind test_verdict / review_verdict explicite
  const kind = typeof record.kind === 'string' ? record.kind : '';
  if (/verdict|review_decision|test_verdict|d12/i.test(kind)) {
    throw new AgentDenied('d12_verdict_forbidden_on_api_channel');
  }
}
