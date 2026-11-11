import { describe, expect, it } from 'vitest';
import { typedStop } from '../../../src/collab-store/agentrun/chat-continuity';

describe('CC8 U1 — diagnostics typés et expurgés partagés chat/API', () => {
  it.each([
    ['guided_stop:preparation_incomplete', 'guided_stop', 'preparation_incomplete'],
    ['guided_stop:preparation_tools_unavailable', 'guided_stop', 'preparation_tools_unavailable'],
    ['guided_stop:preparation_base_unverified', 'guided_stop', 'preparation_base_unverified'],
    ['guided_stop:task_grant_unavailable', 'guided_stop', 'task_grant_unavailable'],
    ['guided_stop:commit_budget_exhausted', 'guided_stop', 'commit_budget_exhausted'],
    ['incomplete_final:store_effect_missing', 'incomplete_final', 'store_effect_missing'],
    ['guided_preparation_violation:no_tool_call', 'guided_preparation_violation', 'no_tool_call'],
    ['guided_handover_violation:tool_not_offered', 'guided_handover_violation', 'tool_not_offered'],
  ])('restitue une classe stable pour %s', (reason, stop_code, stop_class) => {
    expect(typedStop(reason)).toEqual({ stop_code, stop_class });
  });

  it('ne répercute ni erreur brute ni chaîne libre dans un diagnostic partagé', () => {
    const sensitive = 'never-show-private-file-or-provider-error';
    expect(typedStop('guided_stop:' + sensitive)).toEqual({ stop_code: 'guided_stop', stop_class: null });
    expect(typedStop('unknown_error:' + sensitive)).toEqual({ stop_code: 'other', stop_class: null });
    expect(typedStop(null)).toEqual({ stop_code: 'other', stop_class: null });
  });
});
