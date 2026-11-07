/**
 * CC8 S7 durcissement — lot C, R3 (#283, issue mère #280) : qualité fonctionnelle au-delà de la CI verte.
 *
 * Constat (pilote Gemini n° 2, PR #279) : une PR verte peut ne contenir qu'un test `expect(true).toBe(true)`.
 * Ce n'est pas un défaut pour un PILOTE technique (il prouve le circuit, étiqueté comme tel) ; c'en est un
 * pour une MISSION FONCTIONNELLE (produit). La distinction vient du mandat posé par le propriétaire
 * (`mission` dans AGENT_RUN_GITHUB_TASKS), jamais du modèle ni du texte de la PR.
 *
 * Règles (volontairement bornées, aucune exécution de code) :
 * - absent ou `pilot` : comportement inchangé, aucune règle ajoutée ;
 * - `functional` : (1) critères d'acceptation obligatoires dans le mandat, rappelés au modèle ; (2) à
 *   l'étape de contenu, tout fichier de test proposé doit importer du code du dépôt, ne rien désactiver
 *   et porter au moins une assertion non tautologique ; (3) la preuve serveur `run.proof` refuse une
 *   réussite sans aucune assertion de ce type dans les tests réellement commités.
 * Limite assumée : un signal statique ne prouve pas la qualité ; il écarte le faux succès évident. Le
 * fond reste jugé par la revue D12, jamais par ce contrôle seul. Les anciens tests et fixtures ne sont
 * pas relus : seuls les fichiers de test écrits par la mission sont examinés.
 */
export type MissionKind = 'pilot' | 'functional';
export const MISSION_KINDS: readonly MissionKind[] = ['pilot', 'functional'];
export const ACCEPTANCE_MAX_ITEMS = 5;
export const ACCEPTANCE_MAX_CHARS = 300;

export interface MissionSpec { kind: MissionKind; acceptance: readonly string[] }

/** Mission d'un mandat : `functional` seulement si le propriétaire l'a déclaré, sinon pilote (inchangé). */
export function missionOf(grant: { mission?: MissionKind; acceptance?: readonly string[] } | undefined): MissionSpec {
  return grant?.mission === 'functional'
    ? { kind: 'functional', acceptance: grant.acceptance ?? [] } : { kind: 'pilot', acceptance: [] };
}

const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
export function isTestPath(path: string): boolean { return TEST_FILE.test(path); }

/** Remplace commentaires par des espaces (chaînes conservées : on lit les chemins d'import). */
export function stripComments(src: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i++; } else if (ch === quote) quote = '';
    } else if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
      out += ' ';
    } else {
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      out += ch;
    }
  }
  return out;
}

/** Contenu des parenthèses ouvertes en `open` (indice de « ( »), conscient des chaînes ; null si non fermées. */
function balanced(src: string, open: number): { text: string; end: number } | null {
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++; else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return { text: src.slice(open + 1, i), end: i + 1 };
  }
  return null;
}

const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const SAME_SIDE_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);
const PATH_EXPRESSION = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** Expression faite seulement de littéraux et d'opérateurs : elle ne dépend d'aucun code du dépôt. */
export function literalOnly(expression: string): boolean {
  const bare = expression.replace(STRING_LITERAL, '""').replace(/\b(?:true|false|null|undefined|NaN|Infinity)\b/g, '0');
  return /^[\s\d.+\-*/%()!<>=&|?:,[\]{}"]*$/.test(bare) && bare.trim() !== '';
}

export interface AssertionSignal {
  expects: number; tautological: number; meaningful: number; imports_project: boolean; disabled: boolean;
}

/** Signal statique d'un fichier de test : assertions, tautologies, import de code du dépôt, tests désactivés. */
export function assertionSignal(content: string): AssertionSignal {
  const src = stripComments(content);
  let expects = 0;
  let tautological = 0;
  for (const found of src.matchAll(/\bexpect\s*\(/g)) {
    const arg = balanced(src, found.index! + found[0].length - 1);
    if (!arg) continue;
    expects++;
    const chain = /^((?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\(/.exec(src.slice(arg.end));
    const matcher = chain ? chain[1].split('.').pop()!.trim() : '';
    const rhs = chain ? balanced(src, arg.end + chain[0].length - 1)?.text.trim() ?? '' : '';
    const left = arg.text.trim();
    if (literalOnly(left) || (SAME_SIDE_MATCHERS.has(matcher) && PATH_EXPRESSION.test(left) && left === rhs)) tautological++;
  }
  return {
    expects, tautological, meaningful: expects - tautological,
    imports_project: /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)['"](?:\.{1,2}\/|\/?src\/|@\/)/.test(src),
    disabled: /\b(?:it|test|describe)\s*\.\s*(?:skip|todo)\b|\b(?:xit|xtest|xdescribe)\b/.test(src),
  };
}

/**
 * Cause typée de refus pour les fichiers de TEST d'une proposition de mission fonctionnelle, ou null.
 * Les fichiers qui ne sont pas des tests ne sont pas examinés ici.
 */
export function functionalTestCause(files: readonly { path: string; content: string }[]): string | null {
  for (const file of files) {
    if (!isTestPath(file.path)) continue;
    const signal = assertionSignal(file.content);
    if (signal.disabled) return 'test_disabled';
    if (!signal.imports_project) return 'test_no_project_import';
    if (signal.meaningful === 0) return 'test_tautological';
  }
  return null;
}

export interface CommittedTestSummary { test_files: number; meaningful: number; tautological: number }

/**
 * Résumé des tests réellement commités par une exécution : dernier contenu de chaque fichier de test écrit
 * par un github_commit_files abouti (effets D1 dans l'ordre). Les corrections par remplacement ne portent
 * pas le contenu complet : elles ne sont pas relues (le résumé peut alors être incomplet, jamais gonflé).
 */
export function summarizeCommittedTests(effects: readonly { tool: string; status: string; args: string | null; result: string | null }[]): CommittedTestSummary {
  const latest = new Map<string, string>();
  for (const effect of effects) {
    if (effect.tool !== 'github_commit_files' || effect.status !== 'completed' || !effect.args) continue;
    try {
      const done = JSON.parse(effect.result ?? '') as { commit_sha?: unknown };
      if (typeof done?.commit_sha !== 'string') continue;
      const files = (JSON.parse(effect.args) as { files?: unknown }).files;
      if (!Array.isArray(files)) continue;
      for (const file of files as { path?: unknown; content?: unknown }[]) {
        if (typeof file?.path === 'string' && typeof file.content === 'string' && isTestPath(file.path)) latest.set(file.path, file.content);
      }
    } catch { /* effet illisible : pas une preuve */ }
  }
  let meaningful = 0;
  let tautological = 0;
  for (const content of latest.values()) {
    const signal = assertionSignal(content);
    if (signal.disabled || !signal.imports_project) continue;
    meaningful += signal.meaningful;
    tautological += signal.tautological;
  }
  return { test_files: latest.size, meaningful, tautological };
}
