import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { GitHubApiError, InputValidationError } from '../../../github/types';
import { SENSITIVE_FILE } from '../../../github/files';
import { assertWritableBranch, assertWritablePath } from '../../../security/policy';
import { agentLabelSchema } from '../../../writes/coordinator';
import { resolveCommit } from './batch';
import { fileSha } from './file-write-context';
import { oauthMetadata } from './metadata';
import { outputSchemas } from './output-schemas';
import { textPayload, toolFailure, toolSuccess } from './result';

const sha = z.string().regex(/^[a-f0-9]{40}$/i).transform(value => value.toLowerCase());
const common = { path: z.string().min(1).max(1024) };
const operation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('replace'), ...common, expectedSha: fileSha,
    oldText: z.string().min(1).max(100_000), newText: z.string().max(100_000) }).strict(),
  z.object({ type: z.literal('append'), ...common, expectedSha: fileSha,
    text: z.string().min(1).max(100_000) }).strict(),
  z.object({ type: z.literal('restore'), ...common, expectedSha: fileSha.nullable(),
    sourceRef: z.string().min(1).max(240) }).strict(),
  z.object({ type: z.literal('create'), ...common, content: z.string().max(1_000_000) }).strict(),
]);
const applyChangesSchema = z.object({
  repository: z.string().min(3).max(200), branch: z.string().min(1).max(240), expectedHeadSha: sha,
  message: z.string().trim().min(1).max(200), agentLabel: agentLabelSchema.default('agent non précisé'),
  operations: z.array(operation).min(1).max(50),
}).strict();

const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
type Op = z.infer<typeof operation>;
type Loaded = { content: string; sha: string } | undefined;

function error(index: number, path: string, code: string, message: string) {
  return { index, path, code, message };
}

export function registerApplyChangesTool(server: McpServer, context: ToolContext): void {
  const coordinator = context.writeCoordinator;
  if (!coordinator) return;
  server.registerTool('github_apply_changes', {
    title: 'Appliquer plusieurs changements de fichiers en un commit',
    _meta: oauthMetadata('mcp:write'), outputSchema: outputSchemas.github_apply_changes,
    description: 'Prévalider puis appliquer en un seul commit atomique un lot ordonné de replace, append, restore et create. Un dépôt, une branche et un expectedHeadSha par lot. Les fichiers nécessaires sont lus au commit immuable attendu, les transformations sont faites en mémoire, puis un seul commitChanges publie le résultat. Une précondition invalide produit zéro mutation. Les outils unitaires restent préférables pour un changement simple.',
    inputSchema: applyChangesSchema.shape, annotations,
  }, async args => {
    try {
      assertWritableBranch(args.branch);
      if (!args.branch.startsWith(coordinator.branchPrefix)) throw new InputValidationError('Cette branche n’appartient pas à l’utilisateur connecté.', 'BRANCH_OWNER_MISMATCH');
      for (const op of args.operations) {
        assertWritablePath(op.path);
        if (SENSITIVE_FILE.test(op.path)) throw new InputValidationError('Fichier sensible interdit.', 'SENSITIVE_FILE');
      }
      const head = await context.reads.branches.getBranchHead(args.repository, args.branch);
      if (head.toLowerCase() !== args.expectedHeadSha) throw new InputValidationError('La branche a changé : relisez les fichiers.', 'HEAD_CHANGED');

      const byPath = new Map<string, Op[]>();
      args.operations.forEach(op => byPath.set(op.path, [...(byPath.get(op.path) ?? []), op]));
      const validationErrors: ReturnType<typeof error>[] = [];
      for (const [path, ops] of byPath) {
        if (ops.some(op => op.type === 'restore') && ops.length > 1) {
          const index = args.operations.findIndex(op => op.path === path && op.type === 'restore');
          validationErrors.push(error(index, path, 'RESTORE_COMBINATION_DENIED', 'restore ne peut pas être combiné avec une autre opération sur le même chemin en v1.'));
        }
        if (ops.some(op => op.type === 'create') && ops.length > 1) {
          const index = args.operations.findIndex(op => op.path === path && op.type === 'create');
          validationErrors.push(error(index, path, 'CREATE_COMBINATION_DENIED', 'create doit être la seule opération sur ce chemin en v1.'));
        }
      }
      if (validationErrors.length) return textPayload({ repository: args.repository, branch: args.branch,
        atomic: true, applied: false, errors: validationErrors });

      const loaded = new Map<string, Loaded>();
      for (const [path, ops] of byPath) {
        const expected = ops[0].type === 'create' ? null : 'expectedSha' in ops[0] ? ops[0].expectedSha : null;
        try {
          const file = await context.reads.files.getTextFile(args.repository, path, args.expectedHeadSha);
          loaded.set(path, { content: file.content, sha: file.sha });
          if (expected === null || file.sha.toLowerCase() !== expected.toLowerCase()) {
            const index = args.operations.findIndex(op => op.path === path);
            validationErrors.push(error(index, path, 'FILE_CHANGED', expected === null ? 'Le fichier existe déjà.' : 'Le fichier a changé depuis sa lecture.'));
          }
        } catch (err) {
          if (err instanceof GitHubApiError && err.status === 404) {
            loaded.set(path, undefined);
            if (expected !== null) {
              const index = args.operations.findIndex(op => op.path === path);
              validationErrors.push(error(index, path, 'FILE_CHANGED', 'Le fichier attendu est absent.'));
            }
          } else throw err;
        }
      }
      if (validationErrors.length) return textPayload({ repository: args.repository, branch: args.branch,
        atomic: true, applied: false, errors: validationErrors });

      const content = new Map<string, string>();
      for (const [path, file] of loaded) if (file) content.set(path, file.content);
      const sourceCache = new Map<string, { sha: string; content: string; blobSha: string }>();
      for (let index = 0; index < args.operations.length; index++) {
        const op = args.operations[index];
        if (op.type === 'replace') {
          const current = content.get(op.path)!;
          const first = current.indexOf(op.oldText);
          if (first < 0) validationErrors.push(error(index, op.path, 'TEXT_NOT_FOUND', 'Le texte attendu est introuvable.'));
          else if (current.indexOf(op.oldText, first + 1) >= 0) validationErrors.push(error(index, op.path, 'TEXT_NOT_UNIQUE', 'Le texte attendu apparaît plusieurs fois.'));
          else if (op.oldText === op.newText) validationErrors.push(error(index, op.path, 'NO_CHANGE', 'Le remplacement ne change pas le fichier.'));
          else content.set(op.path, current.slice(0, first) + op.newText + current.slice(first + op.oldText.length));
        } else if (op.type === 'append') {
          content.set(op.path, content.get(op.path)! + op.text);
        } else if (op.type === 'create') {
          content.set(op.path, op.content);
        } else {
          let source = sourceCache.get(op.sourceRef);
          if (!source) {
            const sourceSha = await resolveCommit(context, args.repository, op.sourceRef);
            const file = await context.reads.files.getTextFile(args.repository, op.path, sourceSha);
            source = { sha: sourceSha, content: file.content, blobSha: file.sha };
            sourceCache.set(op.sourceRef, source);
          }
          if (content.get(op.path) === source.content) validationErrors.push(error(index, op.path, 'NO_CHANGE', 'Le contenu est déjà identique à la source.'));
          else content.set(op.path, source.content);
        }
      }
      if (validationErrors.length) return textPayload({ repository: args.repository, branch: args.branch,
        atomic: true, applied: false, errors: validationErrors });

      const changes = [...content.entries()].map(([path, value]) => {
        const file = loaded.get(path);
        return { path, content: value, ...(file ? { expectedSha: file.sha } : {}) };
      });
      const result = await coordinator.commitChanges({ repository: args.repository, branch: args.branch,
        expectedHeadSha: args.expectedHeadSha, message: args.message, agentLabel: args.agentLabel,
        changes, deletions: [] });
      toolSuccess(context, 'apply_changes');
      return textPayload({ ...result, atomic: true, applied: true, operationCount: args.operations.length, errors: [] });
    } catch (err) {
      return toolFailure(context, 'apply_changes', 'Lot de changements impossible. Relisez la branche et les fichiers avant de réessayer.', err);
    }
  });
}
