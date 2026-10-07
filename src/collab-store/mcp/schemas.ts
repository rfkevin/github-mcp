/**
 * CC-3 C2 — schémas de sortie (RAW SHAPES : registerTool attend un ZodRawShape,
 * pas un z.object complet).
 */
import { z } from 'zod';

const storedEvent = {
  seq: z.number(),
  cycle_id: z.string(),
  at: z.number(),
  type: z.string(),
  participant_id: z.string(),
  session_id: z.string(),
  role: z.string(),
  payload_json: z.string(),
  expected_rev: z.number(),
  idempotency_key: z.string(),
  evidence_ref: z.string(),
};

const contextTask = {
  task_id: z.string(),
  owner_pid: z.string(),
  reviewer_pid: z.string(),
  tester_pid: z.string(),
  status: z.string(),
  owned_paths: z.string(),
  next_action: z.string(),
  revision: z.number(),
};

export const outputSchemas = {
  collab_get_context: {
    cycle_id: z.string(),
    phase: z.string(),
    status: z.string(),
    revision: z.number(),
    tasks: z.array(z.object(contextTask)),
    participant_id: z.string().nullable().optional(),
  },
  collab_get_delta: {
    cycle_id: z.string(),
    events: z.array(z.object(storedEvent)),
    hasMore: z.boolean(),
  },
  collab_append_event: {
    status: z.enum(['applied', 'duplicate']),
    revision: z.number().optional(),
    event: z.object(storedEvent).optional(),
  },
};
