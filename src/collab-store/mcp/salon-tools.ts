/**
 * CC-7 L4 — outils MCP du salon d’équipe.
 * Identité depuis le jeton serveur uniquement. Porte SALON_ENABLED.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CollabToolContext } from './context';
import { collabFailure } from './result';
import { CollabStoreError } from '../store/collab-store';
import {
  postSalonMessage,
  listSalonMessages,
  pendingSalonWakes,
  ackSalonWake,
  SalonError,
  type SalonLevel,
} from '../salon';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

async function registered(context: CollabToolContext, tool: string): Promise<string> {
  const identity = await context.identity();
  if (identity.status !== 'registered') {
    throw new CollabStoreError('UNREGISTERED_CLIENT', tool + ' : client non associé à un participant enregistré.');
  }
  return identity.participant_id;
}

function mapSalonError(error: unknown): never {
  if (error instanceof SalonError) {
    throw new CollabStoreError(error.code, error.message);
  }
  throw error;
}

export function registerSalonTools(server: McpServer, context: CollabToolContext): void {
  server.registerTool('collab_salon_post', {
    title: 'Publier au salon d’équipe (CC-7 L4)',
    description: 'Message au cycle permanent team-salon. level info|decision|blocking. blocking exige task. Quota 3 decision/blocking/jour ; blocking+new_fact jamais perdu (S7). Porte SALON_ENABLED.',
    inputSchema: {
      level: z.enum(['info', 'decision', 'blocking']),
      body: z.string().min(1).max(2000),
      task: z.string().max(64).optional(),
      incident_key: z.string().max(128).optional(),
      new_fact: z.boolean().optional(),
      wake: z.array(z.string().min(1).max(128)).max(20).optional(),
    },
    annotations: WRITE,
  }, async (input) => {
    try {
      const authorPid = await registered(context, 'collab_salon_post');
      const now = Math.floor(Date.now() / 1000);
      const result = await postSalonMessage(context.db, { SALON_ENABLED: context.flags.salonEnabled ? 'true' : undefined }, {
        authorPid,
        level: input.level as SalonLevel,
        body: input.body,
        taskId: input.task,
        incidentKey: input.incident_key,
        newFact: input.new_fact,
        now,
        wakeParticipants: input.wake,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      try { mapSalonError(error); } catch (mapped) {
        return collabFailure(mapped, 'Publication salon impossible.', {}, context.fallback);
      }
    }
  });

  server.registerTool('collab_salon_list', {
    title: 'Lire le salon d’équipe (CC-7 L4)',
    description: 'Lecture seule des messages non masqués, bornée (défaut 40, max 100).',
    inputSchema: {
      since_at: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      await registered(context, 'collab_salon_list');
      const messages = await listSalonMessages(context.db, { sinceAt: input.since_at, limit: input.limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ messages }) }] };
    } catch (error) {
      return collabFailure(error, 'Lecture salon impossible.', {}, context.fallback);
    }
  });

  server.registerTool('collab_salon_pending_wakes', {
    title: 'Réveils salon en attente (CC-7 L4)',
    description: 'Messages du salon non encore acquittés pour VOTRE participant.',
    inputSchema: {
      limit: z.number().int().min(1).max(40).optional(),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const pid = await registered(context, 'collab_salon_pending_wakes');
      const wakes = await pendingSalonWakes(context.db, pid, input.limit);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ wakes }) }] };
    } catch (error) {
      return collabFailure(error, 'Réveils salon impossibles.', {}, context.fallback);
    }
  });

  server.registerTool('collab_salon_ack_wake', {
    title: 'Acquitter un réveil salon (CC-7 L4)',
    description: 'Marque livré le réveil (msg_id) pour VOTRE participant. Idempotent.',
    inputSchema: {
      msg_id: z.string().min(1).max(200),
    },
    annotations: WRITE,
  }, async (input) => {
    try {
      const pid = await registered(context, 'collab_salon_ack_wake');
      const now = Math.floor(Date.now() / 1000);
      const result = await ackSalonWake(context.db, input.msg_id, pid, now);
      if (!result.ok) {
        throw new CollabStoreError('SALON_WAKE_UNKNOWN', 'Réveil inconnu pour ce participant.');
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return collabFailure(error, 'Acquittement réveil impossible.', {}, context.fallback);
    }
  });
}
