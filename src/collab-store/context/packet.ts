import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
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
  memoryOverride?: PacketMemory[];
}

export interface PacketMemory {
  id: string;
  version: number;
  scope: string;
  kind: string;
  text: string;
  confidence: string;
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
  memory: PacketMemory[];
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

/** I6 — empreinte FNV-1a 64 bits du project exact (owner/repo), hex 16 chars. */
function fnv1a64Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/** I6 (review Sol F5) : clé projet collision-résistante, compatible C4 project:[A-Za-z0-9_-]{1,64}. */
export function toProjectScopeKey(project: string | null | undefined): string | null {
  if (!project || !project.trim()) return null;
  const value = project.trim();
  if (/^[A-Za-z0-9_-]{1,64}$/.test(value)) return value;
  const slug = value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 43);
  const key = slug + '-' + fnv1a64Hex(value);
  return key.length <= 64 ? key : key.slice(0, 64);
}

/** I6 — common, participant:<caller>, role:<role>, task:<task>, project:<id C4>. */
export function memoryVisible(
  scope: string,
  ctx: { participantId: string; role?: string | null; taskId?: string | null; project?: string | null },
): boolean {
  if (scope === 'common') return true;
  if (scope.startsWith('participant:')) return scope === 'participant:' + ctx.participantId;
  if (scope.startsWith('role:')) return ctx.role != null && ctx.role.length > 0 && scope === 'role:' + ctx.role;
  if (scope.startsWith('task:')) return ctx.taskId != null && ctx.taskId.length > 0 && scope === 'task:' + ctx.taskId;
  if (scope.startsWith('project:')) {
    const key = toProjectScopeKey(ctx.project);
    return key != null && scope === 'project:' + key;
  }
  return false;
}

async function loadVisibleActiveMemory(
  db: D1Database,
  ctx: { participantId: string; role?: string | null; taskId?: string | null; project?: string | null },
): Promise<PacketMemory[]> {
  await ensureSchema(db);
  const { results } = await db.prepare([
    'SELECT id, version, scope, kind, text, confidence',
    "FROM memory_entries WHERE status = 'active' ORDER BY scope, id, version",
  ].join(' ')).all<PacketMemory>();
  return results.filter(row => memoryVisible(row.scope, ctx));
}

export async function buildRolePacket(
  db: D1Database,
  input: ResolveContextInput,
  options: PacketOptions,
): Promise<RolePacket> {
  await ensureContextSchema(db);
  const resolved = await resolveContextTarget(db, input);
  const cycle = await db.prepare(
    'SELECT cycle_id, phase, revision, status, project FROM cycles WHERE cycle_id = ?1'
  ).bind(resolved.cycle_id).first<{
    cycle_id: string; phase: string; revision: number; status: string; project: string | null;
  }>();
  if (!cycle) throw new CollabStoreError('UNKNOWN_CYCLE', 'Cycle inconnu : ' + resolved.cycle_id);

  const maxTokens = effectiveBudget(options);
  const openQuestions = [...(options.openQuestions ?? [])];
  while (estimateTokens(openQuestions) > OPEN_QUESTIONS_BUDGET && openQuestions.length) openQuestions.pop();

  const visibilityCtx = {
    participantId: input.participant_id,
    role: resolved.task?.participation ?? null,
    taskId: resolved.task?.task_id ?? null,
    project: cycle.project ?? null,
  };
  const allMemory = options.memoryOverride ?? await loadVisibleActiveMemory(db, visibilityCtx);
  const memory: PacketMemory[] = [];
  const excluded: string[] = [];

  const packet: RolePacket = {
    header: {
      cycle_id: cycle.cycle_id,
      phase: cycle.phase,
      revision: cycle.revision,
      status: cycle.status,
      participant_id: input.participant_id,
      last_seen_seq: options.lastSeenSeq ?? 0,
    },
    task: resolved.task,
    role_card: roleCard(resolved.task),
    memory,
    open_questions: openQuestions,
    refs: { items: [...(options.refs ?? [])], complete: false },
    excluded_memory_ids: excluded,
    budget: { max_tokens: maxTokens, estimated_tokens: 0 },
  };

  const ranked = [...allMemory].sort((a, b) => {
    const rank = (k: string) => (k === 'invariant' || k === 'decision' ? 0 : k === 'fact' ? 1 : 2);
    return rank(a.kind) - rank(b.kind) || a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id);
  });
  for (const entry of ranked) {
    memory.push(entry);
    if (estimateTokens({ ...packet, budget: { ...packet.budget, estimated_tokens: 0 } }) > maxTokens) {
      memory.pop();
      excluded.push(entry.id + '@' + entry.version);
    }
  }

  const trim = () => estimateTokens({ ...packet, budget: { ...packet.budget, estimated_tokens: 0 } });
  while (trim() > maxTokens && packet.refs.items.length) packet.refs.items.pop();
  while (trim() > maxTokens && packet.open_questions.length) packet.open_questions.pop();
  while (trim() > maxTokens && packet.memory.length) {
    const dropped = packet.memory.pop()!;
    excluded.push(dropped.id + '@' + dropped.version);
  }
  const estimated = trim();
  if (estimated > maxTokens) {
    throw new CollabStoreError('PACKET_BUDGET_TOO_SMALL', 'Le packet minimal dépasse le budget approuvé.');
  }
  packet.budget.estimated_tokens = estimated;
  packet.excluded_memory_ids = excluded;
  return packet;
}
