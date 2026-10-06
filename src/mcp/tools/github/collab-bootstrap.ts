import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { GitHubApiError } from '../../../github/client';
import { BootstrapError, RECORD_PATH, planBootstrap, validateManifest, type BootstrapManifest, type ExistingFile } from '../../../collab/bootstrap';
import { BOOTSTRAP_MANIFEST, EMBEDDED_TEMPLATES } from '../../../collab/bootstrap-manifest';
import { InputValidationError } from '../../../github/types';
import { mapLimit, resolveCommit } from './batch';
import { oauthMetadata } from './metadata';
import { outputSchemas } from './output-schemas';
import { textPayload, toolFailure, toolSuccess } from './result';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

async function readOptional(context: ToolContext, repository: string, path: string, sha: string): Promise<ExistingFile | undefined> {
  try {
    const file = await context.reads.files.getTextFile(repository, path, sha);
    return { sha: file.sha, content: file.content };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return undefined;
    throw error;
  }
}

async function loadTemplates(context: ToolContext, manifest: BootstrapManifest): Promise<Map<string, string>> {
  const templates = new Map<string, string>();
  await mapLimit(manifest.entries, 3, async entry => {
    if (entry.source.kind === 'embedded') {
      const content = EMBEDDED_TEMPLATES[entry.target];
      if (content !== undefined) templates.set(entry.target, content);
      return;
    }
    // Source de dépôt : lue à un commit complet, jamais à « latest ». L'empreinte est revérifiée par le planificateur.
    const file = await context.reads.files.getTextFile(entry.source.repository, entry.source.path, entry.source.commit);
    templates.set(entry.target, file.content);
  });
  return templates;
}

export function registerCollabBootstrapTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_plan_project_bootstrap', {
    title: 'Prévisualiser l’amorçage de collaboration',
    _meta: oauthMetadata(),
    outputSchema: outputSchemas.github_plan_project_bootstrap,
    description: 'Lecture seule : compare un dépôt à un manifeste de modèles épinglés (AGENTS.md pointeur, AGENT_MEMORY.md, registre d’installation) et renvoie, par fichier, create, unchanged, kept (existant conservé, jamais écrasé) ou action_required (existant incompatible : rien n’est planifié, une décision du propriétaire est nécessaire). Statut ready : appliquer les operations telles quelles avec l’outil d’écriture groupée, s’il est autorisé, sur une branche de travail créée à partir de sha (expectedHeadSha = sha ; un fichier apparu entre-temps ou une branche déplacée fait échouer l’application, relancer la prévisualisation). Un second passage sur un dépôt déjà amorcé renvoie unchanged. Aucune mise à jour automatique des modèles.',
    inputSchema: { repository: z.string(), ref: z.string() },
    annotations,
  }, async ({ repository, ref }) => {
    try {
      const sha = await resolveCommit(context, repository, ref);
      const manifest = validateManifest(BOOTSTRAP_MANIFEST);
      const existing = new Map<string, ExistingFile | undefined>();
      await mapLimit([...manifest.entries.map(entry => entry.target), RECORD_PATH], 3, async path => {
        existing.set(path, await readOptional(context, repository, path, sha));
      });
      const plan = await planBootstrap({ manifest, templates: await loadTemplates(context, manifest), existing });
      const nextAction = {
        ready: 'Create a working branch from sha, then call github_apply_changes with expectedHeadSha=sha and these operations unchanged; rerun this tool to confirm unchanged.',
        unchanged: 'Nothing to create; existing files stay authoritative.',
        action_required: 'No operation planned. Read the entries marked action_required and ask the owner for an explicit, scoped decision; do not create a competing file.',
      }[plan.status];
      toolSuccess(context, 'plan_project_bootstrap');
      return textPayload({ repository, ref, sha, ...plan, nextAction });
    } catch (error) {
      const failure = error instanceof BootstrapError ? new InputValidationError(error.message, error.code) : error;
      return toolFailure(context, 'plan_project_bootstrap', 'Prévisualisation de l’amorçage impossible.', failure);
    }
  });
}
