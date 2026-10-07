import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../../src/collab-store/memory/memory-store';
import { StateContractError } from '../../../src/collab/contracts';

const bindings = env as unknown as { COLLAB_DB_C2: D1Database };

function store(): MemoryStore {
  return new MemoryStore(bindings.COLLAB_DB_C2);
}

describe('CC-3 C4 — memory lifecycle (I4)', () => {
  it('propose creates candidate; activate requires distinct reviewer + evidence', async () => {
    const mem = store();
    const proposed = await mem.propose({
      scope: 'role:author',
      kind: 'lesson',
      text: 'Always read owned paths before writing.',
      evidence_refs: ['pr:60#c1'],
      author_pid: 'agent:a',
    });
    expect(proposed.status).toBe('candidate');
    expect(proposed.version).toBe(1);

    await expect(mem.activate(proposed.id, 1, 'agent:a')).rejects.toThrow(/distinct from the author/);

    const active = await mem.activate(proposed.id, 1, 'agent:b');
    expect(active.status).toBe('active');
    expect(active.reviewer_pid).toBe('agent:b');
  });

  it('supersede marks prior active and creates new candidate version', async () => {
    const mem = store();
    const p = await mem.propose({
      scope: 'project:cc3',
      kind: 'fact',
      text: 'C2 merged at 3a82d3f.',
      evidence_refs: ['pr:60'],
      author_pid: 'agent:a',
    });
    await mem.activate(p.id, 1, 'agent:b');
    const next = await mem.supersede(p.id, 'agent:c', 'C2 merged; head advanced on cc3-integration.', ['pr:60']);
    expect(next.version).toBe(2);
    expect(next.status).toBe('candidate');
    const old = await mem.get(p.id, 1);
    expect(old?.status).toBe('superseded');
  });

  it('retire is a tombstone (row kept)', async () => {
    const mem = store();
    const p = await mem.propose({
      scope: 'task:c4',
      kind: 'observation',
      text: 'Temporary note for C4 tests.',
      author_pid: 'agent:a',
    });
    const retired = await mem.retire(p.id, 1);
    expect(retired.status).toBe('retired');
    expect(await mem.get(p.id, 1)).not.toBeNull();
  });

  it('listActive filters by scope', async () => {
    const mem = store();
    const a = await mem.propose({
      scope: 'common',
      kind: 'invariant',
      text: 'I4: no silent delete of memory.',
      evidence_refs: ['plan:25'],
      author_pid: 'agent:a',
    });
    await mem.activate(a.id, 1, 'agent:b');
    const list = await mem.listActive(['common']);
    expect(list.some((row) => row.id === a.id)).toBe(true);
  });

  it('rejects text over 600 chars', async () => {
    const mem = store();
    await expect(
      mem.propose({
        scope: 'common',
        kind: 'fact',
        text: 'x'.repeat(601),
        author_pid: 'agent:a',
      }),
    ).rejects.toBeInstanceOf(StateContractError);
  });
});
