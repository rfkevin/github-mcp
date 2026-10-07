import { describe, expect, it } from 'vitest';
import schemaSql from '../../../src/collab-store/schema/0001_init.sql?raw';

const SOURCES: Array<[string, string]> = [];

async function loadSources(): Promise<Array<[string, string]>> {
  if (SOURCES.length) return SOURCES;
  const modules = import.meta.glob('../../../src/collab-store/**/*.ts', {
    query: '?raw',
    import: 'default',
  }) as Record<string, () => Promise<string>>;
  for (const [path, loader] of Object.entries(modules)) {
    SOURCES.push([path, await loader()]);
  }
  return SOURCES;
}

describe('CC-3 C1 architecture guards', () => {
  it('keeps L1 contracts untouched (no import from src/mcp/**)', async () => {
    for (const [path, content] of await loadSources()) {
      expect(content, path).not.toMatch(/from ['"]\.\.?\/.*mcp\//);
      expect(content, path).not.toMatch(/from ['"]src\/mcp\//);
    }
  });

  it('ships portable SQL (O-P4M1)', () => {
    const body = schemaSql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(body).not.toMatch(/PRAGMA|WITHOUT ROWID|STRICT/i);
    for (const table of [
      'participants', 'participant_clients', 'cycles', 'phase_definitions', 'tasks',
      'events', 'sealed_items', 'memory_entries', 'evidence_ledger',
      'owner_decisions', 'checkpoints', 'quota_counters',
    ]) {
      expect(schemaSql, table).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });
});
