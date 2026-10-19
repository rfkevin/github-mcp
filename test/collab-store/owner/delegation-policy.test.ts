import { describe, expect, it } from 'vitest';
import { assertDelegatedAction, assertFourEyes, DELEGATED_ACTIONS, NEVER_DELEGATED } from '../../../src/collab-store/owner/delegation-policy';

const base = { cycleId: 'cc5-auto2-infra', envelopeCents: 0 };
const params: Record<string, Record<string, unknown>> = {
  import_state: { cycle_id: base.cycleId, markdown: 'state' },
  install_phases: { cycle_id: base.cycleId, definitions: '[]' },
  reassign_task: { cycle_id: base.cycleId, task_id: 'l3c', owner_pid: 'a', reviewer_pid: 'b', tester_pid: 'c',
    expected_revision: 1, expected_owner_pid: 'd', expected_reviewer_pid: 'e', expected_tester_pid: 'f' },
  open_round: { cycle_id: base.cycleId, round_id: 'r2' },
  change_phase: { cycle_id: base.cycleId, phase: 'P6' },
  close_issue: { repository: 'rfkevin/github-mcp', issue_number: 154 },
  close_pull_request: { repository: 'rfkevin/github-mcp', pull_number: 162 },
  dispatch_task: { cycle_id: base.cycleId, task_id: 'l3c', max_cost_cents: 0 },
  approve_owner_request: { request_id: 'r1', target_action: 'install_phases', target_params: { cycle_id: base.cycleId, definitions: '[]' } },
};
describe('L3c delegation deny-by-default', () => {
  it.each(NEVER_DELEGATED)('refuses forbidden %s even with delegated credential', action => {
    expect(() => assertDelegatedAction({ ...base, action, params: {} })).toThrow('action_not_allowlisted');
  });
  it('refuses unknown actions', () => expect(() => assertDelegatedAction({ ...base, action: 'surprise', params: {} })).toThrow());
  it.each(DELEGATED_ACTIONS)('checks exact parameters for %s', action => {
    expect(() => assertDelegatedAction({ ...base, action, params: { ...params[action], privilege: 'owner' } })).toThrow('unexpected_parameter');
  });
  it('rejects unverified state imports even when nominally allowlisted', () => {
    expect(() => assertDelegatedAction({ ...base, action: 'import_state', params: params.import_state })).toThrow('state_diff_verifier_required');
  });
  it('rejects cost above the owner envelope', () => {
    expect(() => assertDelegatedAction({ ...base, action: 'dispatch_task', params: { ...params.dispatch_task, max_cost_cents: 1 } })).toThrow('envelope_exceeded');
  });
  it('rejects nested forbidden owner approval', () => {
    expect(() => assertDelegatedAction({ ...base, action: 'approve_owner_request', params: { request_id: 'x', target_action: 'grant_coordinator', target_params: {} } })).toThrow();
  });
});
const four = {
  requestId: 'r1', action: 'install_phases', paramsHash: 'a'.repeat(64),
  maxCostCents: 0, expiresAt: 200, now: 100,
  coordinatorParticipant: 'gpt6', coordinatorFamily: 'chatgpt',
  reviewerParticipant: 'vibe', reviewerFamily: 'vibe',
  authenticatedReviewer: true,
  approval: { requestId: 'r1', action: 'install_phases', paramsHash: 'a'.repeat(64), maxCostCents: 0, expiresAt: 200 },
};
describe('L3c independent four eyes', () => {
  it('accepts only exact bound independent proof', () => expect(() => assertFourEyes(four)).not.toThrow());
  it('rejects self approval', () => expect(() => assertFourEyes({ ...four, reviewerParticipant: 'gpt6' })).toThrow());
  it('rejects same family alias', () => expect(() => assertFourEyes({ ...four, reviewerFamily: 'chatgpt' })).toThrow());
  it('rejects unauthenticated proof', () => expect(() => assertFourEyes({ ...four, authenticatedReviewer: false })).toThrow());
  it('rejects expired proof', () => expect(() => assertFourEyes({ ...four, now: 201 })).toThrow());
  it.each(['requestId', 'action', 'paramsHash', 'maxCostCents', 'expiresAt'] as const)('rejects changed %s', key => {
    expect(() => assertFourEyes({ ...four, approval: { ...four.approval, [key]: key === 'maxCostCents' ? 1 : key === 'expiresAt' ? 300 : 'changed' } })).toThrow();
  });
});
