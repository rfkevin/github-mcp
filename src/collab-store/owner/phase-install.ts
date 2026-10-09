/**
 * CC-3 CR-A / CR-03 — owner bootstrap of a cycle's phase definitions (I7).
 *
 * Until this path existed, `phase_definitions` rows could only be written by
 * SQL: a new cycle created through MCP could never advance
 * (PHASE_DEFINITION_MISSING). Installing them is an owner act, like the state
 * import: one owner.decision event (action install_phases) in the same CAS
 * batch as its side effects, from the /owner route only.
 *
 * - Every definition is validated by the C1 contract (validatePhaseDefinition).
 * - Omitted fields default to the safe value: no conditions, no expected
 *   output, `auto_advance: none`. An empty submission installs P1–P6 with
 *   `none`: nothing advances until the owner names a policy for a phase.
 * - The submitted set replaces the cycle's whole set (explicit, auditable).
 * - Idempotent: re-installing the set currently installed is a duplicate.
 */
import { assertPhase, StateContractError, type Phase } from '../../collab/contracts';
import { validatePhaseDefinition, type PhaseDefinition } from '../contracts';
import { CollabStoreError, type StoredStoreEvent } from '../store/collab-store';
import { sha256Hex } from '../store/hash';
import { ensureSchema } from '../store/schema';
import { ownerAppend, type OwnerWriteResult } from './decisions';
import type { OwnerProof } from './proof';

export const PHASE_INSTALL_KEY_PREFIX = 'owner:phases:';
const PHASES: readonly Phase[] = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
const CYCLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const POLICY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MAX_DEFINITIONS_BYTES = 32_768;
const MAX_ITEMS = 32;

type PhaseInput = Partial<Omit<PhaseDefinition, 'cycle_id'>> & { phase?: unknown };

export interface PhaseInstallResult extends OwnerWriteResult {
  definitions_sha256: string;
  phases: Array<{ phase: Phase; auto_advance: string }>;
}

function invalid(message: string): never {
  throw new CollabStoreError('INVALID_PHASE_DEFINITIONS', message);
}

function strings(value: unknown, field: string, phase: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS || !value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 200)) {
    invalid(phase + ' : ' + field + ' doit être une liste de 0 à ' + MAX_ITEMS + ' chaînes non vides (≤ 200).');
  }
  return value as string[];
}

/** Parses the owner's JSON (array of definitions); empty → P1–P6 with auto_advance none. */
export function normalizePhaseDefinitions(cycleId: string, source: string): PhaseDefinition[] {
  if (!CYCLE_RE.test(cycleId)) {
    throw new StateContractError('INVALID_CYCLE_ID', 'cycle_id must match [a-z0-9][a-z0-9_-]{0,63}', 'cycle_id');
  }
  if (new TextEncoder().encode(source).length > MAX_DEFINITIONS_BYTES) invalid('Définitions trop volumineuses (≤ 32 Kio).');
  const text = source.trim();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : PHASES.map(phase => ({ phase }));
  } catch {
    invalid('JSON illisible : une liste de définitions de phase est attendue.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > PHASES.length) {
    invalid('Une liste de 1 à 6 définitions de phase est attendue.');
  }
  const seen = new Set<string>();
  const definitions = (parsed as PhaseInput[]).map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('Chaque définition doit être un objet.');
    const phase = String(item.phase ?? '');
    assertPhase(phase);
    if (seen.has(phase)) invalid('Phase ' + phase + ' définie deux fois.');
    seen.add(phase);
    const autoAdvance = item.auto_advance === undefined ? 'none' : item.auto_advance;
    if (typeof autoAdvance !== 'string' || (autoAdvance !== 'none' && !POLICY_RE.test(autoAdvance))) {
      invalid(phase + ' : auto_advance doit valoir « none » ou un identifiant de policy [A-Za-z0-9_.:-], 64 caractères au plus.');
    }
    const outputs = item.expected_outputs ?? [];
    if (!Array.isArray(outputs) || outputs.length > MAX_ITEMS) invalid(phase + ' : expected_outputs doit être une liste.');
    return validatePhaseDefinition({
      cycle_id: cycleId,
      phase: phase as Phase,
      entry_conditions: strings(item.entry_conditions, 'entry_conditions', phase),
      exit_conditions: strings(item.exit_conditions, 'exit_conditions', phase),
      expected_outputs: outputs.map(out => ({ role: String(out?.role ?? ''), kind: String(out?.kind ?? ''), count: Number(out?.count) })),
      auto_advance: autoAdvance,
    });
  });
  return definitions.sort((a, b) => a.phase.localeCompare(b.phase));
}

function canonical(definitions: PhaseDefinition[]): string {
  return JSON.stringify(definitions.map(def => [def.phase, def.entry_conditions, def.expected_outputs, def.exit_conditions, def.auto_advance]));
}

export async function installPhaseDefinitions(db: D1Database, input: {
  cycle_id: string;
  definitions: string;
  proof: OwnerProof;
  now?: () => Date;
}): Promise<PhaseInstallResult> {
  await ensureSchema(db);
  const cycleId = input.cycle_id.trim();
  const definitions = normalizePhaseDefinitions(cycleId, input.definitions);
  const digest = await sha256Hex(canonical(definitions));
  const summary = definitions.map(def => ({ phase: def.phase, auto_advance: def.auto_advance }));
  const previous = await db.prepare(
    "SELECT * FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND idempotency_key LIKE ?2 ORDER BY seq DESC LIMIT 1",
  ).bind(cycleId, PHASE_INSTALL_KEY_PREFIX + cycleId + ':%').first<StoredStoreEvent>();
  if (previous && (JSON.parse(previous.payload_json) as { definitions_sha256?: string }).definitions_sha256 === digest) {
    return { status: 'duplicate', event: previous, definitions_sha256: digest, phases: summary };
  }
  // The previous install seq is part of the key: a double submit is a duplicate,
  // while re-installing an older set after a newer one is a new owner act.
  const key = PHASE_INSTALL_KEY_PREFIX + cycleId + ':' + (previous?.seq ?? 0) + ':' + digest.slice(0, 32);
  const result = await ownerAppend(db, {
    cycleId,
    key,
    payload: { action: 'install_phases', cycle_id: cycleId, definitions_sha256: digest, previous_install_seq: previous?.seq ?? null,
      definitions: definitions.map(({ cycle_id: _cycle, ...def }) => def) },
    proof: input.proof,
    sideEffects: () => [
      db.prepare('DELETE FROM phase_definitions WHERE cycle_id = ?1').bind(cycleId),
      ...definitions.map(def => db.prepare([
        'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      ].join(' ')).bind(cycleId, def.phase, JSON.stringify(def.entry_conditions), JSON.stringify(def.expected_outputs),
        JSON.stringify(def.exit_conditions), def.auto_advance)),
    ],
    now: input.now,
  });
  return { ...result, definitions_sha256: digest, phases: summary };
}
