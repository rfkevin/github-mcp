import { describe, expect, it } from 'vitest';

function parseProposals(text: string, author: string) {
  const contribRe = /^###\s+(\d{4}-\d{2}-\d{2}-[\w.-]+)\s*$/gm;
  const headers = [...text.matchAll(contribRe)];
  const proposals = [];
  for (let i = 0; i < headers.length; i++) {
    const id = headers[i][1];
    const start = headers[i].index! + headers[i][0].length;
    const end = i + 1 < headers.length ? headers[i + 1].index! : text.length;
    const body = text.slice(start, end).trim();
    const para = body
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .find((p) => p.length > 0 && !p.startsWith('```'));
    if (!para) continue;
    proposals.push({
      import_id: id,
      evidence_refs: [`agent-memory:${id}`],
      author_pid: author,
      text: para.length > 600 ? para.slice(0, 597) + '...' : para,
    });
  }
  return proposals;
}

describe('CC-3 C4 — import AGENT_MEMORY idempotence', () => {
  it('is deterministic and preserves source refs (dedupe by import_id)', () => {
    const sample = `
### 2026-10-01-grok-sample
Auteur : Grok | Contexte : test

First fact paragraph stays stable.

### 2026-10-02-grok-other
Second entry body.
`;
    const a = parseProposals(sample, 'agent:grok');
    const b = parseProposals(sample, 'agent:grok');
    expect(a).toEqual(b);
    expect(a.map((p) => p.import_id)).toEqual(['2026-10-01-grok-sample', '2026-10-02-grok-other']);
    expect(a[0].evidence_refs[0]).toBe('agent-memory:2026-10-01-grok-sample');
    expect(new Set(a.map((p) => p.import_id)).size).toBe(a.length);
  });
});
