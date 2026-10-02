import { z } from 'zod';
import type { ToolContext } from '../../context';
import { GitHubApiError, InputValidationError } from '../../../github/types';
import { SENSITIVE_FILE } from '../../../github/files';
import { assertWritableBranch, assertWritablePath } from '../../../security/policy';
import { agentLabelSchema } from '../../../writes/coordinator';

export const fileWriteInputs = {
  repository: z.string().min(3).max(200), branch: z.string().min(1).max(240), path: z.string().min(1).max(1024),
  expectedHeadSha: z.string().regex(/^[a-f0-9]{40}$/i),
  message: z.string().trim().min(1).max(200), agentLabel: agentLabelSchema.default('agent non précisé'),
};
export const fileSha = z.string().regex(/^[a-f0-9]{40}$/i);
type FileTarget = { repository: string; branch: string; path: string; expectedHeadSha: string; expectedSha: string | null };

/** Read the full current file at an immutable commit, after checking the target. */
export async function readWriteTarget(context: ToolContext, args: FileTarget) {
  assertWritableBranch(args.branch);
  if (!args.branch.startsWith(context.writeCoordinator!.branchPrefix)) {
    throw new InputValidationError('Cette branche n’appartient pas à l’utilisateur connecté.', 'BRANCH_OWNER_MISMATCH');
  }
  assertWritablePath(args.path);
  if (SENSITIVE_FILE.test(args.path)) throw new InputValidationError('Fichier sensible interdit.', 'SENSITIVE_FILE');
  const head = await context.reads.branches.getBranchHead(args.repository, args.branch);
  if (head.toLowerCase() !== args.expectedHeadSha.toLowerCase()) {
    throw new InputValidationError('La branche a changé : relisez le fichier.', 'HEAD_CHANGED');
  }
  let file;
  try { file = await context.reads.files.getTextFile(args.repository, args.path, args.expectedHeadSha.toLowerCase()); }
  catch (error) {
    if (args.expectedSha === null && error instanceof GitHubApiError && error.status === 404) return undefined;
    throw error;
  }
  if (args.expectedSha === null || file.sha.toLowerCase() !== args.expectedSha.toLowerCase()) {
    throw new InputValidationError('Le fichier a changé depuis sa lecture.', 'FILE_CHANGED');
  }
  return file;
}
