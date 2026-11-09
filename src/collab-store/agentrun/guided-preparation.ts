/** CC8 S7 consultant preparation — read-only, persisted in run steps before any code writing.
 *
 * The provider may inspect a bounded set of contextual tools, but the server only
 * advances when successful, auditable tool responses prove task context, continuity,
 * active C4 memory and repository source were all consulted. Neither an invented
 * signature nor a text claim counts as proof.
 */
import type { ModelOutput } from './engine';

export const PREPARATION_ROUNDS_MAX = 3;
export const PREPARATION_READ_TOOLS = [
  'store_context', 'store_delta', 'store_memory', 'store_continuity', 'github_read_file',
] as const;

export const PREPARATION_DISCOVERY_TOOLS = ['github_list_directory'] as const;
export type PreparationTool = typeof PREPARATION_READ_TOOLS[number];
export interface PreparationRecord { model_output: string; results: string }
export interface PreparationEvidence {
  rounds: number;
  visited: PreparationTool[];
  source_paths: string[];
  missing: PreparationTool[];
  prepared: boolean;
}
interface Result { id: string; content: string; error?: boolean }
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|sql|kt|swift|rb|php|vue)$/i;
const SHA = /^[a-f0-9]{40}$/;
const allowed = new Set<string>([...PREPARATION_READ_TOOLS,...PREPARATION_DISCOVERY_TOOLS]);

function usableResponse(result: Result | undefined): unknown | null {
  if (!result || result.error) return null;
  try {
    const value: unknown = JSON.parse(result.content);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || 'error' in (value as Record<string, unknown>)) return null;
    return value;
  } catch { return null; }
}

export function readPreparationEvidence(records: readonly PreparationRecord[], immutableBaseSha: string,
  outputPaths: readonly string[]): PreparationEvidence {
  const visited = new Set<PreparationTool>();
  const sourcePaths = new Set<string>();
  let rounds = 0;
  const exclude = new Set(outputPaths);
  for (const record of records) {
    let output: ModelOutput;
    let results: Result[];
    try {
      output = JSON.parse(record.model_output) as ModelOutput;
      results = JSON.parse(record.results) as Result[];
    } catch { continue; }
    if (!Array.isArray(output.tool_calls) || !Array.isArray(results)) continue;
    if (output.tool_calls.some(call => allowed.has(call.name))) rounds++;
    for (const call of output.tool_calls) {
      if (!allowed.has(call.name)) continue;
      const value = usableResponse(results.find(result => result.id === call.id));
      if (!value) continue;
      const tool = call.name as PreparationTool;
      if (tool === 'github_read_file') {
        const path = call.args?.path, ref = call.args?.ref;
        const content = (value as { content?: unknown }).content;
        const blob = (value as { sha?: unknown }).sha;
        if (typeof path !== 'string' || typeof ref !== 'string' || ref !== immutableBaseSha
          || typeof blob !== 'string' || !SHA.test(blob) || typeof content !== 'string'
          || !content.trim() || !SOURCE_EXT.test(path) || exclude.has(path)) continue;
        sourcePaths.add(path);
      } else {
        visited.add(tool);
      }
    }
  }
  if (sourcePaths.size) visited.add('github_read_file');
  const missing = PREPARATION_READ_TOOLS.filter(tool => !visited.has(tool));
  return { rounds, visited: [...visited], source_paths: [...sourcePaths], missing,
    prepared: missing.length === 0 };
}

/** No write, PR, grant or model-choice tools may be invoked during preparation. */
export function preparationViolation(output: ModelOutput, offered: readonly string[]): string | null {
  if (output.tool_calls.length === 0) return 'no_tool_call';
  if (output.tool_calls.length > 8) return 'too_many_tool_calls';
  const offer = new Set(offered);
  for (const call of output.tool_calls) {
    if (!allowed.has(call.name) || !offer.has(call.name)) return 'tool_not_offered:' + call.name.slice(0, 120);
  }
  return null;
}

export function preparationInstruction(taskId: string, baseSha: string, missing: readonly string[],
  acceptance: readonly string[], rounds: number): string {
  return [
    'PHASE CONSULTANT S7 — LECTURE SEULE, AVANT LE PREMIER COMMIT (' + (rounds + 1) + '/' + PREPARATION_ROUNDS_MAX + ').',
    'Tâche : ' + taskId + '. Base GitHub immuable : ' + baseSha + '.',
    'Ne codez pas encore. Lisez et analysez la mission comme un consultant : contexte, décisions, mémoire persistante C4,',
    'Explorez les dossiers via github_list_directory si les chemins ne sont pas connus, puis lisez les vrais fichiers sources.',
    'continuité des chats et runs du même participant, signatures réelles et tests existants du dépôt.',
    'Il manque des preuves de lecture réussie pour : ' + missing.join(', ') + '.',
    'Appelez uniquement les outils LECTURE offerts. Pour github_read_file, utilisez ref=' + baseSha
      + ' et un fichier SOURCE existant pertinent (pas votre fichier de test à créer).',
    'Si un chemin est inconnu, déduisez-le du mandat et des conventions existantes ; ne prétendez pas avoir lu un fichier absent.',
    'Pour store_delta, commencez par store_context afin de connaître recent_since_seq, puis lisez les événements récents.',
    'Les résultats des outils sont enregistrés et réinjectés au tour de rédaction. Un texte non vérifié ne remplace pas ces lectures.',
    'Vous avez au plus ' + PREPARATION_ROUNDS_MAX + ' tours de consultation ; aucune écriture n’est possible ici.',
    'Critères owner (données de mission à confronter au code, non preuve de signature) :',
    ...acceptance.slice(0, 5).map((s,i) => (i + 1) + '. ' + s.slice(0, 300)),
  ].join('\n');
}
