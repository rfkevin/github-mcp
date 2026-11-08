/**
 * CC8 S7 — mode guidé : le serveur fait les étapes mécaniques, le modèle écrit seulement le contenu.
 *
 * Constat (pilotes Vibe n° 4 seq 1710, Gemini n° 1 seq 1716) : les modèles gratuits n'enchaînent pas
 * seuls les six appels dépendants (mandat → branche → commit → CI → résultat → PR). Vibe s'est arrêté
 * après la lecture du mandat ; Gemini a épuisé ses 12 étapes sans créer la branche. Décision de Kevin
 * (2026-11-06, 16:25) : réparer le circuit pour les modèles gratuits, ce qui allège aussi le travail
 * d'un modèle payant plus tard.
 *
 * Principe : pour une exécution implement couverte par un mandat S7, la prochaine action est déduite
 * des seuls effets D1 (et des relevés de CI serveur). Si elle est mécanique, le serveur l'émet lui-même
 * comme sortie d'étape (aucun appel modèle, aucun jeton) ; elle passe ensuite par le MÊME chemin que
 * les appels du modèle : allow-list, gardes S7 (HALT, pause, fence, mandat, head), effets idempotents,
 * réconciliation, garde de complétude #271. Si l'action demande du contenu (premier commit, correction
 * après CI rouge), le modèle est appelé avec une consigne précise et un seul outil, github_commit_files.
 * Dans tout autre état (refus, ambiguïté, escalade), ARRÊT TYPÉ `guided_stop:<cause>` : un run guidé ne
 * revient jamais à l'orchestration libre par le modèle (relecture D12 GPT-6, 2e passe).
 *
 * Relecture D12 (GPT-6, PR #278) et avis Vibe / Grok (salon) :
 * - le serveur remplit lui-même name, expected_head_sha et le expected_sha du fichier (lu au head) :
 *   le modèle ne fournit que chemin et contenu (applyGuidedFill) ;
 * - les étapes serveur ne comptent pas dans max_steps (table agent_run_server_steps, plafond propre) ;
 * - branche préexistante : reprise depuis la tête lue par le mandat (branch_head) ;
 * - correction : diagnostics de CI bornés et contenu actuel du fichier injectés dans la consigne.
 *
 * Lot A (#281, issue mère #280), après les pilotes Vibe n° 5 (seq 1731) et Gemini n° 2 (seq 1734) :
 * - R1 : le nom d'outil est canonisé (espaces de bord seulement, String.prototype.trim) AVANT les
 *   gardes ; casse, espace interne, caractère invisible ou homoglyphe, autre outil : refus inchangé ;
 * - R2 : prévalidation statique du contenu, après applyGuidedFill et AVANT tout effet GitHub, sans
 *   exécuter de code. Un refus est un effet D1 `guided_precheck` (échec, aucune écriture GitHub) :
 *   l'étape compte dans max_steps et les jetons, pas dans les corrections CI ; une reformulation au
 *   plus, puis arrêt typé `guided_stop:precheck_failed` ;
 * - R3 (consigne seulement) : test Vitest du dépôt, code du dépôt importé, assertions liées à la
 *   demande ; le contrôle automatique des tests triviaux viendra au lot C.
 */
import type { ModelOutput, ToolCall } from './engine';
import { functionalTestCause, type MissionSpec } from './mission-quality';

export interface GuidedEntry { tool: string; value: Record<string, unknown> | null; failed: boolean; detail?: string }

/** Seul outil offert à une étape de contenu guidée. */
export const GUIDED_TOOL = 'github_commit_files';
/** Effet D1 d'un refus de prévalidation (aucune écriture GitHub). */
export const GUIDED_PRECHECK_TOOL = 'guided_precheck';
/** Refus de prévalidation tolérés par phase de contenu : 1 reformulation, puis arrêt typé. */
export const GUIDED_PRECHECK_MAX = 2;
/** Taille maximale d'un fichier proposé (octets UTF-8). */
export const PRECHECK_MAX_BYTES = 100_000;
const MESSAGE_MAX = 500;

/**
 * R1 (#281) : canonise le nom de l'outil de contenu. Seuls les espaces de BORD sont retirés
 * (String.prototype.trim) ; tout autre écart (casse, espace interne, caractère invisible non blanc,
 * homoglyphe, suffixe) laisse le nom intact et guidedViolation le refuse. Rend aussi les noms bruts
 * normalisés (bornés, encodés JSON) pour le journal.
 */
export function canonicalGuidedOutput(output: ModelOutput): { output: ModelOutput; normalized: string[] } {
  const normalized: string[] = [];
  const tool_calls = output.tool_calls.map(call => {
    if (call.name === GUIDED_TOOL || call.name.trim() !== GUIDED_TOOL) return call;
    normalized.push(JSON.stringify(call.name).slice(0, 80));
    return { ...call, name: GUIDED_TOOL };
  });
  return { output: { text: output.text, tool_calls }, normalized };
}

const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
const VITEST_IMPORT = /(?:\bfrom\s*|\bimport\s*|\brequire\(\s*)['"]vitest['"]/;
const OTHER_RUNNER = /(?:\bfrom\s*|\bimport\s*|\brequire\(\s*)['"](?:@jest\/globals|jest|mocha|jasmine)['"]/;

/** Explication donnée au modèle pour chaque cause de refus (reformulation). */
export const PRECHECK_HINTS: Record<string, string> = {
  message_missing: 'le champ message est absent ou vide',
  message_too_long: 'le message dépasse ' + MESSAGE_MAX + ' caractères',
  files_missing: 'files doit contenir au moins un fichier { path, content }',
  too_many_files: 'trop de fichiers pour le mandat',
  file_invalid: 'chaque entrée de files doit être un objet { path, content }',
  path_not_granted: 'le chemin n’est pas dans la liste des chemins autorisés',
  path_duplicate: 'le même chemin apparaît deux fois',
  content_empty: 'le contenu du fichier est vide',
  content_too_large: 'le fichier dépasse ' + PRECHECK_MAX_BYTES + ' octets',
  test_runner_incompatible: 'le dépôt utilise Vitest : n’importe ni jest, ni @jest/globals, ni mocha, ni jasmine',
  test_vitest_import_missing: 'un fichier de test doit importer ses fonctions depuis \'vitest\' (par ex. import { describe, it, expect } from \'vitest\')',
  test_vitest_symbol_missing: 'une fonction Vitest appelée (expect, describe, it, test, vi ou hook) manque dans les imports nommés',
  dependency_manifest_unavailable: 'package.json inaccessible : impossible de vérifier les modules npm',
  dependency_not_declared: 'un module npm importé par le test est absent de package.json',
  correction_no_diff: 'la correction ne change aucun fichier, propose un diff réel après la CI rouge',
  // Lot C R3 (#283) : mission fonctionnelle seulement.
  test_disabled: 'mission fonctionnelle : aucun test ne doit être désactivé (skip, todo, xit)',
  test_no_project_import: 'mission fonctionnelle : le test doit importer du code du dépôt (chemin relatif ou src/)',
  test_tautological: 'mission fonctionnelle : le test doit contenir au moins une assertion non tautologique sur le comportement du code importé',
};


/** U1 : masquer commentaires et littéraux pour repérer uniquement les appels exécutables. */
function activeSource(src: string): string {
  let out = '', quote = '', mode: 'code' | 'line' | 'block' = 'code';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i], next = src[i + 1];
    if (mode === 'line') { if (ch === '\n') { mode = 'code'; out += '\n'; } else out += ' '; }
    else if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; out += '  '; i++; }
      else out += ch === '\n' ? '\n' : ' ';
    } else if (quote) {
      if (ch === '\\') { out += ' '; if (i + 1 < src.length) { i++; out += src[i] === '\n' ? '\n' : ' '; } }
      else if (ch === quote) { quote = ''; out += ' '; }
      else out += ch === '\n' ? '\n' : ' ';
    } else if (ch === '/' && next === '/') { mode = 'line'; out += '  '; i++; }
    else if (ch === '/' && next === '*') { mode = 'block'; out += '  '; i++; }
    else if (ch === "'" || ch === '"' || ch === String.fromCharCode(96)) { quote = ch; out += ' '; }
    else out += ch;
  }
  return out;
}
const VITEST_DIRECT = ['expect', 'describe', 'it', 'test', 'vi', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll'];
function missingVitestImport(src: string): boolean {
  const active = activeSource(src), imported = new Set<string>();
  for (const m of src.matchAll(/\bimport\s*{([^}]+)}\s*from\s*['"]vitest['"]/g)) {
    if (active.slice(m.index, m.index + 6) !== 'import') continue;
    for (const item of m[1].split(',')) {
      const parts = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (parts[0]) imported.add((parts[1] ?? parts[0]).trim());
    }
  }
  return VITEST_DIRECT.some(name => !imported.has(name)
    && new RegExp('(?<![\\w$.])' + name + '\\s*(?:\\(|\\.)').test(active));
}
/** U2 : modules npm externes utilisés par un fichier de test. */
export function guidedBareDependencies(call: ToolCall): string[] {
  const packages = new Set<string>(), files = (call.args ?? {}).files;
  if (!Array.isArray(files)) return [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || !TEST_FILE.test(file.path) || typeof file.content !== 'string') continue;
    const src = file.content as string, active = activeSource(src);
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)) {
      if (!/^(?:from|import|require)\b/.test(active.slice(m.index))) continue;
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')
        || spec === 'vitest' || spec.startsWith('vitest/') || spec === 'cloudflare:test') continue;
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (pkg) packages.add(pkg);
    }
  }
  return [...packages].sort((a, b) => a.localeCompare(b));
}
export interface GuidedPrecheckContext {
  declaredDependencies?: ReadonlySet<string>;
  currentFiles?: Readonly<Record<string, string>>;
  correction?: boolean;
}

/**
 * R2 (#281) : prévalidation statique d'un appel github_commit_files déjà rempli par le serveur.
 * Aucune exécution de code ; règles vérifiables seulement. null = conforme, sinon cause typée.
 */
export function guidedPrecheck(call: ToolCall, paths: readonly string[], mission?: MissionSpec, context: GuidedPrecheckContext = {}): string | null {
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (typeof args.message !== 'string' || !args.message.trim()) return 'message_missing';
  if (args.message.length > MESSAGE_MAX) return 'message_too_long';
  const files = args.files;
  if (!Array.isArray(files) || files.length === 0) return 'files_missing';
  if (files.length > paths.length) return 'too_many_files';
  const seen = new Set<string>();
  for (const entry of files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'file_invalid';
    const { path, content } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || !paths.includes(path)) return 'path_not_granted';
    if (seen.has(path)) return 'path_duplicate';
    seen.add(path);
    if (typeof content !== 'string' || !content.trim()) return 'content_empty';
    if (new TextEncoder().encode(content).length > PRECHECK_MAX_BYTES) return 'content_too_large';
    if (TEST_FILE.test(path)) {
      if (OTHER_RUNNER.test(content)) return 'test_runner_incompatible';
      if (!VITEST_IMPORT.test(content)) return 'test_vitest_import_missing';
      if (missingVitestImport(content)) return 'test_vitest_symbol_missing';
    }
  }
  const bare = guidedBareDependencies(call);
  if (bare.length && !context.declaredDependencies) return 'dependency_manifest_unavailable';
  if (bare.some(pkg => !context.declaredDependencies?.has(pkg))) return 'dependency_not_declared';
  if (context.correction && context.currentFiles && files.every(file => {
    const f = file as { path: string; content: string };
    return Object.prototype.hasOwnProperty.call(context.currentFiles, f.path)
      && context.currentFiles![f.path] === f.content;
  })) return 'correction_no_diff';
  // Lot C R3 : contrôle propre aux missions fonctionnelles ; un pilote technique n'est jamais concerné.
  if (mission?.kind === 'functional') {
    return functionalTestCause((files as { path: string; content: string }[]).map(f => ({ path: f.path, content: f.content })));
  }
  return null;
}

/** Consigne commune de qualité (R2/R3, consigne seulement). */
const PILOT_RULES = [
  'Règles de contenu : si le fichier est un test (*.spec.ts), importe describe/it/expect depuis \'vitest\' (jamais jest, @jest/globals ni mocha) ;',
  'importe le code du dépôt concerné par la demande et écris des assertions liées à la demande — pas de test tautologique (expect(true)), sauf si la mission demande explicitement un test de démonstration.',
  'Importe chaque fonction Vitest utilisée et seulement des modules déclarés dans package.json. Après CI rouge, fournis un vrai changement de contenu.',
].join('\n');

/** Consigne de contenu : règles communes, plus les critères d'acceptation d'une mission fonctionnelle (lot C R3). */
function contentRules(mission?: MissionSpec): string {
  if (mission?.kind !== 'functional') return PILOT_RULES;
  return [PILOT_RULES, 'MISSION FONCTIONNELLE : un test de démonstration est refusé par le serveur. Chaque fichier de test doit importer du code',
    'du dépôt, ne rien désactiver (skip, todo) et contenir au moins une assertion non tautologique sur le comportement de ce code.',
    'Critères d’acceptation de la mission (posés par le propriétaire) :', ...mission.acceptance.map((c, i) => (i + 1) + '. ' + c)].join('\n');
}

/** Refus de prévalidation depuis l'indice `from` : nombre et dernière cause. */
function prechecks(entries: readonly GuidedEntry[], from: number): { count: number; last?: string } {
  const found = entries.slice(from).filter(e => e.tool === GUIDED_PRECHECK_TOOL);
  return { count: found.length, last: found.at(-1)?.detail };
}

function retryNote(refused: { count: number; last?: string }): string[] {
  if (refused.count === 0) return [];
  const cause = refused.last ?? 'inconnue';
  return ['', 'ATTENTION : ta proposition précédente a été REFUSÉE par la prévalidation du serveur (aucun commit créé) : '
    + (PRECHECK_HINTS[cause] ?? cause) + ' [' + cause + ']. Dernière tentative avant arrêt : corrige ce point.'];
}

export type GuidedStep =
  | { kind: 'server'; call: ToolCall }
  | { kind: 'model'; tools: string[]; instruction: string; fill: GuidedFill }
  | { kind: 'stop'; reason: string };

/**
 * Sortie d'une étape de contenu guidée : exactement UN appel github_commit_files, rien d'autre.
 * null = conforme ; sinon cause typée (aucun appel, appel non offert, plusieurs appels). Vérifié par
 * le moteur AVANT tout effet ; en cas de violation l'exécution s'arrête (aucun repli libre).
 */
export function guidedViolation(output: ModelOutput): string | null {
  if (output.tool_calls.length === 0) return 'no_tool_call';
  const names = output.tool_calls.map(call => call.name);
  if (names.some(name => name !== GUIDED_TOOL)) return 'tool_not_offered:' + [...new Set(names)].join(',').slice(0, 120);
  if (names.length !== 1) return 'multiple_tool_calls:' + names.length;
  return null;
}

/** Valeurs autoritaires du serveur, appliquées à l'appel github_commit_files du modèle. */
export interface GuidedFill { name: string; head: string; paths: string[]; blobs?: Record<string, string | null>; currentFiles?: Record<string, string>; correction?: boolean; mission?: MissionSpec }

/** Plafond propre des étapes serveur d'une exécution guidée (au-delà : flux historique). */
export const GUIDED_SERVER_MAX = 24;
const DIAGNOSTICS_MAX = 1_500;

const SHA = /^[a-f0-9]{40}$/;
const COMMIT_TOOLS = ['github_commit_files', 'github_replace_text'];

function sha(value: unknown): string | null {
  return typeof value === 'string' && SHA.test(value) ? value : null;
}

function lastIndex(entries: readonly GuidedEntry[], from: number, test: (e: GuidedEntry) => boolean): number {
  for (let i = entries.length - 1; i >= from; i--) if (test(entries[i])) return i;
  return -1;
}

/**
 * Prochaine étape guidée : serveur, contenu (modèle) ou arrêt typé.
 * `entries` : effets D1 dans l'ordre (n, idx), relevés de CI serveur insérés après leur effet d'origine.
 */
export function planGuidedS7(entries: readonly GuidedEntry[], branch: string, taskId: string, step: number, mission?: MissionSpec): GuidedStep {
  const stop = (reason: string): GuidedStep => ({ kind: 'stop', reason });
  const name = branch.split('-api-')[1];
  if (!name) return stop('branch_name');
  const server = (tool: string, args: Record<string, unknown>): GuidedStep =>
    ({ kind: 'server', call: { id: 'srv-' + step + '-' + tool, name: tool, args } });

  // 1. Mandat.
  const scopeAt = lastIndex(entries, 0, e => e.tool === 'github_write_scope' && e.value?.branch === branch);
  if (scopeAt < 0) {
    return entries.some(e => e.tool === 'github_write_scope' && e.failed) ? stop('scope_refused') : server('github_write_scope', {});
  }
  const scope = entries[scopeAt].value!;
  const baseSha = sha(scope.base_sha);
  const paths = Array.isArray(scope.granted_paths) ? scope.granted_paths.filter((p): p is string => typeof p === 'string') : [];
  if (!baseSha || paths.length === 0) return stop('scope_invalid');
  // CC8 S7 : le compteur est durable pour (cycle, tâche, branche), pas propre à un run.
  // Ne pas demander de génération au modèle quand les 3 corrections historiques
  // sont consommées : reserveCommit refuserait l'écriture avant GitHub.
  if (typeof scope.corrections_remaining === 'number' && scope.corrections_remaining <= 0)
    return stop('commit_budget_exhausted');

  // 2. Branche : créée dans cette exécution, ou préexistante (tête lue par le serveur dans le mandat).
  let createdAt = lastIndex(entries, 0, e => e.tool === 'github_create_branch' && e.value?.branch === branch && !!sha(e.value?.sha));
  let branchHead = createdAt < 0 ? null : sha(entries[createdAt].value!.sha);
  if (createdAt < 0 && sha(scope.branch_head)) {
    createdAt = scopeAt;
    branchHead = sha(scope.branch_head);
  }
  if (createdAt < 0 || !branchHead) {
    return entries.some(e => e.tool === 'github_create_branch' && e.failed) ? stop('branch_refused')
      : server('github_create_branch', { name, base_sha: baseSha });
  }

  // 3. Dernier commit de la branche après sa création.
  const commitAt = lastIndex(entries, createdAt + 1, e => COMMIT_TOOLS.includes(e.tool) && e.value?.branch === branch && !!sha(e.value?.commit_sha));
  const pathList = paths.map(p => '« ' + p + ' »').join(', ');
  if (commitAt < 0) {
    const refused = prechecks(entries, createdAt + 1);
    if (refused.count >= GUIDED_PRECHECK_MAX) return stop('precheck_failed');
    return { kind: 'model', tools: [GUIDED_TOOL], fill: { name, head: branchHead, paths, correction: false, mission }, instruction: [
      'ÉTAPE GUIDÉE PAR LE SERVEUR (S7). Le serveur a déjà lu ton mandat et préparé la branche ' + branch + ' (tête ' + branchHead + ').',
      'Ta seule action maintenant : appeler UNE FOIS l’outil github_commit_files avec :',
      '- message : un résumé d’une ligne (120 caractères au plus)',
      '- files : [{ "path": <un chemin autorisé>, "content": <le contenu COMPLET du fichier> }]',
      'Le serveur complète lui-même name, expected_head_sha et expected_sha. Chemins autorisés : ' + pathList + '. N’appelle aucun autre outil.',
      'Ensuite, le serveur lancera la CI, attendra son résultat et ouvrira la PR lui-même.',
      contentRules(mission),
      ...retryNote(refused),
    ].join('\n') };
  }
  const commitSha = sha(entries[commitAt].value!.commit_sha)!;

  // 4. CI lancée au SHA du dernier commit.
  const startedAt = lastIndex(entries, commitAt + 1, e => e.tool === 'github_run_checks' && e.value?.targetSha === commitSha
    && Number.isSafeInteger(e.value?.runId) && Number(e.value?.runId) > 0);
  if (startedAt < 0) {
    return entries.slice(commitAt + 1).some(e => e.tool === 'github_run_checks' && e.failed) ? stop('checks_refused')
      : server('github_run_checks', { name, sha: commitSha });
  }
  const runId = Number(entries[startedAt].value!.runId);

  // 5. Résultat de CI (dernier relevé connu, modèle ou serveur).
  const checkedAt = lastIndex(entries, startedAt + 1, e => e.tool === 'github_check_result');
  const checked = checkedAt < 0 ? null : entries[checkedAt];
  if (!checked || (checked.value?.targetSha === commitSha && checked.value?.next_action === 'wait')) {
    return server('github_check_result', { name, sha: commitSha, run_id: runId });
  }
  if (checked.failed || checked.value?.targetSha !== commitSha) return stop('check_unexpected');
  const verdict = checked.value.next_action;

  // 6. CI verte : PR prête, une seule fois.
  if (checked.value.verifiedSuccess === true && checked.value.status === 'completed') {
    if (lastIndex(entries, checkedAt + 1, e => e.tool === 'github_open_pr') >= 0) return stop('pr_already_open');
    return server('github_open_pr', { name, title: ('CC8 ' + taskId + ' — ' + paths.join(', ')).slice(0, 200),
      body: 'PR ouverte en mode guidé S7 : branche, commit, CI et PR exécutés par le serveur ; contenu écrit par le modèle de l’agent. CI vérifiée au SHA ' + commitSha + '.' });
  }

  // 7. CI rouge, corrections restantes : le modèle corrige le contenu.
  if (verdict === 'correct') {
    const refused = prechecks(entries, checkedAt + 1);
    if (refused.count >= GUIDED_PRECHECK_MAX) return stop('precheck_failed');
    const diagnostics = checked.value.diagnostics ?? checked.value.failures ?? checked.value.summary;
    const shown = diagnostics === undefined ? '(aucun diagnostic fourni)' : JSON.stringify(diagnostics).slice(0, DIAGNOSTICS_MAX);
    return { kind: 'model', tools: [GUIDED_TOOL], fill: { name, head: commitSha, paths, correction: true, mission }, instruction: [
      'ÉTAPE GUIDÉE PAR LE SERVEUR (S7). La CI a ÉCHOUÉ au SHA ' + commitSha + '.',
      'Diagnostics (bornés) : ' + shown,
      'Ta seule action maintenant : corriger le fichier en appelant UNE FOIS github_commit_files avec :',
      '- message : un résumé d’une ligne de la correction',
      '- files : [{ "path": <le chemin concerné>, "content": <le contenu COMPLET corrigé> }]',
      'Le serveur complète lui-même name, expected_head_sha et expected_sha. Chemins autorisés : ' + pathList + '. N’appelle aucun autre outil.',
      contentRules(mission),
      ...retryNote(refused),
    ].join('\n') };
  }
  // Escalade, refus, état inattendu : arrêt typé, jamais de repli libre.
  return stop('ci_' + String(verdict ?? 'unknown').replace(/[^a-z0-9_]/gi, '').slice(0, 40));
}

/**
 * Applique les valeurs autoritaires du serveur à la sortie du modèle (étape de contenu guidée) :
 * name et expected_head_sha imposés, expected_sha du fichier imposé quand le serveur l'a lu (fichier
 * existant au head) et retiré sinon. Les chemins restent ceux du modèle : la garde S7 les vérifie.
 */
export function applyGuidedFill(output: ModelOutput, fill: GuidedFill): ModelOutput {
  return {
    text: output.text,
    tool_calls: output.tool_calls.map(call => {
      if (call.name !== GUIDED_TOOL) return call;
      const raw = Array.isArray(call.args?.files) ? call.args.files as unknown[] : [];
      const files = raw.map(entry => {
        const file = { ...((entry ?? {}) as Record<string, unknown>) };
        const path = typeof file.path === 'string' ? file.path : '';
        delete file.expected_sha;
        const blob = fill.blobs?.[path];
        if (blob) file.expected_sha = blob;
        return file;
      });
      return { ...call, args: { ...(call.args ?? {}), name: fill.name, expected_head_sha: fill.head, files } };
    }),
  };
}
