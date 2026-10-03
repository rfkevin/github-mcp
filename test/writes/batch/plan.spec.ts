import { describe, expect, it } from 'vitest';
import { planBatchChanges } from '../../../src/writes/batch/plan';
import type { BatchSnapshot } from '../../../src/writes/batch/snapshot';
import type { BatchOperation } from '../../../src/writes/batch/schema';

const SHA = 'a'.repeat(40), SOURCE = 'b'.repeat(40);
function snapshot(files: Record<string, string | undefined>, sources: Record<string, string> = {}, sourceRefs: Record<string, string> = {}): BatchSnapshot {
  return { headSha: 'c'.repeat(40), files: new Map(Object.entries(files).map(([path, content]) => [path, content === undefined ? undefined : { path, sha: SHA, size: content.length, content }])),
    sources: new Map(Object.entries(sources).map(([key, content]) => [key, { path: key.split('\n')[2], sha: SOURCE, size: content.length, content }])), sourceRefs: new Map(Object.entries(sourceRefs)) };
}

describe('batch plan', () => {
  it('applique plusieurs transformations du même fichier dans l’ordre avec le SHA initial', () => {
    const operations: BatchOperation[] = [
      { type: 'replace', path: 'a.txt', expectedSha: SHA, oldText: 'one', newText: 'two' },
      { type: 'append', path: 'a.txt', expectedSha: SHA, text: '!' },
    ];
    expect(planBatchChanges('o/r', operations, snapshot({ 'a.txt': 'one' })).changes).toEqual([{ path: 'a.txt', content: 'two!', expectedSha: SHA }]);
  });
  it('collecte les erreurs indépendantes et marque la suite du chemin en not_evaluated', () => {
    const operations: BatchOperation[] = [
      { type: 'replace', path: 'a.txt', expectedSha: 'd'.repeat(40), oldText: 'one', newText: 'two' },
      { type: 'append', path: 'a.txt', expectedSha: SHA, text: '!' },
      { type: 'replace', path: 'b.txt', expectedSha: SHA, oldText: 'missing', newText: 'x' },
    ];
    const plan = planBatchChanges('o/r', operations, snapshot({ 'a.txt': 'one', 'b.txt': 'present' }));
    expect(plan.errors.map(error => [error.index, error.code])).toEqual([[0, 'EXPECTED_SHA_CONFLICT'], [2, 'TEXT_NOT_FOUND']]);
    expect(plan.operations[1].state).toBe('not_evaluated');
    expect(plan.changes).toEqual([]);
  });
  it('restaure deux chemins distincts depuis la même référence sans confondre leurs contenus', () => {
    const keyA = `o/r\n${SOURCE}\na.txt`, keyB = `o/r\n${SOURCE}\nb.txt`;
    const operations: BatchOperation[] = [
      { type: 'restore', path: 'a.txt', expectedSha: SHA, sourceRef: 'good' },
      { type: 'restore', path: 'b.txt', expectedSha: SHA, sourceRef: 'good' },
    ];
    const plan = planBatchChanges('o/r', operations, snapshot({ 'a.txt': 'bad-a', 'b.txt': 'bad-b' }, { [keyA]: 'good-a', [keyB]: 'good-b' }, { good: SOURCE }));
    expect(plan.changes.map(change => change.content)).toEqual(['good-a', 'good-b']);
  });
  it('retire les fichiers sans effet net et refuse create/restore combiné sur un chemin', () => {
    const unchanged = planBatchChanges('o/r', [{ type: 'replace', path: 'a.txt', expectedSha: SHA, oldText: 'a', newText: 'b' }, { type: 'replace', path: 'a.txt', expectedSha: SHA, oldText: 'b', newText: 'a' }], snapshot({ 'a.txt': 'a' }));
    expect(unchanged.changes).toEqual([]); expect(unchanged.operations.every(state => state.state === 'unchanged')).toBe(true);
    const denied = planBatchChanges('o/r', [{ type: 'create', path: 'new.txt', content: 'x' }, { type: 'append', path: 'new.txt', expectedSha: SHA, text: 'y' }], snapshot({ 'new.txt': undefined }));
    expect(denied.errors[0].code).toBe('OPERATION_COMBINATION_DENIED');
  });
});
