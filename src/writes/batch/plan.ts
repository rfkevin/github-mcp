import { InputValidationError } from '../../github/types';
import { publicFailure } from '../../errors/public-failure';
import { appendExact, replaceExactOnce } from '../text-transforms';
import type { BatchSnapshot } from './snapshot';
import type { BatchError, BatchOperation, BatchOperationState } from './schema';

export type PlannedChange = { path: string; content: string; expectedSha?: string };
export type BatchPlan = { changes: PlannedChange[]; errors: BatchError[]; operations: BatchOperationState[] };

export function planBatchChanges(repository: string, operations: readonly BatchOperation[], snapshot: BatchSnapshot): BatchPlan {
  const errors: BatchError[] = [];
  const states: BatchOperationState[] = [];
  const working = new Map<string, string | undefined>();
  const failedPaths = new Set<string>();
  const initialSha = new Map<string, string | undefined>();
  for (const [path, file] of snapshot.files) { working.set(path, file?.content); initialSha.set(path, file?.sha.toLowerCase()); }
  const counts = new Map<string, number>();
  const isolatedPaths = new Set<string>();
  for (const operation of operations) {
    counts.set(operation.path, (counts.get(operation.path) ?? 0) + 1);
    if (operation.type === 'restore' || operation.type === 'create') isolatedPaths.add(operation.path);
  }

  operations.forEach((operation, index) => {
    if (failedPaths.has(operation.path)) { states.push({ index, path: operation.path, state: 'not_evaluated' }); return; }
    try {
      if (isolatedPaths.has(operation.path) && counts.get(operation.path)! > 1) {
        throw new InputValidationError('create et restore doivent être seuls sur leur chemin en V1.', 'OPERATION_COMBINATION_DENIED');
      }
      const currentSha = initialSha.get(operation.path);
      if (operation.type !== 'create') {
        const expected = operation.expectedSha?.toLowerCase();
        if (expected === null) { if (currentSha !== undefined) throw new InputValidationError('Le fichier existe alors que son absence était attendue.', 'FILE_EXISTS'); }
        else if (!currentSha || currentSha !== expected) throw new InputValidationError('Le SHA attendu ne correspond pas au blob initial.', 'EXPECTED_SHA_CONFLICT');
      } else if (currentSha !== undefined) throw new InputValidationError('Le fichier existe déjà.', 'FILE_EXISTS');

      const current = working.get(operation.path);
      if (operation.type === 'replace') {
        if (current === undefined) throw new InputValidationError('Le fichier cible est absent.', 'FILE_MISSING');
        working.set(operation.path, replaceExactOnce(current, operation.oldText, operation.newText));
      } else if (operation.type === 'append') {
        if (current === undefined) throw new InputValidationError('Le fichier cible est absent.', 'FILE_MISSING');
        working.set(operation.path, appendExact(current, operation.text));
      } else if (operation.type === 'create') working.set(operation.path, operation.content);
      else {
        const commitSha = snapshot.sourceRefs.get(operation.sourceRef);
        const source = commitSha ? snapshot.sources.get(`${repository}\n${commitSha}\n${operation.path}`) : undefined;
        if (!source) throw new InputValidationError('Source de restauration introuvable.', 'RESTORE_SOURCE_MISSING');
        working.set(operation.path, source.content);
      }
      states.push({ index, path: operation.path, state: 'prepared' });
    } catch (error) {
      const failure = publicFailure(error, 'Précondition invalide.');
      errors.push({ index, path: operation.path, code: failure.code, message: failure.message });
      states.push({ index, path: operation.path, state: 'failed' }); failedPaths.add(operation.path);
    }
  });

  if (errors.length) return { changes: [], errors: errors.sort((a, b) => a.index - b.index), operations: states };
  const changes: PlannedChange[] = [];
  for (const [path, content] of working) {
    const initial = snapshot.files.get(path);
    if (content === initial?.content) {
      for (const state of states) if (state.path === path) state.state = 'unchanged';
      continue;
    }
    if (content !== undefined) changes.push({ path, content, ...(initial ? { expectedSha: initial.sha } : {}) });
  }
  return { changes, errors, operations: states };
}
