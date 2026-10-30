/**
 * CC-3 C2/F5 — schémas de sortie (RAW SHAPES : registerTool attend un ZodRawShape,
 * pas un z.object complet).
 */
import { z } from 'zod';

/**
 * Événement public du journal (STORED_EVENT_COLUMNS côté store). Publié strict
 * (additionalProperties: false) : toute sortie passe par toEventOutput().
 */
export const storedEvent = {
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

const packetMemory = {
  id: z.string(),
  version: z.number(),
  scope: z.string(),
  kind: z.string(),
  text: z.string(),
  confidence: z.string(),
};

const capabilitySet = {
  tools: z.array(z.string()).optional(),
  repositories: z.array(z.string()).optional(),
  branch_paths: z.array(z.string()).optional(),
  network_providers: z.array(z.string()).optional(),
  token_ceiling: z.number().optional(),
  cost_ceiling: z.number().optional(),
};

export const outputSchemas = {
  collab_dispatch_task: {
    status: z.enum(['succeeded', 'attempt_failed', 'busy', 'terminal', 'replayed']),
    invocation_id: z.string(),
    state: z.string(),
    replayed: z.boolean(),
    output: z.string().optional(),
    error: z.string().optional(),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), operations: z.number() }),
    provenance: z.array(z.string()),
    latency_ms: z.number(),
  },
  collab_list_executors: {
    executors: z.array(z.object({
      endpoint_id: z.string(), principal_id: z.string(), provider: z.string(), model: z.string(), status: z.string(),
      capability_set: z.object(capabilitySet), token_ceiling: z.number().nullable(),
      quota: z.object({
        calls_limit: z.number(), calls_used: z.number(), calls_remaining: z.number(),
        neurons_limit: z.number().nullable(), neurons_used: z.number().nullable(), neurons_remaining: z.number().nullable(),
      }),
      performance_7d: z.object({
        invocations: z.number(), succeeded: z.number(), failed: z.number(), success_rate: z.number(),
        failures_by_code: z.array(z.object({ code: z.string(), count: z.number() })),
        latency_avg_ms: z.number(), latency_p95_ms: z.number(),
      }),
      owner_notes: z.object({ strengths: z.string(), weaknesses: z.string() }),
    })),
  },
  collab_get_context: {
    cycle_id: z.string(),
    phase: z.string(),
    status: z.string(),
    revision: z.number(),
    tasks: z.array(z.object(contextTask)),
    participant_id: z.string().nullable().optional(),
    caller: z.object({ participant_id: z.string(), status: z.enum(['registered', 'unregistered']) }).optional(),
    resolved: z.object({
      cycle_id: z.string(),
      task: z.object({
        ...contextTask,
        cycle_id: z.string().optional(),
        target_ref: z.string().optional(),
        participation: z.string().optional(),
      }).nullable(),
    }).optional(),
    packet: z.object({
      header: z.object({
        cycle_id: z.string(),
        phase: z.string(),
        revision: z.number(),
        status: z.string(),
        participant_id: z.string(),
        last_seen_seq: z.number(),
      }),
      role_card: z.object({ role: z.string(), duty: z.string() }).nullable(),
      memory: z.array(z.object(packetMemory)),
      open_questions: z.array(z.string()),
      refs: z.object({ items: z.array(z.string()), complete: z.literal(false) }),
      excluded_memory_ids: z.array(z.string()),
      budget: z.object({ max_tokens: z.number(), estimated_tokens: z.number() }),
    }).optional(),
    // CC-7 L3 : continuité chat/API du participant (lecture seule, bornée).
    since_last_visit: z.object({
      last_visit_seq: z.number(),
      last_visit_at: z.number(),
      api_runs: z.array(z.object({
        run_id: z.string(), task_kind: z.string(), status: z.string(), stop_reason: z.string(),
        created_at: z.number(), updated_at: z.number(), summary: z.string(),
      })),
      handovers: z.array(z.object({
        seq: z.number(), at: z.number(), channel: z.enum(['api', 'chat']), done: z.string(), todo: z.string(), learned: z.string(),
      })),
      truncated: z.object({ api_runs: z.boolean(), handovers: z.boolean() }),
    }).optional(),
    delta: z.object({
      events: z.array(z.object(storedEvent)),
      hasMore: z.boolean(),
    }).optional(),
  },
  collab_phase_advance: {
    status: z.enum(['applied', 'duplicate']),
    revision: z.number(),
    event_seq: z.number(),
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
    // CR-B (CR-02) : effet memory_entries d'un événement memory.* applied.
    memory: z.object({ id: z.string(), version: z.number(), status: z.string() }).optional(),
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
  // CC-7 M1b : inventaire mémoire ré-exécutable (lecture seule, correctif revue GPT-6).
  collab_memory_inventory: {
    viewer: z.object({ participant_id: z.string(), status: z.enum(['registered', 'unregistered']) }),
    entries: z.array(z.object({
      id: z.string(), version: z.number(), scope: z.string(), kind: z.string(),
      status: z.string(), confidence: z.string(), token_cost: z.number(),
      author_pid: z.string(), reviewer_pid: z.string(),
      supersedes: z.string().nullable(), expires_rev: z.number().nullable(),
    })),
    has_more: z.boolean(),
    next_cursor: z.string().optional(),
    scopes: z.array(z.object({
      scope: z.string(), family: z.string(), budget: z.number(), tokens_active: z.number(),
      counts: z.object({ candidate: z.number(), active: z.number(), superseded: z.number(), retired: z.number() }),
      baseline: z.number(), occurrences: z.number(), paused: z.boolean(),
      pauses: z.array(z.object({
        occurrence: z.number(), reason: z.string(), request_id: z.string(),
        opened_seq: z.number(), opened_at: z.number(),
        decision: z.string().nullable(), decided_at: z.number().nullable(), open: z.boolean(),
        corrective_events: z.array(z.object({
          seq: z.number(), at: z.number(), type: z.string(), cycle_id: z.string(), id: z.string(),
        })),
        corrective_truncated: z.boolean(),
      })),
    })),
    scopes_truncated: z.boolean(),
  },
  // CC-7 M1b : simulation pure des seuils de pause (aucune lecture du store).
  collab_memory_growth_simulate: {
    rule: z.object({
      growth_alarm_percent: z.number(),
      pause_condition: z.string(),
      resume: z.string(),
    }),
    growth: z.array(z.object({ k: z.number(), pauses: z.array(z.number()) })),
    budget: z.object({
      tokens_used: z.number(), avg_cost: z.number(), budget: z.number(),
      accepted: z.number(), refused: z.number(), tokens_after: z.number(),
    }).optional(),
  },
};
