import { describe, expect, it } from 'vitest';
import { assertDelegatedAction, NEVER_DELEGATED, DelegationDenied } from '../../../src/collab-store/owner/delegation-policy';

describe('CC-5 L3c forbidden owner actions', () => {
  for (const action of NEVER_DELEGATED) {
    it('rejects delegated ' + action, () => {
      expect(() => assertDelegatedAction({action, params: {}, cycleId: 'cc5-auto2-infra', envelopeCents: 0}))
        .toThrow(DelegationDenied);
    });
  }
  for (const action of ['register_endpoint', 'grant_coordinator', 'set_identity_family']) {
    it('rejects existing owner executor ' + action, () => {
      expect(() => assertDelegatedAction({action, params: {}, cycleId: 'cc5-auto2-infra', envelopeCents: 0}))
        .toThrow('action_not_allowlisted');
    });
  }
  it('blocks state import until a structured security diff verifier exists', () => {
    expect(() => assertDelegatedAction({action: 'import_state',
      params: {cycle_id: 'cc5-auto2-infra', markdown: '# CC-STATE-1'}, cycleId: 'cc5-auto2-infra',
      envelopeCents: 0})).toThrow('state_diff_verifier_required');
  });
});
