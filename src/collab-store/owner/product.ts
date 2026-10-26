/**
 * CC-7 L6a (plan CC-PLAN-7 v0.2, S8) — « Nouveau produit » en un prompt.
 *
 * Un acte owner unique, depuis /owner seulement : à partir de l'objectif de Kevin
 * et de la liste des participants, le gabarit versionné ci-dessous (PRODUCT_TEMPLATE_VERSION)
 * produit le cycle complet, écrit dans UN SEUL lot CAS (ownerAppend) :
 * - l'événement owner.decision `create_product`, qui porte aussi l'état CC-STATE-1
 *   initial (clé `owner-state-import:<cycle>:product:…`) : il devient la base de
 *   collab_export et du contrôleur exactement comme un import d'état ;
 * - la phase P1 et le dépôt du produit sur la ligne `cycles` ;
 * - les définitions de phase P1–P6 (P1 → P2 quand chaque participant a scellé sa
 *   proposition, P2 → P3 quand chacun a critiqué, P3 → P4 quand la synthèse est
 *   déposée ; P4–P6 manuels : vote, validation P5 de Kevin, lots) ;
 * - une tâche de proposition par participant et la tâche de synthèse, avec une
 *   matrice D12 en rotation (auteur i, relecteur i+1, testeur i+2).
 *
 * Gardes (refus avant toute écriture, aucune écriture partielle) :
 * - porte PRODUCT_CREATE_ENABLED === 'true' (éteint par défaut) ;
 * - preuve owner directe seulement (jamais déléguée) ; arrêt d'urgence posé = refus ;
 * - cycle neuf (aucune ligne `cycles`, revérifié DANS le lot) ;
 * - 3 à 6 participants actifs, d'identités logiques toutes distinctes (#126), pour
 *   que chaque tâche ait trois familles distinctes ;
 * - rejouer le même formulaire est un duplicate, jamais un second cycle.
 *
 * Le contrôleur fait le reste : à l'entrée de chaque phase il réveille les agents
 * qui portent le rôle attendu (règles existantes, canal API L5a quand il est allumé).
 */
import { CollabStoreError } from '../store/collab-store';
import { sha256Hex } from '../store/hash';
import { ensureSchema } from '../store/schema';
import { loadLabelDirectory } from '../export/labels';
import { planStateImport } from '../export/state-import-plan';
import { STATE_IMPORT_KEY_PREFIX } from '../export/state-export';
import type { PhaseDefinition } from '../contracts';
import { normalizePhaseDefinitions, phaseDefinitionStatements } from './phase-install';
import { taskInsertStatements } from './state-import';
import { HALT_ACTIVE_SQL, isAutomationHalted } from './automation';
import { ownerAppend, type OwnerWriteResult } from './decisions';
import type { OwnerProof } from './proof';

export const PRODUCT_TEMPLATE_VERSION = 'CC-PRODUCT-1';
export const PRODUCT_MIN_PARTICIPANTS = 3;
export const PRODUCT_MAX_PARTICIPANTS = 6;
export const PRODUCT_GOAL_MAX_CHARS = 4000;
export const SYNTHESIS_TASK = 'synthesis';

const CYCLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function productCreateEnabled(env: { PRODUCT_CREATE_ENABLED?: string } | undefined): boolean {
  return env?.PRODUCT_CREATE_ENABLED === 'true';
}

export interface ProductInput {
  cycle_id: string;
  /** Objectif de Kevin, tel quel (1 à 4 000 caractères). */
  goal: string;
  /** Participants serveur, dans l'ordre de rotation ; le premier coordonne et rédige la synthèse. */
  participants: readonly string[];
  /** Dépôt du produit (owner/repo), facultatif. */
  repository?: string;
  /** SHA de départ du dépôt (7 à 40 hexadécimaux), facultatif ; absent = NO_BASE_SHA. */
  based_on_sha?: string;
}

/** SHA de départ quand l'owner n'en donne pas : l'état exige un SHA, celui-ci signifie « aucun ». */
export const NO_BASE_SHA = '0000000';
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export interface ProductTask {
  task_id: string;
  owner: string;
  reviewer: string;
  tester: string;
  status: 'accepted' | 'blocked';
  dependencies: string[];
  next_action: string;
}

export interface ProductPlan {
  cycle_id: string;
  goal: string;
  participants: string[];
  coordinator: string;
  repository: string;
  tasks: ProductTask[];
  definitions: PhaseDefinition[];
  /** État CC-STATE-1 initial (Markdown), base du cycle. */
  markdown: string;
}

export interface ProductResult extends OwnerWriteResult {
  cycle_id: string;
  template_version: string;
  content_sha256: string;
  definitions_sha256: string;
  tasks: string[];
}

function fail(code: string, message: string): never {
  throw new CollabStoreError(code, message);
}

/** Tâche de proposition d'un participant : `p-<id>`, caractères hors grammaire remplacés par « - ». */
export function proposalTaskId(participantId: string): string {
  return ('p-' + participantId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')).slice(0, 64).replace(/-+$/, '');
}

/** Objectif rendu sans rien qui puisse être lu comme section, tableau ou en-tête de l'état. */
function quotedGoal(goal: string): string[] {
  return goal.split('\n').map(line => '> ' + line.trimEnd());
}

function cell(value: string): string {
  return value.replace(/[|\n\r]/g, ' ').trim() || 'none';
}

/** Matrice D12 en rotation et définitions de phase du gabarit CC-PRODUCT-1 (fonction pure). */
export function planProduct(input: ProductInput): ProductPlan {
  const cycleId = input.cycle_id.trim();
  if (!CYCLE_RE.test(cycleId)) fail('PRODUCT_INVALID', 'Cycle : [a-z0-9][a-z0-9_-]{0,63}.');
  const goal = input.goal.replace(/\r/g, '').trim();
  if (!goal || goal.length > PRODUCT_GOAL_MAX_CHARS) {
    fail('PRODUCT_INVALID', 'Objectif : 1 à ' + PRODUCT_GOAL_MAX_CHARS + ' caractères.');
  }
  const participants = input.participants.map(item => item.trim()).filter(Boolean);
  if (participants.length < PRODUCT_MIN_PARTICIPANTS || participants.length > PRODUCT_MAX_PARTICIPANTS) {
    fail('PRODUCT_PARTICIPANTS', PRODUCT_MIN_PARTICIPANTS + ' à ' + PRODUCT_MAX_PARTICIPANTS
      + ' participants sont requis (trois familles distinctes par tâche).');
  }
  if (new Set(participants).size !== participants.length) fail('PRODUCT_PARTICIPANTS', 'Un participant apparaît deux fois.');
  const repository = (input.repository ?? '').trim();
  if (repository && !REPOSITORY_RE.test(repository)) fail('PRODUCT_INVALID', 'Dépôt : owner/repo.');
  const basedOn = (input.based_on_sha ?? '').trim() || NO_BASE_SHA;
  if (!SHA_RE.test(basedOn)) fail('PRODUCT_INVALID', 'SHA de départ : 7 à 40 caractères hexadécimaux.');

  const n = participants.length;
  const ids = participants.map(proposalTaskId);
  if (ids.some(id => id === SYNTHESIS_TASK || id.length < 3) || new Set(ids).size !== n) {
    fail('PRODUCT_PARTICIPANTS', 'Deux participants donnent la même tâche de proposition : ' + ids.join(', '));
  }
  const at = (index: number): string => participants[index % n];
  const tasks: ProductTask[] = participants.map((owner, index) => ({
    task_id: ids[index], owner, reviewer: at(index + 1), tester: at(index + 2), status: 'accepted', dependencies: [],
    next_action: 'P1: research then submit ONE sealed proposal (proposal.submit with task ' + ids[index] + ')',
  }));
  tasks.push({
    task_id: SYNTHESIS_TASK, owner: at(0), reviewer: at(1), tester: at(2), status: 'blocked', dependencies: [...ids],
    next_action: 'P3: the coordinator submits the synthesis as proposal.submit (task synthesis)',
  });

  const definitions = normalizePhaseDefinitions(cycleId, JSON.stringify([
    { phase: 'P1', auto_advance: 'product-p1', expected_outputs: [{ role: 'author', kind: 'proposal.submit', count: n }] },
    { phase: 'P2', auto_advance: 'product-p2', expected_outputs: [{ role: 'reviewer', kind: 'evidence.add', count: n }] },
    { phase: 'P3', auto_advance: 'product-p3',
      expected_outputs: [{ role: 'author', kind: 'proposal.submit', count: 1, task_id: SYNTHESIS_TASK }] },
    { phase: 'P4' }, { phase: 'P5' }, { phase: 'P6' },
  ]));

  const markdown = [
    '# Nouveau produit ' + cycleId + ' state',
    'schema_version: CC-STATE-1',
    'workflow_id: ' + cycleId,
    'revision: 2',
    'base_revision: 1',
    'next_action: P1 open. Each participant researches, then submits ONE sealed proposal on its own task without reading the others.'
      + ' P1->P2 when all proposals are sealed; P2 = cross critique (evidence.add as reviewer); P3 = synthesis by the coordinator;'
      + ' P4 vote; P5 owner validation; P6 lots. No main/master, no production, no paid spend without the owner.',
    'canonical_ref: main',
    'based_on_sha: ' + basedOn,
    'phase: P1',
    'framing_version: ' + PRODUCT_TEMPLATE_VERSION,
    'framing_ref: none',
    'plan_version: none',
    'plan_ref: none',
    'execution_ref: none',
    'contract_ref: none',
    'acceptance_ref: none',
    '',
    'Revision 1 is the owner prompt (/owner, « Nouveau produit »); revision 2 is the cycle created from the versioned template '
      + PRODUCT_TEMPLATE_VERSION + ' at P1 start.',
    '',
    '## Objective',
    ...quotedGoal(goal),
    '',
    '## Owner decisions',
    '- Owner, /owner create_product: open this cycle with the objective above' + (repository ? ' for ' + repository : '') + '.',
    'The owner alone decides waivers, gate acceptance, merges to main or master, promotion, deployment, API keys and paid spend.',
    '',
    '## Roles',
    '| Actor | Scoped acceptance/assignment | Pending evidence |',
    '| --- | --- | --- |',
    '| Owner | owner | Validate the plan at P5; set API keys and budget; merges to main or master |',
    ...participants.map((pid, index) => '| ' + cell(pid) + ' | ' + cell((index === 0 ? 'coordinator; author synthesis; ' : '')
      + 'author ' + ids[index] + '; reviewer ' + ids[(index + n - 1) % n] + '; tester ' + ids[(index + n - 2) % n]) + ' | Sealed P1 proposal |'),
    '',
    '## Tasks',
    '| id | status | owner | role | reviewer | tester | owned_paths | dependencies | blocker | version | ref | next_action |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...tasks.map(task => '| ' + [task.task_id, task.status, task.owner, 'author', task.reviewer, task.tester, 'none',
      task.dependencies.length ? task.dependencies.join(', ') : 'none', task.status === 'blocked' ? 'P2 not done' : 'none',
      '1', cell(repository), cell(task.next_action)].join(' | ') + ' |'),
  ].join('\n') + '\n';

  return { cycle_id: cycleId, goal, participants, coordinator: at(0), repository, tasks, definitions, markdown };
}

/** Acte owner « Nouveau produit » : un seul lot CAS, ou rien. */
export async function createProduct(db: D1Database, input: ProductInput & {
  enabled: boolean;
  proof: OwnerProof;
  now?: () => Date;
}): Promise<ProductResult> {
  if (!input.enabled) fail('PRODUCT_CREATE_DISABLED', 'Nouveau produit éteint (PRODUCT_CREATE_ENABLED ≠ true).');
  if (input.proof.kind === 'delegated') fail('DELEGATED_FORBIDDEN', 'Nouveau produit : acte owner direct seulement.');
  await ensureSchema(db);
  const plan = planProduct(input);

  const directory = await loadLabelDirectory(db);
  const inactive = plan.participants.filter(pid => !directory.byPid.has(pid));
  if (inactive.length) fail('PRODUCT_PARTICIPANTS', 'Participants non enregistrés ou inactifs : ' + inactive.join(', '));
  const logical = plan.participants.map(pid => directory.logicalByPid.get(pid) ?? pid);
  if (new Set(logical).size !== logical.length) {
    fail('PRODUCT_FAMILIES', 'Deux participants partagent une identité logique (#126) : une famille = une voix.');
  }
  // Même validation qu'un import d'état (libellés, D12 par tâche, tableau des tâches).
  const state = await planStateImport({ cycle_id: plan.cycle_id, markdown: plan.markdown, directory, target: null });
  const definitionsSha = await sha256Hex(JSON.stringify(plan.definitions.map(def =>
    [def.phase, def.entry_conditions, def.expected_outputs, def.exit_conditions, def.auto_advance])));
  const key = STATE_IMPORT_KEY_PREFIX + plan.cycle_id + ':product:' + state.content_sha256.slice(0, 32);
  const summary = (result: OwnerWriteResult): ProductResult => ({ ...result, cycle_id: plan.cycle_id,
    template_version: PRODUCT_TEMPLATE_VERSION, content_sha256: state.content_sha256, definitions_sha256: definitionsSha,
    tasks: state.tasks.map(task => task.task_id) });

  // Rejeu du même formulaire : l'acte d'origine, sans second cycle.
  const replay = await db.prepare('SELECT * FROM events WHERE idempotency_key = ?1').bind(key).first();
  if (!replay) {
    if (await db.prepare('SELECT 1 AS ok FROM cycles WHERE cycle_id = ?1').bind(plan.cycle_id).first()) {
      fail('PRODUCT_CYCLE_EXISTS', 'Le cycle ' + plan.cycle_id + ' existe déjà : choisissez un nouvel identifiant.');
    }
    if (await isAutomationHalted(db)) fail('AUTOMATION_HALTED', 'Arrêt d’urgence posé : levez-le avant de créer un produit.');
  }

  try {
    return summary(await ownerAppend(db, {
      cycleId: plan.cycle_id,
      key,
      payload: {
        action: 'create_product', template_version: PRODUCT_TEMPLATE_VERSION, cycle_id: plan.cycle_id,
        goal: plan.goal, participants: plan.participants, coordinator: plan.coordinator, repository: plan.repository,
        definitions_sha256: definitionsSha, definitions: plan.definitions.map(({ cycle_id: _cycle, ...def }) => def),
        // Champs d'un import d'état : l'acte est la base CC-STATE-1 du cycle (collab_export, contrôleur).
        workflow_id: state.workflow_id, state_revision: state.state_revision, content_sha256: state.content_sha256,
        owner_label: state.owner_label, target: null, issue_refs: [], previous_import_seq: null, content: state.content,
      },
      proof: input.proof,
      // Revérifié dans le lot : cycle toujours neuf (seule la ligne créée par ce lot) et aucun arrêt d'urgence.
      extraGuard: { sql: 'NOT EXISTS (SELECT 1 FROM cycles WHERE cycle_id = ?4) AND NOT ' + HALT_ACTIVE_SQL, binds: [plan.cycle_id] },
      sideEffects: () => [
        db.prepare("UPDATE cycles SET phase = 'P1', project = ?2, status = 'open' WHERE cycle_id = ?1").bind(plan.cycle_id, plan.repository),
        ...phaseDefinitionStatements(db, plan.cycle_id, plan.definitions),
        ...taskInsertStatements(db, plan.cycle_id, state.tasks),
      ],
      now: input.now,
    }));
  } catch (error) {
    if (error instanceof CollabStoreError && error.code === 'OWNER_PRECONDITION_FAILED') {
      fail('PRODUCT_CYCLE_EXISTS', 'Le cycle ' + plan.cycle_id + ' a été créé ou l’arrêt d’urgence posé entre-temps : rien n’est écrit.');
    }
    throw error;
  }
}
