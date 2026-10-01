import type { McpServer } from '@modelcontextprotocol/server';
import { outputSchemas } from './output-schemas';
import { z } from 'zod';
import { checkScopes } from '../../../checks/config';
import { prepareSchema, runSchema } from '../../../automation/coordinator';
import type { ToolContext } from '../../context';
import { textPayload, toolFailure, toolSuccess } from './result';

export function registerCheckTools(server: McpServer, context: ToolContext): void {
  if (!context.automationCoordinator && !context.checkCoordinator) return;
  const requestSchema = context.automationCoordinator ? runSchema.shape : {
    repository: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/i),
    scope: z.enum(checkScopes).default('quick'), target: z.string().max(240).default(''),
  };
  server.registerTool('github_run_checks', {
    title: 'Lancer les vérifications autorisées',
    outputSchema: outputSchemas.github_run_checks,
    description: context.automationCoordinator
      ? 'Vérifier un dépôt et une branche (ref) ou SHA exact avec .mcp/checks.json. Réutilise les runs push quick ; lancement manuel si mcp-checks.yml est installé sur la branche par défaut. Retour immédiat : conserver sha, scope, target et runId. Exécute les commandes du projet sur GitHub Actions et peut consommer des minutes.'
      : 'Lancer uniquement agent-checks sur un commit exact. Retour immédiat avec runId ; réutilisation des exécutions identiques si visibles. Peut consommer des minutes GitHub Actions.',
    inputSchema: requestSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (request: z.output<typeof runSchema>) => {
    try {
      const result = context.automationCoordinator ? await context.automationCoordinator.start(request)
        : await context.checkCoordinator!.start({ ...request, sha: request.sha!, scope: z.enum(checkScopes).parse(request.scope) });
      toolSuccess(context, 'run_checks');
      return textPayload(result);
    } catch (error) {
      return toolFailure(context, 'run_checks', 'Impossible de lancer ces vérifications.', error);
    }
  });
  server.registerTool('github_get_agent_check_result', {
    title: 'Lire le résultat des vérifications de l’agent',
    outputSchema: outputSchemas.github_get_agent_check_result,
    description: 'Résultat corrélé de run_checks : vérifie le contrôleur, le commit testé, les paramètres et l’étape réellement exécutée. Ne confond pas le commit du workflow avec la cible.',
    inputSchema: { ...requestSchema, sha: z.string().regex(/^[a-f0-9]{40}$/i), runId: z.number().int().positive() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ runId, ...request }: z.output<typeof runSchema> & { sha: string; runId: number }) => {
    try {
      const result = context.automationCoordinator ? await context.automationCoordinator.result(request, runId)
        : await context.checkCoordinator!.result({ ...request, scope: z.enum(checkScopes).parse(request.scope) }, runId);
      toolSuccess(context, 'get_agent_check_result');
      return textPayload(result);
    } catch (error) {
      return toolFailure(context, 'get_agent_check_result', 'Impossible de vérifier cette exécution.', error);
    }
  });
  if (context.automationCoordinator) server.registerTool('github_prepare_checks', {
    title: 'Préparer les vérifications du projet',
    outputSchema: outputSchemas.github_prepare_checks,
    description: 'Préparer les vérifications du dépôt : workflow mcp-checks.yml encadré et plan .mcp/checks.json. Fournir les vraies commandes après lecture du projet. apply=false prévisualise ; apply=true crée un commit atomique sur votre branche et peut démarrer quick au push. Application réservée au consentement mcp:write. Les workflows existants restent protégés.',
    inputSchema: prepareSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async request => {
    try {
      const result = await context.automationCoordinator!.prepare(request);
      toolSuccess(context, 'prepare_checks');
      return textPayload(result);
    } catch (error) {
      return toolFailure(context, 'prepare_checks', 'Impossible de préparer les vérifications.', error);
    }
  });
}
