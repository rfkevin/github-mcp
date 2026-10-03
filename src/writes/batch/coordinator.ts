import { InputValidationError } from '../../github/types';
import { SENSITIVE_FILE } from '../../github/files';
import { assertWritableBranch, assertWritablePath } from '../../security/policy';
import type { WriteCoordinator } from '../coordinator';
import { applyChangesSchema, BATCH_MAX_INPUT_BYTES, BATCH_MAX_LOADED_BYTES, BATCH_MAX_WORKING_BYTES, type ApplyChangesInput } from './schema';
import { loadBatchSnapshot } from './snapshot';
import { planBatchChanges } from './plan';

type Reads = Parameters<typeof loadBatchSnapshot>[0];
export class BatchChangeCoordinator {
  constructor(private readonly actorBranchPrefix: string, private readonly reads: Reads, private readonly writes: WriteCoordinator) {}
  async apply(input: ApplyChangesInput) {
    const args = applyChangesSchema.parse(input);
    if (new TextEncoder().encode(JSON.stringify(args.operations)).byteLength > BATCH_MAX_INPUT_BYTES) throw new InputValidationError('Le lot d’opérations dépasse 1 Mo.', 'BATCH_INPUT_TOO_LARGE');
    assertWritableBranch(args.branch);
    if (!args.branch.startsWith(this.actorBranchPrefix)) throw new InputValidationError('Cette branche n’appartient pas à l’utilisateur connecté.', 'BRANCH_OWNER_MISMATCH');
    for (const operation of args.operations) {
      assertWritablePath(operation.path);
      if (SENSITIVE_FILE.test(operation.path)) throw new InputValidationError('Fichier sensible interdit.', 'SENSITIVE_FILE');
    }
    const snapshot = await loadBatchSnapshot(this.reads, args.repository, args.branch, args.expectedHeadSha, args.operations);
    const loadedBytes = [...snapshot.files.values(), ...snapshot.sources.values()].reduce((sum, file) => sum + (file ? new TextEncoder().encode(file.content).byteLength : 0), 0);
    if (loadedBytes > BATCH_MAX_LOADED_BYTES) throw new InputValidationError('Les contenus chargés dépassent 2 Mo.', 'BATCH_LOADED_TOO_LARGE');
    const plan = planBatchChanges(args.repository, args.operations, snapshot);
    if (plan.errors.length) return { status: 'rejected' as const, applied: false, atomic: true, headBeforeSha: snapshot.headSha, operations: plan.operations, errors: plan.errors };
    const workingBytes = plan.changes.reduce((sum, file) => sum + new TextEncoder().encode(file.content).byteLength, 0);
    if (workingBytes > BATCH_MAX_WORKING_BYTES) throw new InputValidationError('Le contenu de travail dépasse 2 Mo.', 'BATCH_WORKING_TOO_LARGE');
    if (plan.changes.length === 0) return { status: 'unchanged' as const, applied: false, atomic: true, headBeforeSha: snapshot.headSha, operations: plan.operations, errors: [] };
    const result = await this.writes.commitChanges({ repository: args.repository, branch: args.branch, expectedHeadSha: args.expectedHeadSha,
      message: args.message, agentLabel: args.agentLabel, changes: plan.changes, deletions: [] });
    return { status: 'applied' as const, applied: true, atomic: true, headBeforeSha: snapshot.headSha, ...result, operations: plan.operations, errors: [] };
  }
}
