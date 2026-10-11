import { describe, expect, it } from 'vitest';
import { toEventOutput } from '../../../src/collab-store/mcp/result';
import { storedEvent } from '../../../src/collab-store/mcp/schemas';
import { STORED_EVENT_COLUMNS, type StoredStoreEvent } from '../../../src/collab-store/store/collab-store';

// CC-3 — projection publique des événements (sortie MCP stricte, model_meta interne).
const row: StoredStoreEvent = {
  seq: 7, cycle_id: 'cc3', at: 1, type: 'checkpoint', participant_id: 'gpt6', session_id: 's', role: 'reviewer',
  payload_json: '{"test_id":"cc3-cross-agent-read-001"}', expected_rev: 6, idempotency_key: 'op:k', evidence_ref: 'ev',
};

describe('CC-3 — toEventOutput', () => {
  it('garde toutes les colonnes publiques à l’identique et retire model_meta comme toute colonne inconnue', () => {
    const stored = { ...row, model_meta: 'interne', future_column: 1 } as unknown as StoredStoreEvent;
    expect(toEventOutput(stored)).toEqual(row);
    expect(Object.keys(toEventOutput(stored))).toEqual([...STORED_EVENT_COLUMNS]);
  });

  it('le schéma publié et les colonnes lues par le store décrivent exactement les mêmes champs', () => {
    expect(Object.keys(storedEvent).sort()).toEqual([...STORED_EVENT_COLUMNS].sort());
  });
});
