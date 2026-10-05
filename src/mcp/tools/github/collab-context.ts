import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { oauthMetadata } from './metadata';
import { outputSchemas } from './output-schemas';
import { textPayload, toolFailure, toolSuccess } from './result';
import { resolveCommit } from './batch';
import { buildCollabContext } from '../../../collab/context';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerCollabContextTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_collab_context', {
    title: 'Contexte de collaboration',
    _meta: oauthMetadata(),
    outputSchema: outputSchemas.github_collab_context,
    description: 'Contexte read-only progressif du workflow de collaboration. Première sortie : cycle, phase, revision, tâche et rôle déclarés, guidance (actions permises, frontière d arrêt, décision owner), blocker et next_action ; puis chemins ciblés et identifiants de sources. Reprise cross-chat par checkpoint portable borné (empreinte par source, jamais un simple lastSeen) : relit les sources modifiées y compris par édition tardive, signale les sources suivies devenues absentes (rescan explicite requis) et expose la continuation des lectures partielles. Exclusion contractuelle des propositions de pairs avant la phase permise ; contamination consignée si déjà lues. Lecture seule, aucun effet de bord. La couverture lue est un fait sur le contenu récupéré, pas une preuve de compréhension.',
    inputSchema: {
      repository: z.string().min(3).max(200),
      ref: z.string().min(1).max(240),
      workflowStatePath: z.string().min(1).max(1024).default('WORKFLOW_STATE.md'),
      participant: z.string().min(1).max(80).optional(),
      taskId: z.string().min(1).max(80).optional(),
      role: z.enum(['owner', 'author', 'reviewer', 'tester', 'assembler', 'consultant']).optional(),
      checkpoint: z.string().min(1).max(20_000).optional(),
      maskingVersion: z.string().min(1).max(80).optional(),
      observedRevision: z.number().int().positive().optional(),
      observedFingerprints: z.array(z.object({ id: z.number().int().positive(), fingerprint: z.string().min(8).max(64) })).max(300).optional(),
    },
    annotations,
  }, async ({ repository, ref, workflowStatePath, participant, taskId, role, checkpoint, maskingVersion, observedRevision, observedFingerprints }) => {
    try {
      const sha = await resolveCommit(context, repository, ref);
      const file = await context.reads.files.getTextFile(repository, workflowStatePath, sha);
      const envelope = buildCollabContext(file.content, {
        scope: { repository, ref, sha, maskingVersion: maskingVersion ?? 'server-raw-v1' },
        participant,
        taskId,
        role,
        checkpoint,
        observedFingerprints,
        observed: observedRevision !== undefined ? { revision: observedRevision } : undefined,
        timestamp: new Date().toISOString(),
      });
      toolSuccess(context, 'collab_context');
      return textPayload({ repository, ref, sha, workflowStatePath, ...envelope });
    } catch (error) {
      return toolFailure(context, 'collab_context', 'Contexte de collaboration indisponible.', error);
    }
  });
}
