import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { mapLimit, resolveCommit } from './batch';
import { printable, publicFailure, textPayload, toolFailure, toolSuccess } from './result';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const guidePaths = ['AGENTS.md', 'README.md', 'package.json', 'docs/agent-roadmap.md', '.mcp/checks.json'];

export function registerProjectTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_read_files', {
    description: 'Lire jusqu’à 10 fichiers ou extraits en un appel, au même commit immuable. Retours partiels, SHA de fichier et numéros de lignes. Budget total borné.',
    inputSchema: {
      repository: z.string(), ref: z.string(),
      files: z.array(z.object({ path: z.string().min(1).max(1024),
        startLine: z.number().int().min(1).max(1_000_000).default(1),
        endLine: z.number().int().min(1).max(1_000_000).optional() })).min(1).max(10),
    }, annotations,
  }, async ({ repository, ref, files }) => {
    try {
      const sha = await resolveCommit(context, repository, ref);
      const budget = Math.floor(60_000 / files.length);
      const results = await mapLimit(files, 3, async ({ path, startLine, endLine }) => {
        if (endLine !== undefined && endLine < startLine) {
          return { path, error: { code: 'INVALID_RANGE', message: 'endLine doit être supérieur ou égal à startLine.', retryable: false } };
        }
        try {
          const file = await context.reads.files.getTextFile(repository, path, sha);
          const lines = file.content ? file.content.split('\n') : [];
          if (file.content.endsWith('\n')) lines.pop();
          const stop = Math.min(endLine ?? startLine + 399, startLine + 399, lines.length);
          const excerpt = lines.slice(startLine - 1, stop).map((line, i) => `${startLine + i}: ${line}`).join('\n');
          const output = printable(excerpt, budget);
          return { path, blobSha: file.sha, size: file.size, totalLines: lines.length,
            startLine, endLine: stop, outOfRange: file.content.length > 0 && startLine > lines.length, ...output,
            truncated: output.truncated || stop < Math.min(endLine ?? lines.length, lines.length),
            // Si un extrait est tronqué en octets, relire une plage plus petite.
            nextStartLine: !output.truncated && stop < lines.length ? stop + 1 : null };
        } catch (error) {
          return { path, error: publicFailure(error, 'Lecture de ce fichier impossible.') };
        }
      });
      toolSuccess(context, 'read_files');
      return textPayload({ repository, ref, sha, partial: results.some(result => 'error' in result), files: results });
    } catch (error) {
      return toolFailure(context, 'read_files', 'Lecture groupée impossible.', error);
    }
  });

  server.registerTool('github_get_project_context', {
    description: 'En un appel : dépôt, branche par défaut, commit exact, dossiers racine, règles, README et commandes. Les permissions manquantes restent visibles.',
    inputSchema: { repository: z.string(), ref: z.string().optional() }, annotations,
  }, async ({ repository, ref }) => {
    try {
      const metadata = await context.github.repositories.getRepository(repository);
      const requestedRef = ref ?? metadata.default_branch;
      const capabilities = { mutationsExposed: Boolean(context.automationCoordinator || context.checkCoordinator || context.writeCoordinator), checkDispatchEnabled: Boolean(context.automationCoordinator || context.checkCoordinator),
        managedProjectChecks: Boolean(context.automationCoordinator), checkPlanPath: '.mcp/checks.json',
        workflowPreparation: context.automationCoordinator ? 'github_prepare_checks; apply requires mcp:write' : 'disabled',
        codeWritesEnabled: Boolean(context.writeCoordinator), workingBranchPrefix: context.writeCoordinator?.branchPrefix,
        arbitraryShell: false, productionDeployment: false,
        projectCommandsOnGitHubActions: Boolean(context.automationCoordinator),
        requiredPermissions: { files: 'contents:read', checks: 'checks:read', workflows: 'actions:read', statuses: 'statuses:read',
          pullRequests: context.writeCoordinator ? 'pull_requests:write' : 'pull_requests:read',
          ...(context.writeCoordinator ? { codeWrites: 'contents:write' } : {}) },
        permissionsNote: 'Les droits indiqués sont nécessaires, pas une confirmation de leur attribution.' };
      let sha: string;
      try {
        sha = await resolveCommit(context, repository, requestedRef);
      } catch (error) {
        return textPayload({ repository, defaultBranch: metadata.default_branch, ref: requestedRef, partial: true,
          capabilities, error: publicFailure(error, 'Le contexte des fichiers est inaccessible.') });
      }
      const [tree, documents] = await Promise.all([
        context.reads.files.getRepositoryTree(repository, sha, false)
          .then(value => ({ entries: value.entries.slice(0, 100), truncated: value.truncated || value.entries.length > 100 }))
          .catch(error => ({ error: publicFailure(error) })),
        mapLimit(guidePaths, 3, async path => {
          try {
            const file = await context.reads.files.getTextFile(repository, path, sha);
            return { path, blobSha: file.sha, ...printable(file.content, 12_000) };
          } catch (error) {
            return { path, error: publicFailure(error) };
          }
        }),
      ]);
      toolSuccess(context, 'get_project_context');
      return textPayload({ repository, defaultBranch: metadata.default_branch, ref: requestedRef, sha,
        partial: 'error' in tree || documents.some(document => 'error' in document), tree, documents, capabilities });
    } catch (error) {
      return toolFailure(context, 'get_project_context', 'Impossible de lire le contexte du projet.', error);
    }
  });
}
