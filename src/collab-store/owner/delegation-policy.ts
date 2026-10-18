/** CC-5 L3c: fail-closed delegated-owner policy. This module grants NO authority by itself. */
export const DELEGATED_ACTIONS = [
  'import_state', 'install_phases', 'reassign_task', 'open_round',
  'change_phase', 'close_issue', 'close_pull_request', 'dispatch_task',
  'approve_owner_request',
] as const;
export type DelegatedAction = (typeof DELEGATED_ACTIONS)[number];

export const NEVER_DELEGATED = [
  'merge_main', 'merge_master', 'deploy_production', 'deploy_external',
  'deploy_cc3_test', 'grant_delegation', 'extend_delegation',
  'modify_delegation', 'revoke_delegation', 'appoint_coordinator',
  'extend_coordinator', 'revoke_coordinator', 'grant_rights',
  'revoke_rights', 'set_identity_family', 'grant_coordinator',
  'register_endpoint', 'manage_secrets', 'manage_credentials',
  'waive_security', 'halt_automation', 'resume_automation',
  'waive_d12', 'promote_api_voter', 'activate_api_voter',
  'change_security_rules', 'change_protected_paths',
  'fund_envelope', 'raise_envelope', 'raise_global_limit',
] as const;

export interface DelegationPolicyInput {
  action: string;
  params: Record<string, unknown>;
  cycleId: string;
  envelopeCents: number;
}

export class DelegationDenied extends Error {
  constructor(public readonly reason: string) { super('Delegation denied: ' + reason); }
}

const own = (obj: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
const PROTECTED = /delegat|grant|owner decision|owner decisions|owner decisions|halt|d12|security|protected.path|coordinator|mandat|epoch|credential|secret|fund|budget|limit|voting|api channel/i;
const FIELDS: Record<DelegatedAction, readonly string[]> = {
  import_state: ['cycle_id', 'markdown'],
  install_phases: ['cycle_id', 'definitions'],
  reassign_task: ['cycle_id', 'task_id', 'owner_pid', 'reviewer_pid', 'tester_pid'],
  open_round: ['cycle_id', 'round_id'],
  change_phase: ['cycle_id', 'phase'],
  close_issue: ['repository', 'issue_number'],
  close_pull_request: ['repository', 'pull_number'],
  dispatch_task: ['cycle_id', 'task_id', 'max_cost_cents'],
  approve_owner_request: ['request_id', 'target_action', 'target_params'],
};
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** Validate action AND exact parameters, including nested approval target. */
export function assertDelegatedAction(input: DelegationPolicyInput): DelegatedAction {
  const action = input.action as DelegatedAction;
  if (!(DELEGATED_ACTIONS as readonly string[]).includes(input.action)) throw new DelegationDenied('action_not_allowlisted');
  if (!record(input.params) || !Number.isSafeInteger(input.envelopeCents) || input.envelopeCents < 0) {
    throw new DelegationDenied('invalid_parameters_or_envelope');
  }
  const required = FIELDS[action];
  if (required.some(key => !own(input.params, key))) throw new DelegationDenied('missing_parameter');
  if (Object.keys(input.params).some(key => !required.includes(key))) throw new DelegationDenied('unexpected_parameter');
  if ('cycle_id' in input.params && input.params.cycle_id !== input.cycleId) throw new DelegationDenied('cycle_mismatch');
  if (action === 'import_state') {
    const markdown = input.params.markdown;
    // No safe structured diff verifier yet: deny all state imports rather than risk a grant escalation.
    if (typeof markdown !== 'string' || !markdown.trim()) throw new DelegationDenied('invalid_state');
    throw new DelegationDenied('state_diff_verifier_required');
  }
  if (action === 'install_phases' && typeof input.params.definitions !== 'string') throw new DelegationDenied('invalid_phases');
  if (action === 'dispatch_task') {
    const cost = input.params.max_cost_cents;
    if (!Number.isSafeInteger(cost) || (cost as number) < 0 || (cost as number) > input.envelopeCents) {
      throw new DelegationDenied('envelope_exceeded');
    }
  }
  if (action === 'approve_owner_request') {
    const target = input.params.target_action;
    const params = input.params.target_params;
    if (typeof target !== 'string' || target === 'approve_owner_request' || !record(params)) {
      throw new DelegationDenied('invalid_nested_approval');
    }
    assertDelegatedAction({ ...input, action: target, params });
  }
  return action;
}

export interface FourEyesInput {
  requestId: string;
  action: string;
  paramsHash: string;
  maxCostCents: number;
  expiresAt: number;
  now: number;
  coordinatorParticipant: string;
  coordinatorFamily: string;
  reviewerParticipant: string;
  reviewerFamily: string;
  authenticatedReviewer: boolean;
  approval: { requestId: string; action: string; paramsHash: string; maxCostCents: number; expiresAt: number };
}
/** This check is supplementary; server must resolve both families and authenticate principal. */
export function assertFourEyes(input: FourEyesInput): void {
  if (!input.authenticatedReviewer || !input.coordinatorParticipant || !input.reviewerParticipant ||
      !input.coordinatorFamily || !input.reviewerFamily ||
      input.coordinatorParticipant === input.reviewerParticipant ||
      input.coordinatorFamily === input.reviewerFamily) throw new DelegationDenied('not_independent');
  if (!Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= input.now || !Number.isSafeInteger(input.maxCostCents) || input.maxCostCents < 0 ||
      !/^[a-f0-9]{64}$/.test(input.paramsHash)) throw new DelegationDenied('invalid_approval_binding');
  const a = input.approval;
  if (a.requestId !== input.requestId || a.action !== input.action || a.paramsHash !== input.paramsHash ||
      a.maxCostCents !== input.maxCostCents || a.expiresAt !== input.expiresAt) {
    throw new DelegationDenied('approval_mismatch');
  }
}
