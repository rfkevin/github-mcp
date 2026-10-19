import { describe, expect, it } from 'vitest';
import {
  assertApiToolAllowed, assertNotD12Verdict, API_AGENT_FORBIDDEN, API_AGENT_TOOLS, AgentDenied,
} from '../../../src/collab-store/agents';

describe('CC-5 L3b — outils API deny-by-default', () => {
  it.each([...API_AGENT_TOOLS])('autorise %s', tool => {
    expect(assertApiToolAllowed(tool)).toBe(tool);
  });

  it.each([...API_AGENT_FORBIDDEN])('interdit %s sur le canal API', tool => {
    expect(() => assertApiToolAllowed(tool)).toThrow('tool_forbidden_on_api_channel');
  });

  it('refuse un outil inconnu', () => {
    expect(() => assertApiToolAllowed('surprise')).toThrow('tool_not_allowlisted');
  });

  it('refuse les payloads verdict D12 (AGREE/PASS/AMEND + head)', () => {
    const head = 'a'.repeat(40);
    expect(() => assertNotD12Verdict({ state: 'AGREE', head, base: 'b'.repeat(40) }))
      .toThrow('d12_verdict_forbidden_on_api_channel');
    expect(() => assertNotD12Verdict({ verdict: 'PASS', task: 'l3b' }))
      .toThrow('d12_verdict_forbidden_on_api_channel');
    expect(() => assertNotD12Verdict({ kind: 'test_verdict', state: 'ok' }))
      .toThrow('d12_verdict_forbidden_on_api_channel');
  });

  it('accepte un payload non-verdict (clarify / memory)', () => {
    expect(() => assertNotD12Verdict({ question: 'pourquoi ?', to: 'vibe' })).not.toThrow();
    expect(() => assertNotD12Verdict({ kind: 'observation', text: 'note' })).not.toThrow();
  });

  it('refuse un payload non objet', () => {
    expect(() => assertNotD12Verdict('AGREE')).toThrow(AgentDenied);
  });
});
