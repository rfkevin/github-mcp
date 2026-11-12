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

export const outputSchemas = {
  collab_assign_worksession: {
    status: z.enum(['queued', 'scheduled']),
    cycle: z.string(), task: z.string(), participant: z.string(), branch: z.string(),
    scheduled_at: z.number().nullable(), detail: z.string(),
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
      page: z.number().optional(),
      next_page: z.number().nullable().optional(),
    }).optional(),
    // CC-7 L12 : travail en cours du même agent (chat ou API), lecture seule et bornée.
    active_work: z.object({
      last_chat_write: z.object({ seq: z.number(), at: z.number(), type: z.string(), session_id: z.string(), task: z.string().nullable() }).nullable(),
      open_api_runs: z.array(z.object({ run_id: z.string(), task_id: z.string(), task_kind: z.string(), status: z.string(), updated_at: z.number() })),
      last_checkpoints: z.array(z.object({ task: z.string().nullable(), seq: z.number(), at: z.number(), channel: z.enum(['api', 'chat']), summary: z.string() })),
      truncated: z.object({ open_api_runs: z.boolean(), last_checkpoints: z.boolean() }),
      page: z.object({ open_api_runs: z.number(), last_checkpoints: z.number() }).optional(),
      next_page: z.object({ open_api_runs: z.number().nullable(), last_checkpoints: z.number().nullable() }).optional(),
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
    // CC-7 L12 : autre session nommée du même agent sur la même tâche (< 30 min) — avertissement, rien de bloqué.
    concurrent_session: z.object({ other_session_id: z.string(), seq: z.number(), at: z.number(), task: z.string() }).optional(),
    // CC-7 L15 : bail du chat pris (held, jusqu'à held_until) ou rendu (released) par cette écriture sur une tâche.
    chat_lease: z.object({ task: z.string(), action: z.enum(['held', 'released']), held_until: z.number().optional() }).optional(),
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
      scope: z.string(), family: z.string(), budget: z.number().nullable(), tokens_active: z.number(),
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
