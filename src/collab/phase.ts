import { assertPhase, StateContractError } from './contracts';
import type { AgentRole, Phase } from './contracts';

const PHASE_ACTIONS: Record<Phase, readonly string[]> = {
  P1: ['read_context', 'prepare_independent_proposal', 'publish_contribution', 'stop_at_boundary'],
  P2: ['read_peer_sources', 'publish_delta_or_objection', 'record_private_vote', 'stop_at_boundary'],
  P3: ['re_read_sources', 'revise_roles_and_plan', 'record_private_revote', 'stop_at_boundary'],
  P4: ['assemble_plan', 'publish_task_board', 'record_open_questions', 'stop_at_boundary'],
  P5: ['read_assigned_context', 'implement_owned_paths', 'publish_branch_or_pr', 'report_handoff'],
  P6: ['read_changed_paths', 'review_and_test_independently', 'request_or_apply_correction', 'report_lessons'],
};

export interface PhaseGuidance {
  phase: Phase;
  role: AgentRole;
  actions: readonly string[];
  ownerDecisionRequired: boolean;
  advisory: string;
}

export interface OwnerDecisionHint {
  transition?: string;
  arbitration?: string;
  merge?: string;
}

export function derivePhaseGuidance(
  phaseValue: string,
  role: AgentRole,
  ownerDecision?: OwnerDecisionHint,
): PhaseGuidance {
  const phase = assertPhase(phaseValue);
  const actions = new Set(PHASE_ACTIONS[phase]);
  if (role === 'owner') {
    actions.add('authorize_transition');
    actions.add('arbitrate_blocker');
    actions.add('approve_merge');
  }
  if (role === 'assembler') {
    actions.add('maintain_canonical_state');
    actions.add('reconcile_evidence');
    actions.add('publish_assembly');
  }
  const pending = ownerDecision ? ' Owner decision pending: ' + (ownerDecision.transition ?? ownerDecision.arbitration ?? ownerDecision.merge ?? 'review required') + '.' : '';
  const advisory = role === 'owner'
    ? 'The owner is the authority for transitions, arbitration and merge.' + pending
    : 'This role contributes evidence and reports blockers; it does not infer an owner decision.' + pending + ' A sync_pending state must be reported until the owner state is refreshed.';
  return { phase, role, actions: [...actions], ownerDecisionRequired: role !== 'owner', advisory };
}

export { PHASE_ACTIONS };
