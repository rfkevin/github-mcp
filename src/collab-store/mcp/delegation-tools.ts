import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CollabToolContext } from './context';
import { collabFailure } from './result';
import { bindDelegatedRequest } from '../owner/delegation-binding';
import { DelegationDenied } from '../owner/delegation-policy';

/** Only cycle and request_id are client-supplied. Fail-closed until fixed dispatch exists. */
export function registerDelegationTools(server: McpServer, context: CollabToolContext): void {
  server.registerTool('collab_delegate_owner', {
    title: 'Exécuter une demande owner déléguée (CC-5)',
    description: 'Mandat owner actif et quatre yeux requis. Identité du coordinateur issue du jeton OAuth. Sans dispatcher autorisé, aucune mutation.',
    inputSchema: { cycle: z.string().min(1).max(64), request_id: z.string().min(1).max(64) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      const identity = await context.identity();
      if (identity.status !== 'registered') throw new DelegationDenied('registered_coordinator_required');
      const bound = await bindDelegatedRequest(context.db, input, identity.participant_id);
      throw new DelegationDenied('executor_not_yet_wired:' + bound.action);
    } catch (error) {
      return collabFailure(error, 'Exécution déléguée refusée.');
    }
  });
}
