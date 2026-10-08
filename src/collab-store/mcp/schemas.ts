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
    // CC-3 C5 : identité dérivée du jeton (I8).
    caller: z.object({ participant_id: z.string(), status: z.enum(['registered', 'unregistered']) }).optional(),
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
  // CC-3 C6 : instantané pour une PR GitHub (lecture seule).
  collab_export: {
    cycle_id: z.string(),
    format: z.enum(['cc-state-1', 'memory-md']),
    content: z.string(),
    content_sha256: z.string(),
    state: z.object({
      revision: z.number(),
      base_revision: z.number(),
      changed: z.boolean(),
      changes: z.object({ phase: z.boolean(), tasks: z.array(z.string()), owner_decisions: z.number(), evidence: z.number() }),
      imported: z.object({
        event_seq: z.number(),
        state_revision: z.number(),
        content_sha256: z.string(),
        target: z.object({ repository: z.string(), path: z.string(), ref: z.string() }).nullable(),
      }),
      store_revision: z.number(),
      last_seq: z.number(),
      snapshot_seq: z.number(),
    }).optional(),
    memory: z.object({ entries: z.number(), scopes: z.array(z.string()) }).optional(),
    publish: z.string(),
  },
};
