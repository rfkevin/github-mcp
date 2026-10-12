/**
 * CC-4 A2 (plan §8, exigence Kevin project-mcp-collab#41 6114249479) —
 * demandes owner EXÉCUTABLES : l'agent prépare l'acte, le propriétaire ne
 * colle plus rien, il approuve ou refuse sur /owner.
 *
 * Une demande exécutable est un owner.request dont le payload porte :
 *   request_id, summary, action (install_phases | import_state), params,
 *   payload_sha256 = sha256(JSON canonique {action, params}),
 *   preconditions.previous_seq (dernier acte du même type sur le cycle cible
 *   au dépôt, null s'il n'y en a pas), reason, risk, rollback, et en option
 *   expires_at (secondes Unix) et max_cost_cents.
 *
 * Approuver : empreinte recalculée ET égale à celle affichée dans le
 * formulaire, demande non expirée, précondition vraie dans la transaction →
 * l'acte EXACT est exécuté et la décision enregistrée dans le même lot
 * (owner/binding.ts). Tout écart : aucun effet, diagnostic lisible. Refuser
 * reste une décision simple (decisions.ts) ; silence ou expiration = rien.
 */
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { sha256Hex } from '../store/hash';
import { STATE_IMPORT_KEY_PREFIX } from '../export/state-export';
import { parseExportTarget } from '../export/state-import-plan';
import { decidedRequestOf, recordOwnerDecision, resolveRequestTarget, type Decision, type OwnerWriteResult, type PendingPage, type PendingRequest } from './decisions';
import { installPhaseDefinitions, normalizePhaseDefinitions, PHASE_INSTALL_KEY_PREFIX } from './phase-install';
import { importStateSnapshot } from './state-import';
import type { OwnerProof } from './proof';
import type { PauseOccurrence } from '../memory/pause-resume';

export const EXECUTABLE_ACTIONS = ['install_phases', 'import_state'] as const;
export type ExecutableAction = (typeof EXECUTABLE_ACTIONS)[number];
const SHA_RE = /^[0-9a-f]{64}$/;
const CYCLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_TEXT = 2000;
// Le payload d'un événement est borné à 64 Kio (contrat C1) : l'état transporté par une demande l'est donc aussi.
const MAX_MARKDOWN = 60_000;

export interface ExecutableRequest {
  request_id: string;
  action: ExecutableAction;
  params: Record<string, unknown>;
  cycle_id: string;
  payload_sha256: string;
  previous_seq: number | null;
  reason: string;
  risk: string;
  rollback: string;
  expires_at: number | null;
  max_cost_cents: number;
}

export type ParsedRequest =
  | { kind: 'plain' }
  | { kind: 'executable'; request: ExecutableRequest }
  | { kind: 'invalid'; reason: string };

/** Ordre par unités de code UTF-16 (celui de JSON canonique), explicite et indépendant de la locale. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** JSON canonique : clés triées récursivement, sans espaces (empreinte stable, indépendante de l'ordre). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value as Record<string, unknown>).sort(byCodeUnit)
      .map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

/** Empreinte du payload exécutable : ce que le propriétaire approuve, à l'octet près. */
export async function executablePayloadSha256(action: string, params: unknown): Promise<string> {
  return sha256Hex(canonicalJson({ action, params }));
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) {
    throw new Error(field + ' : texte requis (1 à ' + MAX_TEXT + ' caractères).');
  }
  return value;
}

function validateParams(action: ExecutableAction, params: Record<string, unknown>): string {
  const cycleId = params.cycle_id;
  if (typeof cycleId !== 'string' || !CYCLE_RE.test(cycleId)) throw new Error('params.cycle_id invalide.');
  if (action === 'install_phases') {
    if (typeof params.definitions !== 'string') throw new Error('params.definitions : JSON des définitions (chaîne) requis.');
    normalizePhaseDefinitions(cycleId, params.definitions);
    const extra = Object.keys(params).filter(key => !['cycle_id', 'definitions'].includes(key));
    if (extra.length) throw new Error('params : champs inconnus ' + extra.join(', ') + '.');
  } else {
    if (typeof params.markdown !== 'string' || !params.markdown.trim() || params.markdown.length > MAX_MARKDOWN) {
      throw new Error('params.markdown : contenu CC-STATE-1 requis (≤ 60 000 caractères).');
    }
    if (params.owner_label !== undefined && (typeof params.owner_label !== 'string' || params.owner_label.length > 80)) {
      throw new Error('params.owner_label invalide.');
    }
    const target = params.target;
    if (target !== undefined && target !== null) {
      const t = target as Record<string, unknown>;
      if (typeof t !== 'object' || typeof t.repository !== 'string' || typeof t.path !== 'string' || typeof t.ref !== 'string'
        || !parseExportTarget(t.repository, t.path, t.ref)) {
        throw new Error('params.target : {repository, path, ref} valides attendus, ou absent.');
      }
    }
    const extra = Object.keys(params).filter(key => !['cycle_id', 'markdown', 'owner_label', 'target'].includes(key));
    if (extra.length) throw new Error('params : champs inconnus ' + extra.join(', ') + '.');
  }
  return cycleId;
}

/** Classe le payload d'une demande : simple (décision seule), exécutable valide, ou exécutable invalide (non décidable). */
export async function parseOwnerRequest(payloadJson: string): Promise<ParsedRequest> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return { kind: 'plain' };
  }
  if (!payload || typeof payload !== 'object' || payload.action === undefined) return { kind: 'plain' };
  try {
    const action = payload.action;
    if (!EXECUTABLE_ACTIONS.includes(action as ExecutableAction)) throw new Error('action inconnue (install_phases ou import_state).');
    const params = payload.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params : objet requis.');
    const cycleId = validateParams(action as ExecutableAction, params as Record<string, unknown>);
    const declared = payload.payload_sha256;
    if (typeof declared !== 'string' || !SHA_RE.test(declared)) throw new Error('payload_sha256 : 64 caractères hexadécimaux requis.');
    const computed = await executablePayloadSha256(action as string, params);
    if (computed !== declared) throw new Error('payload_sha256 ne correspond pas au payload (recalculé : ' + computed.slice(0, 12) + '…).');
    const pre = payload.preconditions as Record<string, unknown> | undefined;
    const previous = pre?.previous_seq;
    if (!pre || !(previous === null || (Number.isSafeInteger(previous) && (previous as number) > 0))) {
      throw new Error('preconditions.previous_seq : seq du dernier acte du même type sur le cycle, ou null.');
    }
    const expires = payload.expires_at;
    if (expires !== undefined && !(Number.isSafeInteger(expires) && (expires as number) > 0)) throw new Error('expires_at : secondes Unix.');
    const cost = payload.max_cost_cents ?? 0;
    if (!Number.isSafeInteger(cost) || (cost as number) < 0) throw new Error('max_cost_cents : entier >= 0.');
    return { kind: 'executable', request: {
      request_id: String(payload.request_id ?? ''), action: action as ExecutableAction, params: params as Record<string, unknown>,
      cycle_id: cycleId, payload_sha256: declared, previous_seq: (previous as number | null),
      reason: text(payload.reason, 'reason'), risk: text(payload.risk, 'risk'), rollback: text(payload.rollback, 'rollback'),
      expires_at: (expires as number | undefined) ?? null, max_cost_cents: cost as number,
    } };
  } catch (error) {
    return { kind: 'invalid', reason: error instanceof Error ? error.message : 'payload exécutable invalide.' };
  }
}

/** seq du dernier acte du même type sur le cycle (précondition à indiquer dans une demande). */
export async function latestOwnerActSeq(db: D1Database, action: ExecutableAction, cycleId: string): Promise<number | null> {
  await ensureSchema(db);
  const prefix = (action === 'install_phases' ? PHASE_INSTALL_KEY_PREFIX : STATE_IMPORT_KEY_PREFIX) + cycleId + ':';
  const row = await db.prepare("SELECT MAX(seq) AS seq FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND substr(idempotency_key, 1, length(?2)) = ?2")
    .bind(cycleId, prefix).first<{ seq: number | null }>();
  return row?.seq ?? null;
}

export interface ExecutableView {
  action?: ExecutableAction;
  cycle_id?: string;
  payload_sha256?: string;
  previous_seq?: number | null;
  reason?: string;
  risk?: string;
  rollback?: string;
  expires_at?: number | null;
  expired?: boolean;
  max_cost_cents?: number;
  preview?: string;
  invalid?: string;
}

export type PendingWithExecutable = PendingRequest & { executable?: ExecutableView };
export type DescribedPendingPage = Omit<PendingPage, 'items'> & { items: PendingWithExecutable[] };

/** Complète une page de demandes avec le détail exécutable affiché sur /owner (rien n'est exécuté ici). */
export async function describePending(page: PendingPage, now: () => Date = () => new Date()): Promise<DescribedPendingPage> {
  const at = Math.floor(now().getTime() / 1000);
  const items: PendingWithExecutable[] = [];
  for (const item of page.items) {
    const parsed = item.payload_json ? await parseOwnerRequest(item.payload_json) : { kind: 'plain' as const };
    if (parsed.kind === 'plain') { items.push(item); continue; }
    if (parsed.kind === 'invalid') { items.push({ ...item, executable: { invalid: parsed.reason } }); continue; }
    const req = parsed.request;
    const body = req.action === 'install_phases' ? String(req.params.definitions) : String(req.params.markdown);
    items.push({ ...item, executable: {
      action: req.action, cycle_id: req.cycle_id, payload_sha256: req.payload_sha256, previous_seq: req.previous_seq,
      reason: req.reason, risk: req.risk, rollback: req.rollback, expires_at: req.expires_at,
      expired: req.expires_at !== null && at > req.expires_at, max_cost_cents: req.max_cost_cents,
      preview: body.length > 4000 ? body.slice(0, 4000) + '\n… (' + body.length + ' caractères au total)' : body,
    } });
  }
  return { ...page, items };
}

export interface OwnerDecisionOutcome extends OwnerWriteResult {
  decision: Decision;
  memory_resume?: PauseOccurrence;
  executed?: { action: ExecutableAction; cycle_id: string; detail: string };
}

/**
 * Point d'entrée du bouton Approuver/Refuser de /owner. Une demande simple ou
 * un refus : décision seule (recordOwnerDecision). Une approbation de demande
 * exécutable : vérifications puis exécution liée (aucun effet sur écart).
 */
export async function decideOwnerRequest(db: D1Database, input: {
  request_id: string;
  decision: string;
  proof: OwnerProof;
  request_seq?: number;
  cycle_id?: string;
  /** Empreinte affichée dans le formulaire : ce que le propriétaire a vu. */
  payload_sha256?: string;
  now?: () => Date;
}): Promise<OwnerDecisionOutcome> {
  await ensureSchema(db);
  if (input.decision !== 'approve') {
    // Un refus d'une demande dont l'approbation a déjà été EXÉCUTÉE (décision portée par l'acte lié,
    // hors clé owner-decision:) : déjà tranché, rien n'est écrit. Les autres cas suivent decisions.ts.
    const decided = await decidedRequestOf(db, input.request_id);
    if (decided?.event && !decided.event.idempotency_key.startsWith('owner-decision:')) {
      const target = await resolveRequestTarget(db, input);
      if (decided.request_seq === target.seq) {
        throw new CollabStoreError('ALREADY_DECIDED', 'Demande déjà approuvée et exécutée (seq ' + decided.event.seq + ') : rien n’est écrit.');
      }
    }
    return recordOwnerDecision(db, input);
  }
  const request = await resolveRequestTarget(db, input);
  const parsed = await parseOwnerRequest(request.payload_json);
  if (parsed.kind === 'plain') return recordOwnerDecision(db, input);
  if (parsed.kind === 'invalid') {
    throw new CollabStoreError('EXECUTABLE_REQUEST_INVALID', 'Demande exécutable invalide, non approuvable : ' + parsed.reason
      + ' Refusez-la ; l’agent doit redéposer une demande valide.');
  }
  const req = parsed.request;
  // Double soumission du même formulaire : la décision déjà liée à CETTE demande est renvoyée telle quelle.
  const prior = await decidedRequestOf(db, req.request_id);
  if (prior) {
    if (prior.request_seq !== request.seq || !prior.event) {
      throw new CollabStoreError('ALREADY_DECIDED', 'Identifiant déjà tranché (' + prior.decision + ') : rien n’est exécuté.');
    }
    return { status: 'duplicate', event: prior.event, decision: prior.decision as Decision };
  }
  if (input.payload_sha256 !== req.payload_sha256) {
    throw new CollabStoreError('REQUEST_MISMATCH',
      'L’empreinte approuvée ne correspond pas à celle de la demande : rien n’est exécuté. Relisez /owner avant d’approuver.');
  }
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  if (req.expires_at !== null && at > req.expires_at) {
    throw new CollabStoreError('REQUEST_EXPIRED', 'Demande expirée : rien n’est exécuté. L’agent doit redéposer une demande à jour.');
  }
  const binding = { request_id: req.request_id, request_seq: request.seq, payload_sha256: req.payload_sha256,
    expected_previous_seq: req.previous_seq };
  if (req.action === 'install_phases') {
    const result = await installPhaseDefinitions(db, { cycle_id: req.cycle_id, definitions: String(req.params.definitions),
      proof: input.proof, now: input.now, binding });
    return { status: result.status, event: result.event, decision: 'approve', executed: { action: req.action, cycle_id: req.cycle_id,
      detail: 'phases ' + result.phases.map(item => item.phase + ' (' + item.auto_advance + ')').join(', ')
        + ', sha256 ' + result.definitions_sha256.slice(0, 12) } };
  }
  const target = req.params.target as { repository: string; path: string; ref: string } | undefined | null;
  const result = await importStateSnapshot(db, {
    cycle_id: req.cycle_id, markdown: String(req.params.markdown),
    owner_label: typeof req.params.owner_label === 'string' ? req.params.owner_label : undefined,
    target: target ? parseExportTarget(target.repository, target.path, target.ref) : null,
    proof: input.proof, now: input.now, binding,
  });
  return { status: result.status, event: result.event, decision: 'approve', executed: { action: req.action, cycle_id: req.cycle_id,
    detail: 'état révision ' + result.state_revision + ', ' + result.tasks + ' tâches, sha256 ' + result.content_sha256.slice(0, 12) } };
}
