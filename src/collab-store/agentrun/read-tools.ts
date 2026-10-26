/**
 * CC-5 l7 (incrément 7c-1) — hôte d'outils en LECTURE SEULE pour les exécutions API.
 *
 * Allowlist deny-by-default figée en code (amendement A2, plan seq 719) : chaque
 * type de tâche n'a que les outils listés dans READ_TOOLS_BY_KIND ; aucun outil
 * d'écriture (effect 'read' partout), donc aucun effet externe en 7c-1. Le
 * moteur refuse en plus API_AGENT_FORBIDDEN et tronque chaque résultat
 * (RESULT_MAX_CHARS) avant de le rendre au modèle comme donnée.
 *
 * CC-7 L5a (S9) : github_diff donne aux types `review` et `test` le couple
 * head/base exact de la soumission (head = SHA de 40 caractères, base = SHA ou
 * branche), avec bornage des fichiers et des patchs rendus au modèle.
 *
 * CC-7 L5b (S10) : store_verdict dépose le verdict D12 d'une relecture ou d'un
 * test APRÈS re-vérification serveur (verdict-tools.ts) ; chaque lecture GitHub
 * réussie est journalée dans agent_run_reads (preuve au SHA exact).
 *
 * Le participant et le cycle d'un appel sont relus dans agent_runs à partir
 * du run_id fourni par le moteur, jamais pris dans les arguments du modèle :
 * une exécution ne lit que le contexte de SON participant (masquage CR-C du
 * store, redactEventsFor) et que le dépôt autorisé par l'hôte.
 */
import { CollabStore } from '../store/collab-store';
import { equivalentParticipantIds } from '../identity/families';
import { loadContinuity, loadVisibleActiveMemory } from '../context';
import { ToolRefused, type LookupResult, type ToolCall, type ToolHost, type ToolSpec } from './engine';
import type { ToolSchema } from './workers-ai-model';
import { createStoreWriteTools, WRITE_TOOL_SCHEMAS, type WriteToolName } from './store-tools';
import { createGitHubWriteTools, GITHUB_WRITE_TOOL_SCHEMAS, type GitHubWrites, type GitHubWriteToolName } from './github-tools';
import { sha256Hex } from '../store/hash';
import { createVerdictTools, VERDICT_TOOL_SCHEMAS } from './verdict-tools';

/** Lectures GitHub utilisées par l'hôte (sous-ensemble des clients existants, lecture seule). */
export interface GitHubReads {
  getTextFile(repository: string, path: string, ref: string): Promise<{ path: string; sha: string; content: string; size: number }>;
  getPullRequest(repository: string, pullNumber: number): Promise<unknown>;
  listCheckRuns(repository: string, ref: string): Promise<unknown[]>;
  /** CC-7 L5a : diff entre une base et un head exact (compare du client, lecture seule). */
  compareRefs(repository: string, base: string, head: string): Promise<unknown>;
}

/** CC-7 L5a : bornes du diff rendu au modèle (fichiers et patchs, S9). */
export const DIFF_MAX_FILES = 50;
export const DIFF_PATCH_CHARS = 2000;

export const READ_TOOL_SCHEMAS: readonly ToolSchema[] = Object.freeze([
  { name: 'store_context', description: 'Contexte du cycle de cette exécution : phase, révision et tâches où votre participant a un rôle.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'store_delta', description: 'Événements du cycle après since_seq (au plus 50), masqués selon votre participant.',
    parameters: { type: 'object', properties: { since_seq: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
      required: ['since_seq'], additionalProperties: false } },
  { name: 'github_read_file', description: 'Lire un fichier texte du dépôt autorisé à une référence (branche ou SHA).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, ref: { type: 'string' } }, required: ['path', 'ref'], additionalProperties: false } },
  { name: 'github_pull_request', description: 'Lire une PR du dépôt autorisé (titre, état, head et base).',
    parameters: { type: 'object', properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'], additionalProperties: false } },
  { name: 'github_check_runs', description: 'Contrôles CI d’un commit exact (SHA de 40 caractères) du dépôt autorisé.',
    parameters: { type: 'object', properties: { sha: { type: 'string' } }, required: ['sha'], additionalProperties: false } },
  { name: 'github_diff', description: 'Diff entre une base (SHA ou branche) et un head exact (SHA de 40 caractères) du dépôt autorisé : fichiers, statuts et patchs bornés.',
    parameters: { type: 'object', properties: { base: { type: 'string' }, head: { type: 'string', pattern: '^[a-f0-9]{40}$' } },
      required: ['base', 'head'], additionalProperties: false } },
]);

export type ReadToolName = 'store_context' | 'store_delta' | 'github_read_file' | 'github_pull_request' | 'github_check_runs' | 'github_diff';

/**
 * CC-7 L3 (incrément 1) : lectures de continuité, ajoutées à TOUS les types de tâche quand l'hôte est créé avec
 * `continuity: true` (porte AGENT_RUN_CONTINUITY, éteinte par défaut). Mêmes données que le chat (parité S1, S4) :
 * mémoire C4 visible du participant et « depuis ta dernière visite » (notes de passation, exécutions précédentes).
 */
export const CONTINUITY_TOOL_SCHEMAS: readonly ToolSchema[] = Object.freeze([
  { name: 'store_memory', description: 'Mémoire C4 active visible par votre participant (scopes partagés et votre scope personnel), au plus 40 entrées.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'store_continuity', description: 'Continuité de votre participant : dernière visite du chat, ses notes de passation et vos exécutions API précédentes avec leur message final.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } },
]);
export type ContinuityToolName = 'store_memory' | 'store_continuity';
const CONTINUITY_TOOLS: readonly ContinuityToolName[] = ['store_memory', 'store_continuity'];
export const CONTINUITY_MEMORY_LIMIT = 40;
/** Registre complet des tâches rendu par store_context en mode continuité (écarts E1-E3 de l8). */
export const REGISTRY_MAX_TASKS = 60;

/** Allowlist par type de tâche, figée en code ; un type inconnu n'a aucun outil. */
export const READ_TOOLS_BY_KIND: Readonly<Record<string, readonly ReadToolName[]>> = Object.freeze({
  research: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs'],
  // 7c-2 : réponse à une question adressée (créée par le contrôleur, plan.ts).
  answer: ['store_context', 'store_delta'],
  planning: ['store_context', 'store_delta', 'github_read_file'],
  status: ['store_context', 'store_delta', 'github_check_runs'],
  // 7c-3 : implémentation sur la branche de l'agent (écritures GitHub de github-tools.ts).
  implement: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs'],
  // CC-7 L5a (S9) : réveils de relecture et de test — lecture du couple head/base exact.
  review: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs', 'github_diff'],
  test: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs', 'github_diff'],
});

const SHA_RE = /^[a-f0-9]{40}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * CC-7 L5b (S10) : journalise une lecture GitHub réussie de l'exécution dans
 * agent_run_reads (INSERT OR IGNORE, empreinte (run_id, tool, ref_sha)) — la
 * preuve de lecture au SHA exact exigée par store_verdict (contrôle ⑦).
 */
async function journalRead(db: D1Database, runId: string, tool: string, refSha: string): Promise<void> {
  const effectKey = await sha256Hex([runId, tool, refSha].join('\u001f'));
  await db.prepare("INSERT OR IGNORE INTO agent_run_reads (effect_key, run_id, tool, ref_sha, status, at) VALUES (?1, ?2, ?3, ?4, 'completed', ?5)")
    .bind(effectKey, runId, tool, refSha, Math.floor(Date.now() / 1000)).run();
}

export interface ReadToolHostOptions {
  db: D1Database;
  /** Unique dépôt lisible par l'exécution (ex. rfkevin/github-mcp) ; null = aucun outil GitHub. */
  repository: string | null;
  github: GitHubReads | null;
  /** 7c-2 : ajoute les écritures store de WRITE_TOOLS_BY_KIND (clarify, task.status non-verdict). Absent = lecture seule. */
  storeWrites?: boolean;
  /**
   * 7c-3 : écritures GitHub (type `implement` seulement) sur la branche API du participant ;
   * exigent aussi `repository`. Absent = aucune écriture GitHub.
   */
  githubWrites?: { writes: GitHubWrites; baseBranch: string } | null;
  /** CC-7 L3 : lectures de continuité (store_memory, store_continuity) et registre complet dans store_context. Absent = inchangé. */
  continuity?: boolean;
  /** CC-7 L5b (S10) : store_verdict (verdicts contrôlés serveur) pour les kinds review et test ; absent = aucun verdict. */
  verdicts?: boolean;
}

interface RunScope { cycle_id: string; participant_id: string }

function intArg(args: Record<string, unknown>, name: string, min: number, max: number, fallback?: number): number {
  const value = args[name] ?? fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ToolRefused(name + ' : entier entre ' + min + ' et ' + max + ' requis.');
  }
  return value;
}

function stringArg(args: Record<string, unknown>, name: string, pattern: RegExp): string {
  const value = args[name];
  if (typeof value !== 'string' || !pattern.test(value)) throw new ToolRefused(name + ' invalide.');
  return value;
}

export function createReadToolHost(options: ReadToolHostOptions): ToolHost & { schemas(taskKind: string): ToolSchema[] } {
  const writes = options.storeWrites ? createStoreWriteTools(options.db) : null;
  const gh = options.githubWrites && options.repository !== null
    ? createGitHubWriteTools({ db: options.db, repository: options.repository, writes: options.githubWrites.writes, baseBranch: options.githubWrites.baseBranch })
    : null;
  // CC-7 L5b (S10) : store_verdict, seulement avec un dépôt ET des lectures GitHub.
  const verdicts = options.verdicts && options.repository !== null && options.github !== null
    ? createVerdictTools({ db: options.db, repository: options.repository, github: options.github })
    : null;
  // CC-7 L3 (incrément 2) : proposition de mémoire, seulement avec écritures store ET continuité, types connus.
  const memoryWrite = (taskKind: string): readonly WriteToolName[] =>
    writes && options.continuity && Object.prototype.hasOwnProperty.call(READ_TOOLS_BY_KIND, taskKind) ? ['store_memory_propose'] : [];
  const writeNames = (taskKind: string): readonly (WriteToolName | GitHubWriteToolName | 'store_verdict')[] =>
    [...(writes ? writes.names(taskKind) : []), ...memoryWrite(taskKind), ...(gh ? gh.names(taskKind) : []),
      ...(verdicts && (taskKind === 'review' || taskKind === 'test') ? ['store_verdict' as const] : [])];
  const isGitHubWrite = (name: string) => GITHUB_WRITE_TOOL_SCHEMAS.some(schema => schema.name === name);
  const allowed = (taskKind: string): readonly ReadToolName[] => {
    const tools = Object.prototype.hasOwnProperty.call(READ_TOOLS_BY_KIND, taskKind) ? READ_TOOLS_BY_KIND[taskKind] : [];
    // Sans dépôt ou client GitHub, les outils GitHub ne sont pas proposés du tout.
    return tools.filter(name => !name.startsWith('github_') || (options.repository !== null && options.github !== null));
  };
  // Un type inconnu n'a aucun outil, même en continuité (deny-by-default).
  const continuityNames = (taskKind: string): readonly ContinuityToolName[] =>
    options.continuity && Object.prototype.hasOwnProperty.call(READ_TOOLS_BY_KIND, taskKind) ? CONTINUITY_TOOLS : [];
  const readNames = (taskKind: string): readonly string[] => [...allowed(taskKind), ...continuityNames(taskKind)];
  async function scope(runId: string): Promise<RunScope> {
    const run = await options.db.prepare('SELECT cycle_id, participant_id FROM agent_runs WHERE run_id = ?1').bind(runId).first<RunScope>();
    if (!run) throw new ToolRefused('unknown_run');
    return run;
  }
  async function execute(call: ToolCall, ctx: { run_id: string; effect_key?: string }): Promise<unknown> {
    if (writes && (WRITE_TOOL_SCHEMAS.some(schema => schema.name === call.name))) return writes.execute(call, ctx);
    if (gh && isGitHubWrite(call.name)) return gh.execute(call, ctx);
    // CC-7 L5b (S10) : verdict contrôlé serveur (rôle, identité, couple, CI, preuve).
    if (verdicts && call.name === 'store_verdict') return verdicts.execute(call, ctx);
    const { cycle_id, participant_id } = await scope(ctx.run_id);
    const args = call.args ?? {};
    const store = new CollabStore(options.db);
    switch (call.name as ReadToolName) {
      case 'store_context': {
        const mine = await store.getContext(cycle_id, participant_id);
        if (!options.continuity) return mine;
        // E1-E3 (l8) : le registre complet du cycle, en lecture, pas seulement les tâches où l'on a un rôle.
        const all = await store.getContext(cycle_id);
        const registry = all.tasks.slice(0, REGISTRY_MAX_TASKS).map(task => ({ task_id: task.task_id, status: task.status,
          owner: task.owner_pid, reviewer: task.reviewer_pid, tester: task.tester_pid, next_action: String(task.next_action ?? '').slice(0, 300) }));
        return { ...mine, registry, registry_truncated: all.tasks.length > REGISTRY_MAX_TASKS };
      }
      case 'store_delta': {
        const since = intArg(args, 'since_seq', 0, Number.MAX_SAFE_INTEGER);
        const limit = intArg(args, 'limit', 1, 50, 50);
        const { events, hasMore } = await store.getDelta(cycle_id, since, limit, participant_id);
        return { has_more: hasMore, events: events.map(event => ({ seq: event.seq, type: event.type, participant_id: event.participant_id, payload: event.payload_json })) };
      }
      case 'github_read_file': {
        const path = stringArg(args, 'path', /^[^\0]{1,400}$/);
        const ref = stringArg(args, 'ref', REF_RE);
        const file = await options.github!.getTextFile(options.repository!, path, ref);
        await journalRead(options.db, ctx.run_id, 'github_read_file', SHA_RE.test(ref) ? ref : '');
        return { path: file.path, sha: file.sha, size: file.size, content: file.content };
      }
      case 'github_pull_request': {
        const number = intArg(args, 'number', 1, 10_000_000);
        const pr = await options.github!.getPullRequest(options.repository!, number) as Record<string, unknown>;
        await journalRead(options.db, ctx.run_id, 'github_pull_request', '');
        const head = (pr.head ?? {}) as Record<string, unknown>;
        const base = (pr.base ?? {}) as Record<string, unknown>;
        return { number: pr.number, title: pr.title, state: pr.state, draft: pr.draft, merged: pr.merged,
          head: { ref: head.ref, sha: head.sha }, base: { ref: base.ref, sha: base.sha } };
      }
      case 'github_check_runs': {
        const sha = stringArg(args, 'sha', SHA_RE);
        const runs = await options.github!.listCheckRuns(options.repository!, sha) as Array<Record<string, unknown>>;
        await journalRead(options.db, ctx.run_id, 'github_check_runs', sha);
        return runs.slice(0, 50).map(run => ({ name: run.name, status: run.status, conclusion: run.conclusion, head_sha: run.head_sha }));
      }
      case 'github_diff': {
        const head = stringArg(args, 'head', SHA_RE);
        const base = stringArg(args, 'base', REF_RE);
        const comparison = await options.github!.compareRefs(options.repository!, base, head) as Record<string, unknown>;
        await journalRead(options.db, ctx.run_id, 'github_diff', head);
        const raw = Array.isArray(comparison.files) ? comparison.files as Array<Record<string, unknown>> : [];
        // L5a : le diff est borné avant d'entrer dans le contexte du modèle (données, jamais instructions).
        const files = raw.slice(0, DIFF_MAX_FILES).map(file => {
          const patch = typeof file.patch === 'string' ? file.patch : '';
          return { filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions,
            patch: patch.slice(0, DIFF_PATCH_CHARS), patch_truncated: patch.length > DIFF_PATCH_CHARS };
        });
        return { base, head, status: comparison.status, ahead_by: comparison.ahead_by, behind_by: comparison.behind_by,
          total_commits: comparison.total_commits, files, files_truncated: raw.length > DIFF_MAX_FILES };
      }
      default:
        break;
    }
    if (options.continuity && (CONTINUITY_TOOLS as readonly string[]).includes(call.name)) {
      const ids = await equivalentParticipantIds(options.db, participant_id);
      if (call.name === 'store_continuity') return loadContinuity(options.db, cycle_id, ids);
      const cycle = await options.db.prepare('SELECT project FROM cycles WHERE cycle_id = ?1').bind(cycle_id).first<{ project: string | null }>();
      const memory = await loadVisibleActiveMemory(options.db, { participantId: participant_id, participantIds: new Set(ids), project: cycle?.project ?? null });
      return { entries: memory.slice(0, CONTINUITY_MEMORY_LIMIT), truncated: memory.length > CONTINUITY_MEMORY_LIMIT };
    }
    throw new ToolRefused('tool_not_allowlisted');
  }
  return {
    spec(taskKind: string, name: string): ToolSpec | null {
      if (readNames(taskKind).includes(name)) return { name, effect: 'read' };
      if ((writeNames(taskKind) as readonly string[]).includes(name)) return { name, effect: 'write' };
      return null;
    },
    list(taskKind: string): string[] {
      return [...readNames(taskKind), ...writeNames(taskKind)];
    },
    schemas(taskKind: string): ToolSchema[] {
      const names = new Set<string>([...readNames(taskKind), ...writeNames(taskKind)]);
      return [...READ_TOOL_SCHEMAS, ...CONTINUITY_TOOL_SCHEMAS, ...WRITE_TOOL_SCHEMAS, ...GITHUB_WRITE_TOOL_SCHEMAS, ...VERDICT_TOOL_SCHEMAS].filter(schema => names.has(schema.name));
    },
    execute,
    // Contrat d'hôte 7a : un outil d'écriture sans lookup serait refusé ; les écritures store en ont un.
    async lookup(call: ToolCall, ctx: { run_id: string; effect_key: string }): Promise<LookupResult> {
      if (verdicts && call.name === 'store_verdict') return verdicts.lookup(call, ctx);
      if (gh && isGitHubWrite(call.name)) return gh.lookup(call, ctx);
      return writes ? writes.lookup(call, ctx) : null;
    },
  };
}
