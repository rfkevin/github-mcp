import { describe, expect, it } from 'vitest';
import {
  NO_TOOL_CALL_RECOVERY_MAX,
  isRecoverablePreparationViolation,
  preparationNoToolCallFeedback,
  preparationViolation,
  PREPARATION_ROUNDS_MAX,
  PREPARATION_READ_TOOLS,
} from '../../../src/collab-store/agentrun/guided-preparation';

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
});
