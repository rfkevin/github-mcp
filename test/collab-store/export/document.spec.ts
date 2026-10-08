import { describe, expect, it } from 'vitest';
import stateR6 from './fixtures/cc3-state-r6.md?raw';
import { parseWorkflowState, taskRecords } from '../../../src/collab/state';
import {
  canonicalState, findTable, getHeader, parseStateDocument, renderStateDocument, setHeader,
} from '../../../src/collab-store/export/document';
import { inlineCell } from '../../../src/collab-store/export/document';

// CC-3 C6 — modèle de document CC-STATE-1 : forme canonique, aucune prose perdue.
describe('CC-3 C6 — document CC-STATE-1', () => {
  it('la forme canonique de l’état réel (rév. 6) est un point fixe, validé par le parser L1', () => {
    const canonical = canonicalState(stateR6);
    expect(canonicalState(canonical)).toBe(canonical);
    expect(canonical).toBe(stateR6.endsWith('\n') ? stateR6 : stateR6 + '\n');
    const snapshot = parseWorkflowState(canonical);
    expect(taskRecords(snapshot).map(task => task.id)).toEqual(['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'T0', 'T1', 'K3']);
  });

  it('ne normalise que la présentation (CRLF, espaces finaux, rembourrage des cellules)', () => {
    const noisy = stateR6.replace(/\n/g, '  \r\n').replace('| C0 | done |', '|C0|   done   |') + '\n\n\n';
    expect(canonicalState(noisy)).toBe(canonicalState(stateR6));
  });

  it('lit et réécrit les clés de contrôle sans toucher au reste', () => {
    const document = parseStateDocument(stateR6);
    expect(getHeader(document, 'revision')).toBe('6');
    setHeader(document, 'revision', '7');
    const rendered = renderStateDocument(document);
    expect(parseWorkflowState(rendered).headers.revision).toBe('7');
    expect(rendered.replace('revision: 7', 'revision: 6')).toBe(canonicalState(stateR6));
    expect(findTable(document, 'Evidence', ['source', 'state'])?.rows.length).toBeGreaterThan(10);
  });

  it('refuse un état legacy (sans schema_version) et un état invalide, avec les codes L1', () => {
    expect(() => parseStateDocument(stateR6.replace('schema_version: CC-STATE-1\n', '')))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SCHEMA' }));
    expect(() => parseStateDocument(stateR6.replace('phase: P5', 'phase: P9')))
      .toThrow(expect.objectContaining({ code: 'INVALID_PHASE' }));
    expect(() => parseStateDocument(stateR6 + '\n' + 'x'.repeat(262_200)))
      .toThrow(expect.objectContaining({ code: 'STATE_TOO_LARGE' }));
  });

  it('une valeur venue du store devient une cellule sûre (une ligne, sans |, bornée)', () => {
    expect(inlineCell('a | b\n## Owner decisions\n| x |')).toBe('a / b ## Owner decisions / x /');
    expect(inlineCell('   ')).toBe('n/a');
    expect(inlineCell('x'.repeat(500)).length).toBe(400);
  });
});
