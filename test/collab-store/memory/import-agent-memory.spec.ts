import { describe, expect, it } from 'vitest';
import { parseAgentMemory } from '../../../scripts/cc3/import-agent-memory.mjs';

describe('CC-3 C4 — import AGENT_MEMORY idempotence', () => {
  it('uses real script parseAgentMemory — deterministic import_id', () => {
    const sample = `
### 2026-10-01-grok-sample
Auteur : Grok | Contexte : test

First fact paragraph stays stable.

### 2026-10-02-grok-other
Second entry body.
`;
    const a = parseAgentMemory(sample, 'agent:grok');
    const b = parseAgentMemory(sample, 'agent:grok');
    expect(a).toEqual(b);
    expect(a.map((p: { import_id: string }) => p.import_id)).toEqual([
      '2026-10-01-grok-sample',
      '2026-10-02-grok-other',
    ]);
    expect(a[0].evidence_refs[0]).toBe('agent-memory:2026-10-01-grok-sample');
  });
});
