/**
 * CC-3 CR-B (contre-revue Codex github-mcp#79, CR-02) — dispatch public du
 * lifecycle mémoire C4 sur le journal collab_append_event.
 *
 * Les événements memory.propose / memory.review / memory.consolidate /
 * memory.retire portent leurs effets memory_entries DANS le même batch CAS que
 * l'append du journal (CollabStore.appendEvent) : un append « applied »
 * garantit toujours son effet mémoire (champ memory de la sortie), un append
 * refusé n'écrit rien du tout — ni journal, ni mémoire.
 *
 * Identité serveur (C5/I8) : l'auteur est le participant dérivé du jeton de
 * l'appelant ; memory.review exige un reviewer distinct de l'auteur ; les
 * kinds protégés (invariant, decision) exigent une décision owner liée au
 * sujet exact (C4). Toutes les pré-vérifications sont read-only : la façade
 * peut être rejouée pour re-diagnostiquer un échec sur l'état durable.
 *
 * Pas d'import depuis store/collab-store ici (le store importe ce module) :
 * les erreurs typées restent MemoryStoreError / StateContractError.
 */
import { MemoryStore, MemoryStoreError, type MemoryMutation, type ProposeInput } from './memory-store';
import type { StoreEvent } from '../contracts';
import type { MemoryConfidence, MemoryKind } from '../contracts/memory';

const MEMORY_EVENT_TYPES = new Set(['memory.propose', 'memory.review', 'memory.consolidate', 'memory.retire']);

/** Un type d'événement du journal porte un effet lifecycle mémoire C4 (CR-02). */
export function isMemoryEventType(type: string): boolean {
  return MEMORY_EVENT_TYPES.has(type);
}

function memoryPayload(event: StoreEvent): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.payload_json);
  } catch {
    throw new MemoryStoreError(
      'INVALID_MEMORY_PAYLOAD',
      `payload_json doit être un objet JSON valide avec une clé memory pour ${event.type}.`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MemoryStoreError(
      'INVALID_MEMORY_PAYLOAD',
      `payload_json doit être un objet JSON avec une clé memory pour ${event.type}.`,
    );
  }
  const memory = (parsed as Record<string, unknown>).memory;
  if (typeof memory !== 'object' || memory === null || Array.isArray(memory)) {
    throw new MemoryStoreError(
      'INVALID_MEMORY_PAYLOAD',
      `payload_json.memory est requis (objet) pour ${event.type}.`,
    );
  }
  return memory as Record<string, unknown>;
}

function requiredString(memory: Record<string, unknown>, key: string, type: string): string {
  const value = memory[key];
  if (typeof value !== 'string' || !value) {
    throw new MemoryStoreError(
      'INVALID_MEMORY_PAYLOAD',
      `${type} : memory.${key} doit être une chaîne non vide.`,
    );
  }
  return value;
}

function optionalString(memory: Record<string, unknown>, key: string, type: string): string | undefined {
  const value = memory[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) {
    throw new MemoryStoreError(
      'INVALID_MEMORY_PAYLOAD',
      `${type} : memory.${key} doit être une chaîne non vide.`,
    );
  }
  return value;
}

function stringArray(memory: Record<string, unknown>, key: string, type: string, required: boolean): string[] {
  const value = memory[key];
  if (value === undefined) {
    if (required) {
      throw new MemoryStoreError(
        'INVALID_MEMORY_PAYLOAD',
        `${type} : memory.${key} est requis (tableau de chaînes non vides).`,
      );
    }
    return [];
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item)) {
    throw new MemoryStoreError(
      'INVALID_MEMORY_PAYLOAD',
      `${type} : memory.${key} doit être un tableau non vide de chaînes non vides.`,
    );
  }
  return value as string[];
}

function optionalInt(memory: Record<string, unknown>, key: string, type: string, min: number): number | undefined {
  const value = memory[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new MemoryStoreError(
      'INVALID_MEMORY_PAYLOAD',
      `${type} : memory.${key} doit être un entier >= ${min}.`,
    );
  }
  return value;
}

/**
 * CRB-R1 (revue Sol, github-mcp#79/6086862463) : les scopes `participant:<id>`
 * sont la mémoire privée d'un participant — memory.propose ne peut viser que le
 * scope de l'appelant (MEMORY_SCOPE_FORBIDDEN sinon, avant tout batch : un
 * refus n'écrit rien du tout). La revue par un pair distinct reste ouverte
 * (activation C4) et les scopes partagés (common/project/role/task) restent
 * collaboratifs. Délégation ou dérogation : owner.request (C5).
 */
function assertScopeOwnership(scope: string, participantId: string, type: string): void {
  if (scope.startsWith('participant:') && scope !== `participant:${participantId}`) {
    throw new MemoryStoreError(
      'MEMORY_SCOPE_FORBIDDEN',
      `${type} : le scope ${scope} est la mémoire privée d'un autre participant (CRB-R1).`,
    );
  }
}

/**
 * Pré-vérifications typées + statements du lifecycle mémoire d'un événement du
 * journal, SANS exécution : le caller (CollabStore.appendEvent) fusionne les
 * statements dans son propre batch CAS. Read-only ici — rejouer la fonction
 * re-diagnostique l'échec sur l'état durable (catch du caller).
 */
export async function prepareMemoryEvent(
  db: D1Database,
  event: StoreEvent,
  nextRevision: number,
): Promise<MemoryMutation> {
  const memory = memoryPayload(event);
  const store = new MemoryStore(db);
  if (event.type === 'memory.propose') {
    // CRB-R1 (revue Sol) : le scope participant visé doit être celui de l'appelant.
    const scope = requiredString(memory, 'scope', event.type);
    assertScopeOwnership(scope, event.participant_id, event.type);
    const input: ProposeInput = {
      id: optionalString(memory, 'id', event.type),
      scope,
      kind: requiredString(memory, 'kind', event.type) as MemoryKind,
      text: requiredString(memory, 'text', event.type),
      evidence_refs: stringArray(memory, 'evidence_refs', event.type, false),
      // CR-B : le defaut 'hypothesis' est normalise ICI, pas dans preparePropose,
      // pour qu'un kind protege propose sans confidence explicite recoive le
      // diagnostic exact HYPOTHESIS_NOT_RULE (jamais un PROTECTED_KIND_OWNER_REQUIRED trompeur).
      confidence: (optionalString(memory, 'confidence', event.type) ?? 'hypothesis') as MemoryConfidence,
      author_pid: event.participant_id,
      expires_rev: optionalInt(memory, 'expires_rev', event.type, 1),
      owner_decision_ref: optionalString(memory, 'owner_decision_ref', event.type),
      cycle_rev: nextRevision,
      // CR-F04 (#96) : l'échéance d'une hypothèse est une révision de CE cycle.
      cycle_id: event.cycle_id,
    };
    return store.preparePropose(input);
  }
  if (event.type === 'memory.review') {
    const version = optionalInt(memory, 'version', event.type, 1);
    if (version === undefined) {
      throw new MemoryStoreError(
        'INVALID_MEMORY_PAYLOAD',
        `${event.type} : memory.version est requis (entier >= 1).`,
      );
    }
    return store.prepareActivation(
      requiredString(memory, 'id', event.type),
      version,
      event.participant_id,
      event.cycle_id,
      // CR-F04 : une hypothèse échue à cette révision n'est pas activée.
      nextRevision,
    );
  }
  if (event.type === 'memory.consolidate') {
    return store.prepareSupersede(
      requiredString(memory, 'id', event.type),
      event.participant_id,
      requiredString(memory, 'text', event.type),
      stringArray(memory, 'evidence_refs', event.type, true),
      optionalString(memory, 'kind', event.type) as MemoryKind | undefined,
      optionalString(memory, 'confidence', event.type) as MemoryConfidence | undefined,
      optionalString(memory, 'owner_decision_ref', event.type),
      // CRB-R1 : l'appelant ne consolide que son scope participant (garde store).
      event.participant_id,
      // CR-F03 (#95) : une consolidation qui HAUSSE la confiance exige une preuve
      // de registre NOUVELLE d'un pair distinct (peer_evidence_ref), sinon le
      // refus est pré-batch : rien n'est écrit, ni journal ni mémoire.
      optionalString(memory, 'peer_evidence_ref', event.type),
      // CR-F04 (#96) : une consolidation restée hypothesis repart pour une
      // fenêtre complète depuis CE cycle (renouvellement contrôlé).
      event.cycle_id,
      nextRevision,
    );
  }
  if (event.type === 'memory.retire') {
    return store.prepareRetire(
      requiredString(memory, 'id', event.type),
      optionalInt(memory, 'version', event.type, 1),
      event.cycle_id,
      optionalString(memory, 'owner_decision_ref', event.type),
      // CRB-R1 : l'appelant ne retire que son scope participant (garde store).
      event.participant_id,
    );
  }
  throw new MemoryStoreError(
    'INVALID_MEMORY_PAYLOAD',
    `Type ${event.type} hors lifecycle mémoire (memory.propose / memory.review / memory.consolidate / memory.retire).`,
  );
}
