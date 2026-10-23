/**
 * CC-5 l7 (incrément 7c-1) — hôte d'outils en LECTURE SEULE pour les exécutions API.
 *
 * Allowlist deny-by-default figée en code (amendement A2, plan seq 719) : chaque
 * type de tâche n'a que les outils listés dans READ_TOOLS_BY_KIND ; aucun outil
 * d'écriture (effect 'read' partout), donc aucun effet externe en 7c-1. Le
 * moteur refuse en plus API_AGENT_FORBIDDEN et tronque chaque résultat
 * (RESULT_MAX_CHARS) avant de le rendre au modèle comme donnée.
 *
 * Le participant et le cycle d'un appel sont relus dans agent_runs à partir
 * du run_id fourni par le moteur, jamais pris dans les arguments du modèle :
 * une exécution ne lit que le contexte de SON participant (masquage CR-C du
 * store, redactEventsFor) et que le dépôt autorisé par l'hôte.
 */
import { CollabStore } from '../store/collab-store';
import { ToolRefused, type ToolCall, type ToolHost, type ToolSpec } from './engine';
import type { ToolSchema } from './workers-ai-model';

/** Lectures GitHub utilisées par l'hôte (sous-ensemble des clients existants, lecture seule). */
export interface GitHubReads {
  getTextFile(repository: string, path: string, ref: string): Promise<{ path: string; sha: string; content: string; size: number }>;
  getPullRequest(repository: string, pullNumber: number): Promise<unknown>;
  listCheckRuns(repository: string, ref: string): Promise<unknown[]>;
}

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
]);

export type ReadToolName = 'store_context' | 'store_delta' | 'github_read_file' | 'github_pull_request' | 'github_check_runs';

/** Allowlist par type de tâche, figée en code ; un type inconnu n'a aucun outil. */
export const READ_TOOLS_BY_KIND: Readonly<Record<string, readonly ReadToolName[]>> = Object.freeze({
  research: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs'],
  planning: ['store_context', 'store_delta', 'github_read_file'],
  status: ['store_context', 'store_delta', 'github_check_runs'],
});

const SHA_RE = /^[a-f0-9]{40}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

export interface ReadToolHostOptions {
  db: D1Database;
  /** Unique dépôt lisible par l'exécution (ex. rfkevin/github-mcp) ; null = aucun outil GitHub. */
  repository: string | null;
  github: GitHubReads | null;
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
  const allowed = (taskKind: string): readonly ReadToolName[] => {
    const tools = Object.prototype.hasOwnProperty.call(READ_TOOLS_BY_KIND, taskKind) ? READ_TOOLS_BY_KIND[taskKind] : [];
    // Sans dépôt ou client GitHub, les outils GitHub ne sont pas proposés du tout.
    return tools.filter(name => !name.startsWith('github_') || (options.repository !== null && options.github !== null));
  };
  async function scope(runId: string): Promise<RunScope> {
    const run = await options.db.prepare('SELECT cycle_id, participant_id FROM agent_runs WHERE run_id = ?1').bind(runId).first<RunScope>();
    if (!run) throw new ToolRefused('unknown_run');
    return run;
  }
  async function execute(call: ToolCall, ctx: { run_id: string }): Promise<unknown> {
    const { cycle_id, participant_id } = await scope(ctx.run_id);
    const args = call.args ?? {};
    const store = new CollabStore(options.db);
    switch (call.name as ReadToolName) {
      case 'store_context':
        return store.getContext(cycle_id, participant_id);
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
        return { path: file.path, sha: file.sha, size: file.size, content: file.content };
      }
      case 'github_pull_request': {
        const number = intArg(args, 'number', 1, 10_000_000);
        const pr = await options.github!.getPullRequest(options.repository!, number) as Record<string, unknown>;
        const head = (pr.head ?? {}) as Record<string, unknown>;
        const base = (pr.base ?? {}) as Record<string, unknown>;
        return { number: pr.number, title: pr.title, state: pr.state, draft: pr.draft, merged: pr.merged,
          head: { ref: head.ref, sha: head.sha }, base: { ref: base.ref, sha: base.sha } };
      }
      case 'github_check_runs': {
        const sha = stringArg(args, 'sha', SHA_RE);
        const runs = await options.github!.listCheckRuns(options.repository!, sha) as Array<Record<string, unknown>>;
        return runs.slice(0, 50).map(run => ({ name: run.name, status: run.status, conclusion: run.conclusion, head_sha: run.head_sha }));
      }
      default:
        throw new ToolRefused('tool_not_allowlisted');
    }
  }
  return {
    spec(taskKind: string, name: string): ToolSpec | null {
      return (allowed(taskKind) as readonly string[]).includes(name) ? { name, effect: 'read' } : null;
    },
    list(taskKind: string): string[] {
      return [...allowed(taskKind)];
    },
    schemas(taskKind: string): ToolSchema[] {
      const names = new Set<string>(allowed(taskKind));
      return READ_TOOL_SCHEMAS.filter(schema => names.has(schema.name));
    },
    execute,
  };
}
