import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { checkScopes } from '../../../checks/config';
import type { ToolContext } from '../../context';
import { textPayload, toolFailure, toolSuccess } from './result';

export function registerCheckTools(server: McpServer, context: ToolContext): void {
  const coordinator = context.checkCoordinator;
  if (!coordinator) return;
  const requestSchema = {
    repository: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/i),
    scope: z.enum(checkScopes).default('quick'), target: z.string().max(240).default(''),
  };
  server.registerTool('github_run_checks', {
    description: 'Lancer uniquement agent-checks sur un commit exact. Retour immédiat avec runId ; réutilisation des exécutions identiques si visibles. Ne lance ni déploiement ni shell arbitraire. Peut consommer des minutes GitHub Actions.',
    inputSchema: requestSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async request => {
    try {
      const result = await coordinator.start(request);
      toolSuccess(context, 'run_checks');
      return textPayload(result);
    } catch (error) {
      return toolFailure(context, 'run_checks', 'Impossible de lancer ces vérifications.', error);
    }
  });
  server.registerTool('github_get_agent_check_result', {
    description: 'Résultat corrélé de run_checks : vérifie le contrôleur, le commit testé, les paramètres et l’étape réellement exécutée. Ne confond pas le commit du workflow avec la cible.',
    inputSchema: { ...requestSchema, runId: z.number().int().positive() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ runId, ...request }) => {
    try {
      const result = await coordinator.result(request, runId);
      toolSuccess(context, 'get_agent_check_result');
      return textPayload(result);
    } catch (error) {
      return toolFailure(context, 'get_agent_check_result', 'Impossible de vérifier cette exécution.', error);
    }
  });
}
