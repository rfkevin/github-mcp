/**
 * CC-5 l3e (amendement D13-5) — classification fail-closed d'un import d'état.
 *
 * Fonction PURE : compare l'état courant (dernier import) à l'état proposé et
 * répond `direct` ou `validate`. Elle n'accorde AUCUN pouvoir : l'import reste
 * un acte owner (state-import.ts) et la politique de délégation continue de
 * refuser import_state tant qu'une PR dédiée (D13-4) ne l'a pas branchée.
 *
 * `direct` n'est rendu que si TOUTES les conditions de la liste blanche
 * ci-dessous sont vraies ; tout le reste — document illisible, section
 * inconnue ou dupliquée, clé dupliquée, colonne absente, valeur inattendue,
 * exception — donne `validate`. Ce qui touche aux décisions du propriétaire,
 * aux droits (owner/reviewer/tester/chemins/dépendances), à la phase, aux
 * références d'issues ou à l'historique des preuves exige donc Kevin.
 *
 * Liste blanche (D13-1) d'un changement `direct` :
 *  - clés de contrôle : seules revision (= précédente + 1), base_revision
 *    (= révision précédente), next_action et based_on_sha peuvent changer ;
 *  - prose du préambule : libre (jamais exécutée) ;
 *  - section « Owner decisions » : identique à l'octet près ;
 *  - section « Roles » : mêmes acteurs, colonne d'attribution inchangée ;
 *  - section « Tasks » : mêmes tâches ; seules les colonnes status, blocker,
 *    version, ref, next_action peuvent changer, statut connu, `done` jamais
 *    rouvert, version jamais en baisse ;
 *  - section « Evidence » : ajout de lignes seulement (les anciennes lignes
 *    restent, dans l'ordre, en préfixe).
 */
import { TASK_STATUSES } from '../../collab/contracts';
import { parseStateDocument, type Block, type Section, type StateDocument, type TableBlock } from '../export/document';

export type ImportLevel = 'direct' | 'validate';

export interface StateDiffResult {
  level: ImportLevel;
  /** Raisons qui imposent la validation de Kevin (vide si direct). */
  reasons: string[];
  /** Résumé lisible des changements reconnus (affichable sur /owner). */
  changes: string[];
}

export const KNOWN_SECTIONS = ['Owner decisions', 'Roles', 'Tasks', 'Evidence'] as const;
/** Clés de contrôle librement modifiables par un import `direct`. */
export const FREE_HEADERS = ['revision', 'base_revision', 'next_action', 'based_on_sha'] as const;
/** Colonnes de la table Tasks librement modifiables par un import `direct`. */
export const FREE_TASK_COLUMNS = ['status', 'blocker', 'version', 'ref', 'next_action'] as const;
/** Colonnes de la table Tasks qui doivent exister (sinon validation). */
export const REQUIRED_TASK_COLUMNS = ['id', 'status', 'owner', 'reviewer', 'tester', 'owned_paths', 'dependencies', 'blocker', 'version', 'ref', 'next_action'] as const;
export const ROLES_ASSIGNMENT_COLUMN = 'Scoped acceptance/assignment';
const MAX_TABLE_ROWS = 1000;
const HEADER_KEY_RE = /^[a-z][a-z0-9_]*$/;

class Needs extends Error {}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Tri explicite par unités de code (indépendant de la locale). */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function fail(reason: string): never {
  throw new Needs(reason);
}

/** Clés de contrôle du préambule ; une clé dupliquée rend le document ambigu. */
function headersOf(document: StateDocument): Map<string, string> {
  const headers = new Map<string, string>();
  for (const block of document.preamble) {
    if (block.kind !== 'text') continue;
    for (const line of block.lines) {
      const colon = line.indexOf(':');
      if (colon < 1) continue;
      const key = line.slice(0, colon).trimEnd();
      if (!HEADER_KEY_RE.test(key)) continue;
      if (headers.has(key)) fail('clé de contrôle dupliquée : ' + key);
      headers.set(key, line.slice(colon + 1).trim());
    }
  }
  return headers;
}

function sectionsOf(document: StateDocument): Map<string, Section> {
  const names = document.sections.map(section => section.name);
  if (new Set(names).size !== names.length) fail('section dupliquée');
  if (!same(names, [...KNOWN_SECTIONS])) fail('sections attendues ' + KNOWN_SECTIONS.join(', ') + ' dans cet ordre, trouvées : ' + names.join(', '));
  return new Map(document.sections.map(section => [section.name, section]));
}

function tablesOf(blocks: Block[]): TableBlock[] {
  return blocks.filter((block): block is TableBlock => block.kind === 'table');
}

/** Tout ce qui n'est pas une table doit être identique ; renvoie l'unique table de chaque côté. */
function onlyTable(name: string, before: Section, after: Section): [TableBlock, TableBlock] {
  const otherBefore = before.blocks.filter(block => block.kind !== 'table');
  const otherAfter = after.blocks.filter(block => block.kind !== 'table');
  if (!same(otherBefore, otherAfter)) fail(name + ' : le texte hors table a changé');
  const tablesBefore = tablesOf(before.blocks);
  const tablesAfter = tablesOf(after.blocks);
  if (tablesBefore.length !== 1 || tablesAfter.length !== 1) fail(name + ' : une seule table attendue');
  const [b, a] = [tablesBefore[0], tablesAfter[0]];
  if (!same(b.headers, a.headers)) fail(name + ' : colonnes modifiées');
  if (new Set(b.headers).size !== b.headers.length) fail(name + ' : colonnes dupliquées');
  if (b.rows.length > MAX_TABLE_ROWS || a.rows.length > MAX_TABLE_ROWS) fail(name + ' : table trop longue');
  for (const row of [...b.rows, ...a.rows]) if (row.length !== b.headers.length) fail(name + ' : ligne mal formée');
  return [b, a];
}

function rowsById(table: TableBlock, name: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const row of table.rows) {
    if (!row[0]) fail(name + ' : identifiant vide');
    if (rows.has(row[0])) fail(name + ' : identifiant dupliqué ' + row[0]);
    rows.set(row[0], row);
  }
  return rows;
}

function checkHeaders(before: StateDocument, after: StateDocument, changes: string[]): void {
  const b = headersOf(before);
  const a = headersOf(after);
  if (!same([...b.keys()].sort(byCodeUnit), [...a.keys()].sort(byCodeUnit))) fail('clés de contrôle ajoutées ou retirées');
  const changed: string[] = [];
  for (const [key, value] of a) {
    if (b.get(key) === value) continue;
    if (!(FREE_HEADERS as readonly string[]).includes(key)) fail('clé de contrôle protégée modifiée : ' + key);
    changed.push(key);
  }
  const prev = Number(b.get('revision'));
  if (!Number.isSafeInteger(prev) || a.get('revision') !== String(prev + 1)) fail('revision doit valoir la précédente + 1');
  if (a.get('base_revision') !== String(prev)) fail('base_revision doit valoir la révision précédente');
  changes.push('en-tête : ' + changed.join(', '));
}

function checkRoles(before: Section, after: Section, changes: string[]): void {
  const [b, a] = onlyTable('Roles', before, after);
  const column = b.headers.indexOf(ROLES_ASSIGNMENT_COLUMN);
  if (column < 0) fail('Roles : colonne « ' + ROLES_ASSIGNMENT_COLUMN + ' » absente');
  const rowsBefore = rowsById(b, 'Roles');
  const rowsAfter = rowsById(a, 'Roles');
  if (!same([...rowsBefore.keys()].sort(byCodeUnit), [...rowsAfter.keys()].sort(byCodeUnit))) fail('Roles : acteurs ajoutés ou retirés');
  let touched = 0;
  for (const [actor, row] of rowsAfter) {
    const old = rowsBefore.get(actor)!;
    if (old[column] !== row[column]) fail('Roles : attribution modifiée pour ' + actor);
    if (!same(old, row)) touched += 1;
  }
  if (touched) changes.push('rôles : ' + touched + ' ligne(s) de preuves attendues');
}

function checkTasks(before: Section, after: Section, changes: string[]): void {
  const [b, a] = onlyTable('Tasks', before, after);
  for (const name of REQUIRED_TASK_COLUMNS) if (!b.headers.includes(name)) fail('Tasks : colonne absente ' + name);
  const rowsBefore = rowsById(b, 'Tasks');
  const rowsAfter = rowsById(a, 'Tasks');
  if (!same([...rowsBefore.keys()], [...rowsAfter.keys()])) fail('Tasks : tâches ajoutées, retirées ou réordonnées');
  const protectedColumns = b.headers.filter(name => !(FREE_TASK_COLUMNS as readonly string[]).includes(name));
  const status = b.headers.indexOf('status');
  const version = b.headers.indexOf('version');
  for (const [id, row] of rowsAfter) {
    const old = rowsBefore.get(id)!;
    if (same(old, row)) continue;
    const touched: string[] = [];
    for (const name of protectedColumns) {
      const index = b.headers.indexOf(name);
      if (old[index] !== row[index]) fail('Tasks : colonne protégée « ' + name + ' » modifiée pour ' + id);
    }
    for (const name of FREE_TASK_COLUMNS) {
      const index = b.headers.indexOf(name);
      if (old[index] !== row[index]) touched.push(name);
    }
    if (!(TASK_STATUSES as readonly string[]).includes(row[status])) fail('Tasks : statut inconnu pour ' + id);
    if (old[status] === 'done' && row[status] !== 'done') fail('Tasks : ' + id + ' ne peut pas être rouverte');
    const [oldVersion, newVersion] = [Number(old[version]), Number(row[version])];
    if (!Number.isSafeInteger(oldVersion) || !Number.isSafeInteger(newVersion) || newVersion < oldVersion) fail('Tasks : version invalide pour ' + id);
    changes.push('tâche ' + id + ' : ' + touched.join(', '));
  }
}

function checkEvidence(before: Section, after: Section, changes: string[]): void {
  const [b, a] = onlyTable('Evidence', before, after);
  if (a.rows.length < b.rows.length || !same(a.rows.slice(0, b.rows.length), b.rows)) fail('Evidence : les lignes existantes ont été modifiées ou retirées');
  if (a.rows.length > b.rows.length) changes.push('preuves : +' + (a.rows.length - b.rows.length) + ' ligne(s)');
}

/**
 * `previousMarkdown` : contenu du dernier import (null s'il n'y en a pas : un
 * premier import n'a aucune base à comparer, donc `validate`).
 */
export function classifyStateImport(previousMarkdown: string | null, nextMarkdown: string): StateDiffResult {
  const changes: string[] = [];
  try {
    if (previousMarkdown === null) fail('aucun état précédent à comparer');
    const before = parseStateDocument(previousMarkdown);
    const after = parseStateDocument(nextMarkdown);
    const sectionsBefore = sectionsOf(before);
    const sectionsAfter = sectionsOf(after);
    checkHeaders(before, after, changes);
    if (!same(tablesOf(before.preamble), tablesOf(after.preamble))) fail('préambule : table modifiée');
    if (!same(sectionsBefore.get('Owner decisions'), sectionsAfter.get('Owner decisions'))) fail('décisions du propriétaire modifiées');
    checkRoles(sectionsBefore.get('Roles')!, sectionsAfter.get('Roles')!, changes);
    checkTasks(sectionsBefore.get('Tasks')!, sectionsAfter.get('Tasks')!, changes);
    checkEvidence(sectionsBefore.get('Evidence')!, sectionsAfter.get('Evidence')!, changes);
    return { level: 'direct', reasons: [], changes };
  } catch (error) {
    // Fail-closed : une raison lisible pour nos refus, une raison générique pour tout le reste.
    const reason = error instanceof Needs ? error.message
      : error instanceof Error ? 'document refusé : ' + error.message.slice(0, 160) : 'document illisible ou imprévu';
    return { level: 'validate', reasons: [reason], changes };
  }
}
