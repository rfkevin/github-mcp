import { describe, expect, it } from 'vitest';
import {
  NO_TOOL_CALL_RECOVERY_MAX,
  isRecoverablePreparationViolation,
  preparationNoToolCallFeedback,
  preparationViolation,
  PREPARATION_ROUNDS_MAX,
  PREPARATION_READ_TOOLS,
} from '../../../src/collab-store/agentrun/guided-preparation';

/** Pure decision table mirroring engine C1 recovery gate (D1 count -> continue|stop). */
function recoveryDecision(usedRecoveries: number, violation: string): 'recover' | 'fail' | 'not_recoverable' {
  if (!isRecoverablePreparationViolation(violation)) return 'not_recoverable';
  return usedRecoveries < NO_TOOL_CALL_RECOVERY_MAX ? 'recover' : 'fail';
}

describe('CC8 C1 unified recovery', () => {
  it('marks only no_tool_call as recoverable', () => {
    expect(isRecoverablePreparationViolation('no_tool_call')).toBe(true);
    expect(isRecoverablePreparationViolation('tool_not_offered:x')).toBe(false);
    expect(isRecoverablePreparationViolation('too_many_tool_calls')).toBe(false);
  });
  it('keeps preparationViolation no_tool_call semantics', () => {
    expect(preparationViolation({ tool_calls: [], text: 'analyse' } as any, [...PREPARATION_READ_TOOLS])).toBe('no_tool_call');
  });
  it('bounds recovery max to 2 and keeps preparation rounds', () => {
    expect(NO_TOOL_CALL_RECOVERY_MAX).toBe(2);
    expect(PREPARATION_ROUNDS_MAX).toBe(3);
  });
  it('feedback mentions remaining or final stop', () => {
    expect(preparationNoToolCallFeedback(1)).toMatch(/restantes/i);
    expect(preparationNoToolCallFeedback(0)).toMatch(/Derniere|arrete|arrêt/i);
  });
  it('recovery gate: 0 and 1 used -> recover; 2+ -> fail (typed stop)', () => {
    expect(recoveryDecision(0, 'no_tool_call')).toBe('recover');
    expect(recoveryDecision(1, 'no_tool_call')).toBe('recover');
    expect(recoveryDecision(2, 'no_tool_call')).toBe('fail');
    expect(recoveryDecision(3, 'no_tool_call')).toBe('fail');
  });
  it('recovery gate: other violations never recover (no D12/HALT widening)', () => {
    expect(recoveryDecision(0, 'tool_not_offered:github_commit_files')).toBe('not_recoverable');
    expect(recoveryDecision(0, 'too_many_tool_calls')).toBe('not_recoverable');
    expect(recoveryDecision(0, 'handover_required_once')).toBe('not_recoverable');
  });
  it('exactly two recoveries then stop — no third recovery slot', () => {
    const sequence = [0, 1, 2].map(u => recoveryDecision(u, 'no_tool_call'));
    expect(sequence).toEqual(['recover', 'recover', 'fail']);
  });
});
