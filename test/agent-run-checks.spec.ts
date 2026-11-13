import { describe, it, expect } from 'vitest';
import { focusedCiFailureExcerpt } from '../src/agent-run-checks';

describe('CC8 — API CI diagnostic evidence, bounded and actionable', () => {
  it('shows a late TypeScript error instead of the first npm setup bytes', () => {
    const longSetup = Array.from({ length: 500 }, (_, i) => 'Setup line ' + i + ': package installed').join('\n');
    const log = longSetup + '\nerror TS2307: Cannot find module ../../../../src/collab-store/agentrun/mission-quality\n'
      + 'test/collab-store/agentrun/cc8-s9-parity-gemini.spec.ts:2:27\nProcess completed with exit code 2.\n';
    const result = focusedCiFailureExcerpt(log);
    expect(result).toContain('TS2307');
    expect(result).toContain('cc8-s9-parity-gemini.spec.ts:2:27');
    expect(result).not.toContain('Setup line 0');
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(2000);
  });
  it('selects the latest diagnostic, not an earlier unrelated warning', () => {
    const log = 'warning: old issue\nerror: initial attempt\n' + 'Normal output\n'.repeat(220)
      + 'error TS2307: Cannot find module\nCannot resolve import from tests\n';
    const result = focusedCiFailureExcerpt(log, 500);
    expect(result).toContain('TS2307');
    expect(result).toContain('Cannot resolve import');
  });
  it('uses the trailing lines when no recognizable diagnostic exists', () => {
    const result = focusedCiFailureExcerpt('initial setup\n' + 'noise\n'.repeat(100) + 'Final exit code 1');
    expect(result).toContain('Final exit code 1');
    expect(result).not.toContain('initial setup');
  });
  it('masks recognizable secrets and removes ANSI escapes', () => {
    const log = '\u001b[31merror: auth failed for token ghp_abc123abc123abc123\u001b[0m';
    const result = focusedCiFailureExcerpt(log);
    expect(result).toContain('[jeton masqué]');
    expect(result).not.toContain('ghp_');
    expect(result).not.toContain('\u001b');
  });
});
