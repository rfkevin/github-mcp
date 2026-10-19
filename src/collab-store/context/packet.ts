import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { ensureContextSchema } from './schema';
import { resolveContextTarget, type ResolveContextInput, type ResolvedTask } from './resolution';
import { toProjectScopeKey } from '../contracts/memory';
import { equivalentParticipantIds } from '../identity/families';

// X2/X5 : toProjectScopeKey vit dans contracts/memory.ts (définition canonique,
// partagée avec memory-store.ts) ; re-exportée ici pour la compatibilité de l'API.
export { toProjectScopeKey };

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

/** I6 — common, participant:<caller>, role:<role>, task:<task>, project:<id C4>. */
export function memoryVisible(
  scope: string,
  ctx: { participantId: string; participantIds?: ReadonlySet<string>; role?: string | null; taskId?: string | null; project?: string | null },
): boolean {
  if (scope === 'common') return true;
  if (scope.startsWith('participant:')) {
    const owner = scope.slice('participant:'.length);
    return ctx.participantIds?.has(owner) ?? owner === ctx.participantId;
  }
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
  ctx: { participantId: string; participantIds?: ReadonlySet<string>; role?: string | null; taskId?: string | null; project?: string | null },
): Promise<PacketMemory[]> {
  await ensureSchema(db);
  const { results } = await db.prepare([
    'SELECT id, version, scope, kind, text, confidence',
    "FROM memory_entries WHERE status = 'active' ORDER BY scope, id, version",
  ].join(' ')).all<PacketMemory>();
  return results.filter(row => memoryVisible(row.scope, ctx));
}

// CC-5 L2 : questions ouvertes du journal — clarify.ask sans clarify.answer lié
// (payload $.ask_seq). Borné à 50, seq croissant, question tronquée à 400.
// X13 (review Claude R2) : une question adressée (payload $.to = participant,
// ou rôle owner/reviewer/tester avec $.task) n'est rendue qu'à son auteur et
// à son destinataire — le titulaire du rôle sur la tâche citée. Sans $.to ou
// sans viewer, comportement inchangé (question publique).
export const CLARIFY_ROLES = ['owner', 'reviewer', 'tester'] as const;

export interface OpenQuestionViewer {
  /** Identités logiques équivalentes du lecteur (familles #126 comprises). */
  participantIds: ReadonlySet<string>;
}

export function clarifyVisible(
  row: { participant_id: string; payload_json: string },
  viewer: OpenQuestionViewer,
  taskRoles: ReadonlyMap<string, { owner_pid: string; reviewer_pid: string; tester_pid: string }>,
): boolean {
  if (viewer.participantIds.has(row.participant_id)) return true; // l'auteur
  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    return true; // payload illisible : question publique
  }
  const to = payload?.to;
  if (typeof to !== 'string' || !to) return true; // sans adressage : tous
  if ((CLARIFY_ROLES as readonly string[]).includes(to)) {
    const task = payload?.task;
    if (typeof task !== 'string' || !task) return false; // rôle sans tâche : auteur seul
    const roles = taskRoles.get(task);
    if (!roles) return false; // tâche inconnue : auteur seul
    const holder = to === 'owner' ? roles.owner_pid : to === 'reviewer' ? roles.reviewer_pid : roles.tester_pid;
    return viewer.participantIds.has(holder);
  }
  return viewer.participantIds.has(to); // participant
}

export async function loadOpenQuestions(db: D1Database, cycleId: string, viewer?: OpenQuestionViewer): Promise<string[]> {
  await ensureSchema(db);
  const { results } = await db.prepare([
    'SELECT a.seq, a.participant_id, a.payload_json',
    "FROM events a WHERE a.cycle_id = ?1 AND a.type = 'clarify.ask'",
    "AND NOT EXISTS (SELECT 1 FROM events r WHERE r.cycle_id = a.cycle_id AND r.type = 'clarify.answer'",
    "AND json_extract(r.payload_json, '$.ask_seq') = a.seq)",
    'ORDER BY a.seq LIMIT 50',
  ].join(' ')).bind(cycleId).all<{ seq: number; participant_id: string; payload_json: string }>();
  if (!viewer) return results.map(formatOpenQuestion);
  // X13 : les adressages par rôle se résolvent sur les tâches du cycle.
  const roleAddressed = results.some(row => {
    try {
      const to = (JSON.parse(row.payload_json) as { to?: unknown })?.to;
      return typeof to === 'string' && (CLARIFY_ROLES as readonly string[]).includes(to);
    } catch {
      return false;
    }
  });
  let taskRoles = new Map<string, { owner_pid: string; reviewer_pid: string; tester_pid: string }>();
  if (roleAddressed) {
    const tasks = await db.prepare('SELECT task_id, owner_pid, reviewer_pid, tester_pid FROM tasks WHERE cycle_id = ?1')
      .bind(cycleId).all<{ task_id: string; owner_pid: string; reviewer_pid: string; tester_pid: string }>();
    taskRoles = new Map(tasks.results.map(task => [task.task_id, task]));
  }
  return results.filter(row => clarifyVisible(row, viewer, taskRoles)).map(formatOpenQuestion);
}

function formatOpenQuestion(row: { seq: number; participant_id: string; payload_json: string }): string {
  let question = '';
  try {
    question = String((JSON.parse(row.payload_json) as { question?: unknown }).question ?? '');
  } catch {
    question = '';
  }
  return '#' + row.seq + ' (' + row.participant_id + ') ' + question.slice(0, 400);
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
  const equivalents = await equivalentParticipantIds(db, input.participant_id);
  // CC-5 L2 : questions ouvertes du journal en tête — elles survivent au trim.
  // X13 (review Claude R2) : une question adressée n'est rendue qu'à son
  // auteur et à son destinataire, le rôle se résout sur la tâche citée.
  const journalQuestions = await loadOpenQuestions(db, resolved.cycle_id, { participantIds: new Set(equivalents) });
  const openQuestions = [...journalQuestions, ...(options.openQuestions ?? [])];
  while (estimateTokens(openQuestions) > OPEN_QUESTIONS_BUDGET && openQuestions.length) openQuestions.pop();

  const visibilityCtx = {
    participantId: input.participant_id,
    participantIds: new Set(equivalents),
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
