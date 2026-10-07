import { CollabStoreError } from '../store/collab-store';
import { ensureContextSchema } from './schema';
import { resolveContextTarget, type ResolveContextInput, type ResolvedTask } from './resolution';

export const DEFAULT_PACKET_BUDGET = 6000;
export const OPEN_QUESTIONS_BUDGET = 300;

export interface PacketOptions {
  c0BaselineTokens: number;
  approvedBudgetTokens?: number;
  lastSeenSeq?: number;
  refs?: string[];
  openQuestions?: string[];
}

export interface RolePacket {
  header: {
    cycle_id: string;
    phase: string;
    revision: number;
    status: string;
    participant_id: string;
    last_seen_seq: number;
  };
  task: ResolvedTask | null;
  role_card: { role: string; duty: string } | null;
  memory: unknown[];
  open_questions: string[];
  refs: { items: string[]; complete: false };
  excluded_memory_ids: string[];
  budget: { max_tokens: number; estimated_tokens: number };
}

function estimateTokens(value: unknown): number {
  return Math.ceil(new TextEncoder().encode(JSON.stringify(value)).byteLength / 4);
}

function roleCard(task: ResolvedTask | null): RolePacket['role_card'] {
  if (!task) return null;
  const duty = task.participation === 'owner'
    ? 'Deliver the task on owned paths; do not self-validate.'
    : task.participation === 'reviewer'
      ? 'Read all changed paths and report blockers or agreement at the exact head.'
      : 'Run independent scenarios and report pass, fail or not_tested.';
  return { role: task.participation, duty };
}

function effectiveBudget(options: PacketOptions): number {
  const quarter = Math.max(1, Math.floor(options.c0BaselineTokens * 0.25));
  if (quarter < 2000 && options.approvedBudgetTokens !== undefined) {
    return Math.min(DEFAULT_PACKET_BUDGET, options.approvedBudgetTokens);
  }
  return Math.min(DEFAULT_PACKET_BUDGET, quarter, options.approvedBudgetTokens ?? Number.MAX_SAFE_INTEGER);
}

export async function buildRolePacket(
  db: D1Database,
  input: ResolveContextInput,
  options: PacketOptions,
): Promise<RolePacket> {
  await ensureContextSchema(db);
  const resolved = await resolveContextTarget(db, input);
  const cycle = await db.prepare(
    'SELECT cycle_id, phase, revision, status FROM cycles WHERE cycle_id = ?1'
  ).bind(resolved.cycle_id).first<{ cycle_id: string; phase: string; revision: number; status: string }>();
  if (!cycle) throw new CollabStoreError('UNKNOWN_CYCLE', 'Cycle inconnu : ' + resolved.cycle_id);

  const maxTokens = effectiveBudget(options);
  const openQuestions = [...(options.openQuestions ?? [])];
  while (estimateTokens(openQuestions) > OPEN_QUESTIONS_BUDGET && openQuestions.length) {
    openQuestions.pop();
  }
  const packet: RolePacket = {
    header: {
      ...cycle,
      participant_id: input.participant_id,
      last_seen_seq: options.lastSeenSeq ?? 0,
    },
    task: resolved.task,
    role_card: roleCard(resolved.task),
    memory: [],
    open_questions: openQuestions,
    refs: { items: [...(options.refs ?? [])], complete: false },
    excluded_memory_ids: [],
    budget: { max_tokens: maxTokens, estimated_tokens: 0 },
  };

  const trim = () => estimateTokens({ ...packet, budget: { ...packet.budget, estimated_tokens: 0 } });
  while (trim() > maxTokens && packet.refs.items.length) packet.refs.items.pop();
  while (trim() > maxTokens && packet.open_questions.length) packet.open_questions.pop();
  const estimated = trim();
  if (estimated > maxTokens) {
    throw new CollabStoreError('PACKET_BUDGET_TOO_SMALL', 'Le packet minimal dépasse le budget approuvé.');
  }
  packet.budget.estimated_tokens = estimated;
  return packet;
}
