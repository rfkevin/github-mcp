/**
 * CC-3 C4 — memory_entries lifecycle (plan §4, I4).
 * Versioned rows: propose → activate (reviewer ≠ author) → supersede/retire.
 * Never in-place text rewrite; never silent delete.
 * Budgets, alarms, participant isolation, protected kinds, hypothesis expiry.
 */
import {
  estimateTokens,
  validateMemoryActivation,
  validateMemoryEntry,
  type MemoryConfidence,
  type MemoryEntry,
  type MemoryKind,
  type MemoryStatus,
} from '../contracts/memory';
import { StateContractError } from '../../collab/contracts';

// estimateTokens now lives in contracts/memory.ts (single canonical metric,
// shared with the schema backfill); re-exported here for API compatibility.
export { estimateTokens };
import { ensureSchema } from '../store/schema';
import {
  PAUSE_REQUEST_PREFIX,
  alarmRequestStatements,
  baselineKey,
  occurrenceKey,
  pauseKey,
  pauseRequestId,
  sha256Hex,
  type PauseReason,
} from './pause-resume';

// CR-F02 : clés et identifiants de pause vivent dans pause-resume.ts (partagés avec
// le canal owner) ; ré-exportés ici pour la compatibilité de l'API publique.
export { PAUSE_REQUEST_PREFIX, pauseRequestId };

export class MemoryStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MemoryStoreError';
  }
}

export interface StoredMemory {
  id: string;
  version: number;
  scope: string;
  kind: string;
  text: string;
  evidence_refs: string;
  confidence: string;
  status: string;
  author_pid: string;
  reviewer_pid: string;
  supersedes: string | null;
  uses: number;
  last_used_rev: number | null;
  expires_rev: number | null;
}

export interface ProposeInput {
  id?: string;
  scope: string;
  kind: MemoryKind;
  text: string;
  evidence_refs?: string[];
  confidence?: MemoryConfidence;
  author_pid: string;
  supersedes?: string;
  expires_rev?: number;
  owner_decision_ref?: string;
  cycle_rev?: number;
}

/**
 * CR-B (CR-02) — mutation du lifecycle mémoire préparée mais NON exécutée.
 * Les statements rejoignent le batch CAS du caller (CollabStore.appendEvent ou
 * le batch interne du MemoryStore) : un « applied » porte toujours l'effet
 * mémoire, un refus n'écrit rien du tout — ni journal, ni mémoire.
 */
export interface MemoryMutation {
  statements: D1PreparedStatement[];
  /** Index (dans statements) du statement dont le changes appliqué doit être 1 (contrôle défensif). */
  verifyIndex: number;
  /** Effet résumé renvoyé au client (champ memory d'un append applied). */
  summary: { id: string; version: number; status: string };
  /** Effets post-commit (alarmes kinds protégés), exécutés après un batch appliqué. */
  postCommit?: () => Promise<void>;
  /** Entrées de re-diagnostic fail-closed (activation) dans le catch du caller. */
  diagnosis?: { scope: string; text: string; capKey: string; kind: string; protectedKind: boolean };
}

/**
 * CRB-R1 (revue Sol, github-mcp#79/6086862463) : les scopes `participant:<id>`
 * sont la mémoire privée d'un participant — consolidate et retire via le journal
 * public ne peuvent viser que le scope de l'appelant. Les scopes partagés
 * (common/project/role/task) restent collaboratifs ; la revue par un pair
 * distinct reste ouverte (activation C4). callerPid null = appel interne du
 * MemoryStore (wrappers supersede/retire) : garde désactivée, inchangée.
 */
function assertParticipantScopeAllowed(scope: string, callerPid: string | undefined, type: string): void {
  if (!callerPid) return;
  if (scope.startsWith('participant:') && scope !== `participant:${callerPid}`) {
    throw new MemoryStoreError(
      'MEMORY_SCOPE_FORBIDDEN',
      `${type}: participant scope ${scope} belongs to another participant (CRB-R1).`,
    );
  }
}

/**
 * CR-D (github-mcp#89, constat GPT6-02) : un id mémoire n'a qu'un scope,
 * immuable sur toutes ses versions (candidate, active, superseded, retired).
 * Toute mutation d'une lignée dont l'id est enregistré sous un autre scope —
 * proposition concurrente, id recyclé après retrait, ou données anciennes
 * incohérentes antérieures à CR-D — est refusée avant tout effet. Le message
 * ne nomme pas le scope existant (il peut être privé).
 */
function scopeMismatch(id: string, type: string): MemoryStoreError {
  return new MemoryStoreError(
    'MEMORY_SCOPE_MISMATCH',
    `${type}: memory id ${id} is already bound to another scope; a memory id keeps one immutable scope (CR-D).`,
  );
}

/** Token budgets per scope family (plan §4). */
export const MEMORY_TOKEN_BUDGETS: Record<string, number> = {
  common: 1500,
  project: 2000,
  role: 1500,
  participant: 500,
  task: 300,
};

/** invariant + decision (authority/safety proxy until dedicated kinds exist). */
export const PROTECTED_KINDS = new Set(['invariant', 'decision']);
export const HYPOTHESIS_EXPIRE_CYCLES = 3;
/** Plan: alarm if >5 refutes → trigger on the 6th. */
export const REFUTE_ALARM_THRESHOLD = 6;
export const GROWTH_ALARM_PERCENT = 25;
export const MAX_ACTIVATIONS_PER_CYCLE = 10;
export const MAX_RETIREMENTS_PER_CYCLE = 10;

/**
 * C5-compatible owner_decision request_ids. C5 (owner/decisions.ts
 * REQUEST_ID_RE) forbids ':' in request_id, so each protected operation
 * encodes the exact subject it authorizes, bound to the mutation occurrence:
 *   propose    -> mem-propose-<id>-v<version> (exact, bound to the resulting version)
 *   supersede  -> mem-supersede-<id>-v<nextVersion> (exact match)
 *   retire     -> mem-retire-<id>-v<version> (exact match)
 *   scope      -> mem-scope-<sha256(id:nextVersion:newScope)[0:20]> (exact)
 *   confidence -> mem-conf-<sha256(id:version:confidence)[0:20]> (exact)
 *   pause      -> mem-pause-<sha256(scope)[0:20]>-<occurrence> (exact, current occurrence)
 * A decision recorded for any other subject — or for another occurrence of
 * the same subject — never authorizes these paths (plan §4 Protected).
 */
export const PROPOSE_REQUEST_PREFIX = 'mem-propose-';
export const SUPERSEDE_REQUEST_PREFIX = 'mem-supersede-';
export const RETIRE_REQUEST_PREFIX = 'mem-retire-';
export const SCOPE_REQUEST_PREFIX = 'mem-scope-';
export const CONFIDENCE_REQUEST_PREFIX = 'mem-conf-';
/** Protected memory ids stay short so request_id never exceeds 64 chars. */
const MEMORY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/** Propose approvals are bound to the resulting version, never reusable. */
export function proposeRequestId(id: string, version: number): string {
  return `${PROPOSE_REQUEST_PREFIX}${id}-v${version}`;
}

/** Supersede approvals are bound to the resulting version, never reusable. */
export function supersedeRequestId(id: string, nextVersion: number): string {
  return `${SUPERSEDE_REQUEST_PREFIX}${id}-v${nextVersion}`;
}

/** Retire approvals are bound to the exact version being retired. */
export function retireRequestId(id: string, version: number): string {
  return `${RETIRE_REQUEST_PREFIX}${id}-v${version}`;
}

/** Scope-promotion approvals bind id + resulting version + target scope. */
export async function promoteScopeRequestId(
  id: string,
  nextVersion: number,
  newScope: string,
): Promise<string> {
  return SCOPE_REQUEST_PREFIX + (await sha256Hex(`${id}:${nextVersion}:${newScope}`)).slice(0, 20);
}

/** Confidence-promotion approvals bind id + version + target confidence. */
export async function promoteConfidenceRequestId(
  id: string,
  version: number,
  confidence: string,
): Promise<string> {
  return CONFIDENCE_REQUEST_PREFIX + (await sha256Hex(`${id}:${version}:${confidence}`)).slice(0, 20);
}

const META_ACT = 'mem:act:';
const META_RET = 'mem:ret:';

export function scopeFamily(scope: string): string {
  if (scope === 'common') return 'common';
  const i = scope.indexOf(':');
  return i === -1 ? scope : scope.slice(0, i);
}

export interface MemoryAlarm {
  code: 'INVARIANT_TOUCHED' | 'REFUTE_THRESHOLD' | 'GROWTH_THRESHOLD';
  message: string;
  scope?: string;
  details?: Record<string, unknown>;
}

const ALARM_REASONS: Record<MemoryAlarm['code'], PauseReason> = {
  INVARIANT_TOUCHED: 'invariant',
  REFUTE_THRESHOLD: 'refute',
  GROWTH_THRESHOLD: 'growth',
};

function newId(): string {
  return 'mem-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

export class MemoryStore {
  private readonly localAlarms: MemoryAlarm[] = [];

  constructor(private readonly db: D1Database) {}

  getAlarms(): readonly MemoryAlarm[] {
    return this.localAlarms;
  }

  /** Pause is per-scope (plan: activations in that scope pause). */
  async isActivationPaused(scope?: string): Promise<boolean> {
    await ensureSchema(this.db);
    if (scope) {
      const row = await this.db
        .prepare(`SELECT writes FROM quota_counters WHERE day = ?1`)
        .bind(pauseKey(scope))
        .first<{ writes: number }>();
      return (row?.writes ?? 0) > 0;
    }
    // Any paused scope (for tests / diagnostics)
    const { results } = await this.db
      .prepare(`SELECT writes FROM quota_counters WHERE day LIKE ?1 AND writes > 0 LIMIT 1`)
      .bind('mem:pause:%')
      .all<{ writes: number }>();
    return (results?.length ?? 0) > 0;
  }

  /**
   * Current pause-clearing request_id for a scope: the approval must target
   * the live pause occurrence exactly (plan §4 Protected, tests T3/T4).
   */
  async pauseClearRequestId(scope: string): Promise<string> {
    await ensureSchema(this.db);
    return pauseRequestId(scope, await this.occurrenceOf(scope));
  }

  /** Current pause occurrence of a scope (0 before any alarm). */
  private async occurrenceOf(scope: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT writes FROM quota_counters WHERE day = ?1`)
      .bind(occurrenceKey(scope))
      .first<{ writes: number }>();
    return row?.writes ?? 0;
  }

  /**
   * Clear the pause of exactly one scope. owner_decision_ref must equal
   * pauseRequestId(scope, current occurrence) with an approve row: approvals
   * are occurrence-bound, never reusable, and no global clear exists.
   */
  async clearActivationPause(ownerDecisionRef: string, scope: string): Promise<void> {
    await this.requireOwnerDecision(ownerDecisionRef, { exact: await this.pauseClearRequestId(scope) });
    await this.db
      .prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, 0)`)
      .bind(pauseKey(scope))
      .run();
  }

  /** Insert a candidate (status=candidate, version=1 or next). */
  async propose(input: ProposeInput): Promise<StoredMemory> {
    const prepared = await this.preparePropose(input);
    await this.db.batch(prepared.statements);
    return (await this.get(prepared.summary.id, prepared.summary.version))!;
  }

  /**
   * CR-B (CR-02) : pre-checks typés + statements d'un propose, SANS exécution.
   * Les statements rejoignent le batch CAS du caller (l'appendEvent du store
   * ou le batch interne ci-dessus) : un applied porte toujours l'effet
   * mémoire, un refus n'écrit rien du tout (ni journal, ni mémoire). Toutes
   * les lectures sont read-only : rejouer cette méthode re-diagnostique.
   */
  async preparePropose(input: ProposeInput): Promise<MemoryMutation> {
    await ensureSchema(this.db);
    if (input.confidence === 'hypothesis' && PROTECTED_KINDS.has(input.kind)) {
      throw new MemoryStoreError(
        'HYPOTHESIS_NOT_RULE',
        'hypothesis cannot be proposed as invariant/decision (never a rule)',
      );
    }
    const confidence = input.confidence ?? 'hypothesis';
    let expiresRev = input.expires_rev ?? null;
    if (confidence === 'hypothesis' && expiresRev == null && input.cycle_rev != null) {
      expiresRev = input.cycle_rev + HYPOTHESIS_EXPIRE_CYCLES;
    }
    const entry: MemoryEntry = validateMemoryEntry({
      scope: input.scope,
      kind: input.kind,
      text: input.text,
      evidence_refs: input.evidence_refs ?? [],
      confidence,
      status: 'candidate',
      author_pid: input.author_pid,
    });
    const id = input.id ?? newId();
    // CR-D : le scope d'un id est immuable, retirées et superseded comprises —
    // refus avant tout effet (ni événement, ni ligne, ni quota, ni révision).
    await this.assertIdScope(id, entry.scope, 'memory.propose');
    const latest = await this.latestVersion(id);
    if (latest && latest.status === 'active') {
      throw new MemoryStoreError('MEMORY_ACTIVE_EXISTS', `Memory ${id} is already active; use supersede.`);
    }
    const version = latest ? latest.version + 1 : 1;
    // Plan §4 Protected: the approval is bound to the resulting version (like
    // supersede), and a protected id stays protected across retire — no
    // resurrection under another kind without a new owner decision.
    if (PROTECTED_KINDS.has(input.kind) || (latest != null && PROTECTED_KINDS.has(latest.kind))) {
      const protectedId = input.id?.trim() ?? '';
      if (!MEMORY_ID_RE.test(protectedId)) {
        throw new MemoryStoreError(
          'PROTECTED_KIND_OWNER_REQUIRED',
          'protected kinds require an explicit id matching [a-z0-9][a-z0-9_-]{0,39}',
        );
      }
      await this.requireOwnerDecision(input.owner_decision_ref, {
        exact: proposeRequestId(protectedId, version),
      });
    }
    return {
      statements: [
        // CR-D : garde transactionnelle — une proposition concurrente du même
        // id dans un autre scope, committée entre les pré-checks et ce batch,
        // roule tout en arrière ; le caller re-diagnostique MEMORY_SCOPE_MISMATCH.
        this.scopeIdentityGuard(id, entry.scope),
        this.insertCandidate(entry, id, version, input.supersedes ?? null, expiresRev),
      ],
      verifyIndex: 1,
      summary: { id, version, status: 'candidate' },
    };
  }

  /**
   * Activate candidate → active; reviewer ≠ author; budget enforced (I4 / §4).
   * A03 (post-audit F3): the activation is ONE D1 batch — a single SQL
   * transaction. A transactional guard re-verifies candidate status, pause,
   * cycle cap and budget inside the batch, so a concurrent change between
   * the pre-checks and the commit rolls the entire activation back
   * (fail-closed) instead of half-applying it. Cap reservation, growth
   * baseline/alarm and protected-kind pause live in the same transaction:
   * exactly one counter increment and one registered reviewer per applied
   * activation.
   */
  async activate(
    id: string,
    version: number,
    reviewerPid: string,
    cycleId = 'default',
  ): Promise<StoredMemory> {
    const prepared = await this.prepareActivation(id, version, reviewerPid, cycleId);
    const { scope, text, capKey, kind, protectedKind } = prepared.diagnosis!;
    let results: Array<{ meta?: { changes?: number } }>;
    try {
      results = (await this.db.batch(prepared.statements)) as unknown as Array<{ meta?: { changes?: number } }>;
    } catch (error) {
      // Fail-closed: diagnose from the durable state, never guess (A03). The
      // batch either applied fully or not at all — nothing in between.
      const current = await this.get(id, version);
      if (current && current.status === 'active') {
        throw new MemoryStoreError(
          'ACTIVATION_RACE',
          `Candidate ${id}@${version} was not activated (concurrent change)`,
        );
      }
      if (current && current.status !== 'candidate') {
        throw new MemoryStoreError('MEMORY_NOT_CANDIDATE', `Memory ${id}@${version} status is ${current.status}`);
      }
      await this.assertIdScope(id, scope, 'memory.review');
      await this.assertNotPaused(scope);
      await this.assertCycleCap(capKey, MAX_ACTIVATIONS_PER_CYCLE, 'ACTIVATION_CAP');
      await this.assertBudgetAllows(scope, text);
      throw error;
    }
    // A03: explicit CAS control — the activation UPDATE must have applied
    // exactly one row. The batch's own change count is authoritative: a
    // concurrent activation of another candidate version of the same id can
    // supersede this row between our own commit and the durable re-read —
    // that is the expected I4 convergence (exactly one active version), not
    // a race. The re-read only backs the check up when meta is unavailable.
    const activated = await this.get(id, version);
    const changes = results[prepared.verifyIndex]?.meta?.changes;
    if (changes === 0 || !activated || (changes !== 1 && activated.status === 'candidate')) {
      throw new MemoryStoreError('ACTIVATION_RACE', `Candidate ${id}@${version} was not activated (concurrent change)`);
    }
    const growth = await this.growthAlarmFor(scope);
    if (growth) this.localAlarms.push(growth);
    if (protectedKind) {
      this.localAlarms.push({
        code: 'INVARIANT_TOUCHED',
        message: `Protected kind ${kind} activated on ${id}`,
        scope,
        details: { id, version },
      });
    }
    return activated;
  }

  /**
   * CR-B (CR-02) : pre-checks + statements de l'activation (revue par un pair
   * distinct de l'auteur), SANS exécution — même contrat fail-closed que
   * preparePropose. La garde transactionnelle A03 re-vérifie candidature,
   * pause, cap de cycle et budget À L'INTÉRIEUR du batch du caller : un
   * changement concurrent entre les pre-checks et le commit roule tout en
   * arrière (l'append du journal compris, CR-02).
   */
  async prepareActivation(
    id: string,
    version: number,
    reviewerPid: string,
    cycleId = 'default',
  ): Promise<MemoryMutation> {
    await ensureSchema(this.db);
    const row = await this.get(id, version);
    if (!row) throw new MemoryStoreError('MEMORY_NOT_FOUND', `Memory ${id}@${version} not found`);
    await this.assertNotPaused(row.scope);
    if (row.status !== 'candidate') {
      throw new MemoryStoreError('MEMORY_NOT_CANDIDATE', `Memory ${id}@${version} status is ${row.status}`);
    }
    // CR-D : une lignée enregistrée sous plusieurs scopes (données anciennes)
    // n'est jamais activée — l'activation superséderait une version d'un autre scope.
    await this.assertIdScope(id, row.scope, 'memory.review');
    if (row.confidence === 'hypothesis' && PROTECTED_KINDS.has(row.kind)) {
      throw new MemoryStoreError('HYPOTHESIS_NOT_RULE', 'hypothesis cannot activate as a rule');
    }
    validateMemoryActivation(row.author_pid, reviewerPid);
    if (row.evidence_refs === '[]' || !row.evidence_refs) {
      throw new StateContractError(
        'MEMORY_EVIDENCE_REQUIRED',
        'non-candidate entries require at least one evidence_ref',
        'evidence_refs',
      );
    }
    const capKey = `${META_ACT}${cycleId}:${row.scope}`;
    await this.assertCycleCap(capKey, MAX_ACTIVATIONS_PER_CYCLE, 'ACTIVATION_CAP');
    await this.assertBudgetAllows(row.scope, row.text);
    const pausedKey = pauseKey(row.scope);
    const baseKey = baselineKey(row.scope);
    const occKey = occurrenceKey(row.scope);
    const budget = MEMORY_TOKEN_BUDGETS[scopeFamily(row.scope)] ?? 500;
    const newTokens = estimateTokens(row.text);
    const protectedKind = PROTECTED_KINDS.has(row.kind);
    const statements: D1PreparedStatement[] = [
      // A03 transactional guard: the whole batch rolls back unless the
      // candidate is still a candidate, the scope is not paused, the cycle
      // cap has a slot left and the scope budget still allows this text —
      // the same conditions as the pre-checks, re-verified at commit time.
      // Budget measure (review Sol, F3): the guard sums the persisted exact
      // cost (token_cost = estimateTokens, UTF-16 units) so non-BMP text is
      // counted identically by the JS pre-check and this transaction; the
      // length() fallback only covers pre-migration rows (code points).
      this.db.prepare([
        'INSERT INTO collab_store_guard (ok)',
        'SELECT CASE WHEN',
        `  EXISTS (SELECT 1 FROM memory_entries WHERE id = ?1 AND version = ?2 AND status = 'candidate')`,
        // CR-D : l'id n'a, au commit, aucune version dans un autre scope.
        '  AND NOT EXISTS (SELECT 1 FROM memory_entries WHERE id = ?1 AND scope <> ?6)',
        '  AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE day = ?3 AND writes > 0)',
        '  AND COALESCE((SELECT writes FROM quota_counters WHERE day = ?4), 0) < ?5',
        `  AND COALESCE((SELECT SUM(COALESCE(token_cost, (length(text) + 3) / 4)) FROM memory_entries WHERE status = 'active' AND scope = ?6), 0) + ?7 <= ?8`,
        '  THEN 1 ELSE 0 END',
      ].join(' ')).bind(id, version, pausedKey, capKey, MAX_ACTIVATIONS_PER_CYCLE, row.scope, newTokens, budget),
      // A03: the cap reservation lives inside the transaction — exactly one
      // increment per applied activation, rolled back with a failed one.
      this.db
        .prepare(`INSERT INTO quota_counters (day, writes) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET writes = writes + 1`)
        .bind(capKey),
    ];
    // A03/I4 (pre-test Claude): supersede ANY other active version of this
    // id inside the transaction, not just the priorActive read before the
    // batch. Two candidate versions of one id activated in parallel would
    // otherwise both stay active (each call saw "no active version") and
    // violate I4. Sequential and parallel now converge: exactly one active
    // version, the loser ends up superseded.
    // CR-D (GPT6-02) : la supersession est bornée au scope de la candidate —
    // jamais `WHERE id = ?` seul, même si la garde ci-dessus l'assure déjà.
    statements.push(
      this.db
        .prepare(`UPDATE memory_entries SET status = 'superseded' WHERE id = ?1 AND status = 'active' AND version <> ?2 AND scope = ?3`)
        .bind(id, version, row.scope),
    );
    statements.push(
      this.db
        .prepare(
          `UPDATE memory_entries SET status = 'active', reviewer_pid = ?1 WHERE id = ?2 AND version = ?3 AND status = 'candidate'`,
        )
        .bind(reviewerPid, id, version),
    );
    const activateIndex = statements.length - 1;
    // A03: growth baseline + alarm + pause occurrence in the same transaction
    // (previously post-batch writes that a crash could skip). Integer form:
    // growth % > GROWTH_ALARM_PERCENT  <=>  100 * n > (100 + limit) * baseline.
    const growthExceeded = `100 * (SELECT COUNT(*) FROM memory_entries WHERE status = 'active' AND scope = ?2) > ${100 + GROWTH_ALARM_PERCENT} * (SELECT writes FROM quota_counters WHERE day = ?3)`;
    const bumpOccurrence =
      'INSERT OR REPLACE INTO quota_counters (day, writes) SELECT ?1, COALESCE((SELECT writes FROM quota_counters WHERE day = ?1), 0) + 1';
    statements.push(
      this.db
        .prepare(
          `INSERT INTO quota_counters (day, writes) SELECT ?1, MAX(1, (SELECT COUNT(*) FROM memory_entries WHERE status = 'active' AND scope = ?2) - 1) WHERE NOT EXISTS (SELECT 1 FROM quota_counters WHERE day = ?1)`,
        )
        .bind(baseKey, row.scope),
      this.db
        .prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) SELECT ?1, 1 WHERE ${growthExceeded}`)
        .bind(pausedKey, row.scope, baseKey),
      this.db.prepare(`${bumpOccurrence} WHERE ${growthExceeded}`).bind(occKey, row.scope, baseKey),
    );
    if (protectedKind) {
      // A03: INVARIANT_TOUCHED pause + occurrence, also inside the batch.
      statements.push(
        this.db.prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, 1)`).bind(pausedKey),
        this.db.prepare(bumpOccurrence).bind(occKey),
      );
    }
    // CR-F02 (#93) : l'alarme dépose, dans cette même transaction, l'owner.request
    // exacte de l'occurrence qu'elle ouvre (croissance : conditionnelle ; invariant :
    // certaine). Sans alarme, l'occurrence n'avance pas et rien n'est déposé.
    statements.push(...await alarmRequestStatements(this.db, row.scope, await this.occurrenceOf(row.scope),
      protectedKind ? 'invariant' : 'growth', Math.floor(Date.now() / 1000)));
    statements.push(this.db.prepare(`DELETE FROM collab_store_guard`));
    return {
      statements,
      verifyIndex: activateIndex,
      summary: { id, version, status: 'active' },
      diagnosis: { scope: row.scope, text: row.text, capKey, kind: row.kind, protectedKind },
    };
  }

  /** Atomic supersede: batch UPDATE active→superseded + INSERT candidate (fail-closed). */
  async supersede(
    id: string,
    authorPid: string,
    text: string,
    evidenceRefs: string[],
    kind?: MemoryKind,
    confidence?: MemoryConfidence,
    ownerDecisionRef?: string,
    peerEvidenceRef?: string,
  ): Promise<StoredMemory> {
    const prepared = await this.prepareSupersede(
      id,
      authorPid,
      text,
      evidenceRefs,
      kind,
      confidence,
      ownerDecisionRef,
      undefined,
      peerEvidenceRef,
    );
    await this.db.batch(prepared.statements);
    await prepared.postCommit?.();
    return (await this.get(id, prepared.summary.version))!;
  }

  /**
   * CR-B (CR-02) : pre-checks + statements du supersede (consolidation), SANS
   * exécution — même contrat que preparePropose. L'alarme des kinds protégés
   * (pause du scope, C4) reste un effet post-commit : elle n'appartient pas à
   * la transaction du caller.
   * CRB-R1 (revue Sol) : avec un callerPid (journal public), le scope privé
   * `participant:<autre>` est refusé MEMORY_SCOPE_FORBIDDEN avant tout batch —
   * le propriétaire du scope seul consolide sa mémoire privée.
   */
  async prepareSupersede(
    id: string,
    authorPid: string,
    text: string,
    evidenceRefs: string[],
    kind?: MemoryKind,
    confidence?: MemoryConfidence,
    ownerDecisionRef?: string,
    callerPid?: string,
    peerEvidenceRef?: string,
  ): Promise<MemoryMutation> {
    await ensureSchema(this.db);
    const active = await this.db
      .prepare(`SELECT * FROM memory_entries WHERE id = ?1 AND status = 'active' ORDER BY version DESC LIMIT 1`)
      .bind(id)
      .first<StoredMemory>();
    if (!active) throw new MemoryStoreError('MEMORY_NO_ACTIVE', `No active version for ${id}`);
    // CRB-R1 (revue Sol) : un scope participant est privé — son propriétaire seul consolide.
    assertParticipantScopeAllowed(active.scope, callerPid, 'memory.consolidate');
    // CR-D : jamais de consolidation d'une lignée enregistrée sous plusieurs scopes.
    await this.assertIdScope(id, active.scope, 'memory.consolidate');
    const nextKind = (kind ?? active.kind) as MemoryKind;
    const conf = confidence ?? (active.confidence as MemoryConfidence);
    const nextVersion = active.version + 1;
    if (PROTECTED_KINDS.has(active.kind) || PROTECTED_KINDS.has(nextKind)) {
      // Bound to the resulting version: an approval for v2 never authorizes v3.
      await this.requireOwnerDecision(ownerDecisionRef, {
        exact: supersedeRequestId(id, nextVersion),
      });
    }
    if (conf === 'hypothesis' && PROTECTED_KINDS.has(nextKind)) {
      throw new MemoryStoreError('HYPOTHESIS_NOT_RULE', 'hypothesis cannot supersede into a rule kind');
    }
    // CR-F03 (#95, contre-revue Codex #79/6096598889) : TOUTE hausse de confiance
    // — chemin public (memory.consolidate) comme chemin interne (promoteConfidence) —
    // exige une preuve du registre produite par un pair distinct de l'auteur, et
    // NOUVELLE : un ref résolu déjà soutenu par une version QUELCONQUE de la
    // lignée de l'id (revue Claude PR #100/6098002656) — active, superseded ou
    // retirée — est refusé : une consolidation qui retire le ref ne le blanchit
    // pas. Fail-closed uniforme ; à confiance inchangée, aucun ref supplémentaire
    // n'est exigé (la consolidation ordinaire reste intacte).
    let refs = evidenceRefs;
    if (confidence !== undefined && confidenceRank(conf) > confidenceRank(active.confidence as MemoryConfidence)) {
      const ledgerRef = await this.requireRaiseEvidence(peerEvidenceRef, authorPid, id);
      if (!refs.includes(ledgerRef)) refs = [...refs, ledgerRef];
    }
    const entry = validateMemoryEntry({
      scope: active.scope,
      kind: nextKind,
      text,
      evidence_refs: refs,
      confidence: conf,
      status: 'candidate',
      author_pid: authorPid,
    });
    return {
      statements: [
        this.db
          .prepare(`UPDATE memory_entries SET status = 'superseded' WHERE id = ?1 AND version = ?2 AND status = 'active'`)
          .bind(id, active.version),
        this.insertCandidate(entry, id, nextVersion, `${id}@${active.version}`, null),
        // CR-B (CR-02) : garde transactionnelle d'effet — le batch du caller ne
        // passe que si l'ancienne version active est durablement superseded.
        this.statusEffectGuard(id, active.version, 'superseded'),
        // CR-D : au commit, l'id n'a toujours qu'un scope.
        this.scopeIdentityGuard(id, active.scope),
      ],
      verifyIndex: 1,
      summary: { id, version: nextVersion, status: 'candidate' },
      ...(PROTECTED_KINDS.has(active.kind) || PROTECTED_KINDS.has(nextKind)
        ? {
            postCommit: async () => {
              await this.raiseAlarm({
                code: 'INVARIANT_TOUCHED',
                message: `Protected kind supersede on ${id}`,
                scope: active.scope,
                details: { id, ownerDecisionRef },
              });
            },
          }
        : {}),
    };
  }

  /**
   * Raise confidence with ledger-backed evidence from a distinct peer.
   * Rank: hypothesis < observed < verified < owner_validated (no downgrade).
   * peerEvidenceRef must resolve to evidence_ledger row produced by reviewerPid.
   * Protected kinds additionally require an owner decision (plan §4):
   * active rows via the supersede version-bound ref, candidates via
   * promoteConfidenceRequestId(id, version, newConfidence).
   */
  async promoteConfidence(
    id: string,
    version: number,
    reviewerPid: string,
    peerEvidenceRef: string,
    newConfidence: MemoryConfidence,
    ownerDecisionRef?: string,
  ): Promise<StoredMemory> {
    await ensureSchema(this.db);
    const row = await this.get(id, version);
    if (!row) throw new MemoryStoreError('MEMORY_NOT_FOUND', `Memory ${id}@${version} not found`);
    if (row.status !== 'active' && row.status !== 'candidate') {
      throw new MemoryStoreError('MEMORY_NOT_PROMOTABLE', `status ${row.status}`);
    }
    if (reviewerPid === row.author_pid) {
      throw new MemoryStoreError('PEER_REQUIRED', 'confidence promotion requires a distinct peer reviewer');
    }
    const current = row.confidence as MemoryConfidence;
    if (confidenceRank(newConfidence) <= confidenceRank(current)) {
      throw new MemoryStoreError(
        'CONFIDENCE_DOWNGRADE',
        `cannot promote ${current} → ${newConfidence} (rank must increase)`,
      );
    }
    const ledgerRef = await this.requirePeerLedgerEvidence(peerEvidenceRef, reviewerPid, row.author_pid);
    // CR-F03 (revue Claude PR #100/6098002656) : le chemin CANDIDATE (UPDATE
    // direct, sans supersede) passe lui aussi par la garde anti-recyclage —
    // le ref validé ne doit soutenir aucune version de la lignée de l'id.
    if (row.status === 'candidate') {
      await this.requireRaiseEvidence(peerEvidenceRef, row.author_pid, id);
    }
    const refs: string[] = JSON.parse(row.evidence_refs || '[]');
    refs.push(ledgerRef);
    if (PROTECTED_KINDS.has(row.kind) && row.status === 'active') {
      // supersede() enforces its own version-bound owner decision here.
      return this.supersede(
        id,
        row.author_pid,
        row.text,
        refs,
        row.kind as MemoryKind,
        newConfidence,
        ownerDecisionRef,
        // CR-F03 : le supersede interne re-valide la preuve (elle est nouvelle :
        // elle ne figure pas encore dans les refs de la version active).
        ledgerRef,
      );
    }
    if (PROTECTED_KINDS.has(row.kind)) {
      // Candidate: the decision is bound to this confidence occurrence.
      await this.requireOwnerDecision(ownerDecisionRef, {
        exact: await promoteConfidenceRequestId(id, version, newConfidence),
      });
    }
    if (row.status === 'active') {
      return this.supersede(id, row.author_pid, row.text, refs, row.kind as MemoryKind, newConfidence, undefined, ledgerRef);
    }
    await this.db
      .prepare(`UPDATE memory_entries SET confidence = ?1, evidence_refs = ?2 WHERE id = ?3 AND version = ?4`)
      .bind(newConfidence, JSON.stringify(refs), id, version)
      .run();
    return (await this.get(id, version))!;
  }

  /**
   * Promote scope participant:<id> → role|project|common via peer review (not task).
   * Marks prior active superseded and inserts candidate on new scope (atomic batch).
   * Protected kinds additionally require an owner decision bound to
   * promoteScopeRequestId(id, version + 1, newScope) (plan §4).
   * CR-D (GPT6-02) : un id garde un scope immuable — la copie promue reçoit un
   * NOUVEL id dans le scope cible, sa lignée restant tracée par
   * supersedes = `<id>@<version>`. L'approbation owner reste liée à la lignée
   * source (id, version + 1, scope cible), format inchangé.
   */
  async promoteScope(
    id: string,
    version: number,
    reviewerPid: string,
    newScope: string,
    ownerDecisionRef?: string,
  ): Promise<StoredMemory> {
    const prepared = await this.preparePromoteScope(id, version, reviewerPid, newScope, ownerDecisionRef);
    try {
      await this.db.batch(prepared.statements);
    } catch (error) {
      // Fail-closed (CRD-R2) : re-diagnostic depuis l'état durable — une promotion
      // concurrente committée entre-temps laisse la source superseded
      // (MEMORY_NOT_ACTIVE) ; sinon l'erreur d'origine est relancée.
      await this.preparePromoteScope(id, version, reviewerPid, newScope, ownerDecisionRef);
      throw error;
    }
    return (await this.get(prepared.summary.id, prepared.summary.version))!;
  }

  /**
   * Pré-checks + statements d'une promotion de scope, SANS exécution (même
   * contrat que les autres prepare*). CR-D (revue GPT-6, CRD-R1/CRD-R2) :
   * - la lignée source doit n'avoir qu'un scope (pré-check + garde au commit) :
   *   une lignée ancienne multi-scope reste figée, promotion comprise ;
   * - une garde AVANT l'UPDATE exige que la source soit encore active au
   *   commit, puis une garde d'effet exige que l'UPDATE ait changé exactement
   *   une ligne : deux promotions préparées avant le premier commit ne créent
   *   qu'une copie, et une approbation owner liée à la source ne sert qu'une fois.
   */
  async preparePromoteScope(
    id: string,
    version: number,
    reviewerPid: string,
    newScope: string,
    ownerDecisionRef?: string,
  ): Promise<MemoryMutation> {
    await ensureSchema(this.db);
    const row = await this.get(id, version);
    if (!row) throw new MemoryStoreError('MEMORY_NOT_FOUND', `Memory ${id}@${version} not found`);
    if (row.status !== 'active') {
      throw new MemoryStoreError('MEMORY_NOT_ACTIVE', 'only active memories can be scope-promoted');
    }
    // CRD-R1 : jamais de promotion depuis une lignée enregistrée sous plusieurs scopes.
    await this.assertIdScope(id, row.scope, 'memory.promote');
    if (reviewerPid === row.author_pid) {
      throw new MemoryStoreError('PEER_REQUIRED', 'scope promotion requires a distinct peer reviewer');
    }
    if (!row.scope.startsWith('participant:')) {
      throw new MemoryStoreError('SCOPE_NOT_PERSONAL', 'only participant scope can be lifted');
    }
    const family = scopeFamily(newScope);
    if (!['role', 'project', 'common'].includes(family) && newScope !== 'common') {
      throw new MemoryStoreError(
        'SCOPE_TARGET_INVALID',
        `promotion target must be role|project|common, got ${newScope}`,
      );
    }
    if (PROTECTED_KINDS.has(row.kind)) {
      // Plan §4 Protected: bound to id + resulting version + target scope.
      await this.requireOwnerDecision(ownerDecisionRef, {
        exact: await promoteScopeRequestId(id, row.version + 1, newScope),
      });
    }
    const nextConf: MemoryConfidence =
      row.confidence === 'hypothesis' ? 'observed' : (row.confidence as MemoryConfidence);
    const entry = validateMemoryEntry({
      scope: newScope,
      kind: row.kind as MemoryKind,
      text: row.text,
      evidence_refs: [...JSON.parse(row.evidence_refs || '[]'), `promote:${reviewerPid}`],
      confidence: nextConf,
      status: 'candidate',
      author_pid: row.author_pid,
    });
    const liftedId = newId();
    return {
      statements: [
        // CRD-R1/CRD-R2 : au commit, la source est encore active et sa lignée n'a qu'un scope.
        this.db
          .prepare([
            'INSERT INTO collab_store_guard (ok) SELECT CASE WHEN',
            `  EXISTS (SELECT 1 FROM memory_entries WHERE id = ?1 AND version = ?2 AND status = 'active')`,
            '  AND NOT EXISTS (SELECT 1 FROM memory_entries WHERE id = ?1 AND scope <> ?3)',
            '  THEN 1 ELSE 0 END',
          ].join(' '))
          .bind(id, row.version, row.scope),
        this.db
          .prepare(`UPDATE memory_entries SET status = 'superseded' WHERE id = ?1 AND version = ?2 AND status = 'active' AND scope = ?3`)
          .bind(id, row.version, row.scope),
        // CRD-R2 : effet réel — l'UPDATE précédent a changé exactement une ligne
        // (changes() porte sur la dernière instruction de la transaction).
        this.db.prepare('INSERT INTO collab_store_guard (ok) SELECT CASE WHEN changes() = 1 THEN 1 ELSE 0 END'),
        this.db
          .prepare(
            `INSERT INTO memory_entries
             (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid, supersedes, uses, last_used_rev, expires_rev, token_cost)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'candidate', ?8, '', ?9, 0, NULL, NULL, ?10)`,
          )
          .bind(
            liftedId,
            1,
            entry.scope,
            entry.kind,
            entry.text,
            JSON.stringify(entry.evidence_refs),
            entry.confidence,
            entry.author_pid,
            `${id}@${row.version}`,
            estimateTokens(entry.text),
          ),
        this.db.prepare('DELETE FROM collab_store_guard'),
      ],
      verifyIndex: 1,
      summary: { id: liftedId, version: 1, status: 'candidate' },
    };
  }

  /**
   * Retire (tombstone): status=retired, row kept. Cap ≤10 per cycle+scope.
   * Protected kinds require an owner decision bound to the retired version
   * (retireRequestId(id, version)) — plan §4 Protected.
   */
  async retire(
    id: string,
    version?: number,
    cycleId = 'default',
    ownerDecisionRef?: string,
  ): Promise<StoredMemory> {
    const prepared = await this.prepareRetire(id, version, cycleId, ownerDecisionRef);
    await this.db.batch(prepared.statements);
    return (await this.get(id, prepared.summary.version))!;
  }

  /**
   * CR-B (CR-02) : pre-checks + statements du retire (tombstone), SANS
   * exécution. Le cap par cycle est réservé DANS le batch (comme le cap
   * d'activation A03) et une garde transactionnelle exige que la ligne soit
   * durablement retired : un applied porte toujours l'effet mémoire.
   * CRB-R1 (revue Sol) : avec un callerPid (journal public), retirer la
   * mémoire privée d'un autre participant est refusé MEMORY_SCOPE_FORBIDDEN.
   */
  async prepareRetire(
    id: string,
    version?: number,
    cycleId = 'default',
    ownerDecisionRef?: string,
    callerPid?: string,
  ): Promise<MemoryMutation> {
    await ensureSchema(this.db);
    const target =
      version != null
        ? await this.get(id, version)
        : await this.db
            .prepare(
              `SELECT * FROM memory_entries WHERE id = ?1 AND status IN ('active','candidate') ORDER BY version DESC LIMIT 1`,
            )
            .bind(id)
            .first<StoredMemory>();
    if (!target) throw new MemoryStoreError('MEMORY_NOT_FOUND', `Memory ${id} not found for retire`);
    // CRB-R1 (revue Sol) : un scope participant est privé — son propriétaire seul retire.
    assertParticipantScopeAllowed(target.scope, callerPid, 'memory.retire');
    // CR-D : jamais de retrait dans une lignée enregistrée sous plusieurs scopes.
    await this.assertIdScope(id, target.scope, 'memory.retire');
    if (PROTECTED_KINDS.has(target.kind)) {
      await this.requireOwnerDecision(ownerDecisionRef, { exact: retireRequestId(id, target.version) });
    }
    const retKey = `${META_RET}${cycleId}:${target.scope}`;
    await this.assertCycleCap(retKey, MAX_RETIREMENTS_PER_CYCLE, 'RETIREMENT_CAP');
    return {
      statements: [
        this.db
          .prepare(`UPDATE memory_entries SET status = 'retired' WHERE id = ?1 AND version = ?2`)
          .bind(id, target.version),
        this.db
          .prepare(
            `INSERT INTO quota_counters (day, writes) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET writes = writes + 1`,
          )
          .bind(retKey),
        // CR-B (CR-02) : garde transactionnelle d'effet — le batch ne passe que
        // si la ligne est durablement retired (fail-closed, jamais un applied
        // sans effet mémoire).
        this.statusEffectGuard(id, target.version, 'retired'),
        // CR-D : au commit, l'id n'a toujours qu'un scope.
        this.scopeIdentityGuard(id, target.scope),
      ],
      verifyIndex: 0,
      summary: { id, version: target.version, status: 'retired' },
    };
  }

  async get(id: string, version: number): Promise<StoredMemory | null> {
    await ensureSchema(this.db);
    return this.db
      .prepare(`SELECT * FROM memory_entries WHERE id = ?1 AND version = ?2`)
      .bind(id, version)
      .first<StoredMemory>();
  }

  /**
   * Active entries visible to callerPid.
   * participant:<other> is hidden unless caller matches (fail-closed isolation).
   */
  async listActiveFor(callerPid: string, scopes: string[], limit = 50): Promise<StoredMemory[]> {
    await ensureSchema(this.db);
    if (scopes.length === 0) return [];
    const allowed = scopes.filter((s) => {
      if (!s.startsWith('participant:')) return true;
      return s === `participant:${callerPid}`;
    });
    if (allowed.length === 0) return [];
    const placeholders = allowed.map((_, i) => `?${i + 1}`).join(',');
    const { results } = await this.db
      .prepare(
        `SELECT * FROM memory_entries WHERE status = 'active' AND scope IN (${placeholders})
         ORDER BY version DESC LIMIT ?${allowed.length + 1}`,
      )
      .bind(...allowed, limit)
      .all<StoredMemory>();
    return results ?? [];
  }

  /** Shared-scope helper (system caller). Prefer listActiveFor. */
  async listActive(scopes: string[], limit = 50): Promise<StoredMemory[]> {
    return this.listActiveFor('system', scopes, limit);
  }

  async recordRefute(id: string, byPid: string): Promise<number> {
    await ensureSchema(this.db);
    const active = await this.db
      .prepare(`SELECT * FROM memory_entries WHERE id = ?1 AND status = 'active' ORDER BY version DESC LIMIT 1`)
      .bind(id)
      .first<StoredMemory>();
    if (!active) throw new MemoryStoreError('MEMORY_NO_ACTIVE', `No active version for ${id}`);
    const refs: string[] = JSON.parse(active.evidence_refs || '[]');
    refs.push(`refute:${byPid}:${Date.now()}`);
    await this.db
      .prepare(`UPDATE memory_entries SET evidence_refs = ?1, uses = uses + 1 WHERE id = ?2 AND version = ?3`)
      .bind(JSON.stringify(refs), id, active.version)
      .run();
    const refuteCount = refs.filter((r) => r.startsWith('refute:')).length;
    if (refuteCount > 5) {
      await this.raiseAlarm({
        code: 'REFUTE_THRESHOLD',
        message: `Memory ${id} has ${refuteCount} refutes (>5)`,
        scope: active.scope,
        details: { id, refuteCount },
      });
    }
    return refuteCount;
  }

  async expireHypotheses(currentCycleRev: number): Promise<number> {
    await ensureSchema(this.db);
    const { results } = await this.db
      .prepare(
        `SELECT id, version FROM memory_entries
         WHERE confidence = 'hypothesis' AND status IN ('active','candidate')
           AND expires_rev IS NOT NULL AND expires_rev <= ?1`,
      )
      .bind(currentCycleRev)
      .all<{ id: string; version: number }>();
    let n = 0;
    for (const row of results ?? []) {
      await this.db
        .prepare(`UPDATE memory_entries SET status = 'retired' WHERE id = ?1 AND version = ?2`)
        .bind(row.id, row.version)
        .run();
      n += 1;
    }
    return n;
  }

  /**
   * CR-B (CR-02) : INSERT candidate partagé par preparePropose et
   * prepareSupersede — SQL unique, binds identiques (un supersede passe
   * expires_rev = null : pas d'expiry sur les versions consolidées).
   */
  private insertCandidate(
    entry: MemoryEntry,
    id: string,
    version: number,
    supersedes: string | null,
    expiresRev: number | null,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO memory_entries
         (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid, supersedes, uses, last_used_rev, expires_rev, token_cost)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'candidate', ?8, '', ?9, 0, NULL, ?10, ?11)`,
      )
      .bind(
        id,
        version,
        entry.scope,
        entry.kind,
        entry.text,
        JSON.stringify(entry.evidence_refs),
        entry.confidence,
        entry.author_pid,
        supersedes,
        expiresRev,
        // A03/F3 (review Sol): persist the canonical cost so the in-batch
        // budget guard measures exactly what estimateTokens measures.
        estimateTokens(entry.text),
      );
  }

  /**
   * CR-B (CR-02) : garde transactionnelle d'effet partagée par prepareSupersede
   * et prepareRetire — la ligne visée doit être durablement au statut attendu,
   * sinon tout le batch du caller roule en arrière (jamais un applied sans
   * effet mémoire).
   */
  private statusEffectGuard(id: string, version: number, status: 'superseded' | 'retired'): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO collab_store_guard (ok) SELECT CASE WHEN EXISTS (SELECT 1 FROM memory_entries WHERE id = ?1 AND version = ?2 AND status = ?3) THEN 1 ELSE 0 END`,
      )
      .bind(id, version, status);
  }

  /**
   * CR-D (GPT6-02) : pré-check read-only — l'id ne doit avoir aucune version,
   * quel que soit son statut, dans un autre scope que `scope`. Une lignée
   * ancienne déjà incohérente (plusieurs scopes) est figée : fail-closed.
   */
  private async assertIdScope(id: string, scope: string, type: string): Promise<void> {
    const other = await this.db
      .prepare(`SELECT 1 AS found FROM memory_entries WHERE id = ?1 AND scope <> ?2 LIMIT 1`)
      .bind(id, scope)
      .first<{ found: number }>();
    if (other) throw scopeMismatch(id, type);
  }

  /**
   * CR-D (GPT6-02) : garde transactionnelle du même invariant, re-vérifiée au
   * commit dans le batch du caller (course entre deux cycles distincts que le
   * CAS de révision du journal ne sérialise pas).
   */
  private scopeIdentityGuard(id: string, scope: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO collab_store_guard (ok) SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM memory_entries WHERE id = ?1 AND scope <> ?2) THEN 1 ELSE 0 END`,
      )
      .bind(id, scope);
  }

  /** Budget is per exact scope string (not whole family). */
  private async assertBudgetAllows(scope: string, text: string): Promise<void> {
    const family = scopeFamily(scope);
    const budget = MEMORY_TOKEN_BUDGETS[family] ?? 500;
    const { results } = await this.db
      .prepare(`SELECT text FROM memory_entries WHERE status = 'active' AND scope = ?1`)
      .bind(scope)
      .all<{ text: string }>();
    const used = (results ?? []).reduce((s, r) => s + estimateTokens(r.text), 0);
    if (used + estimateTokens(text) > budget) {
      throw new MemoryStoreError(
        'MEMORY_BUDGET_EXCEEDED',
        `Scope ${scope} budget ${budget} tokens exceeded (used ${used}); consolidate/retire first`,
      );
    }
  }

  /** A03: fail with the contract error when a scope's activations are paused. */
  private async assertNotPaused(scope: string): Promise<void> {
    if (await this.isActivationPaused(scope)) {
      throw new MemoryStoreError('ACTIVATION_PAUSED', `Activations paused for scope ${scope}`);
    }
  }

  /**
   * A03: derive the growth alarm from the committed transaction state. The
   * activation batch owns every write (baseline, pause, occurrence); this
   * read-only derivation keeps getAlarms() consistent without reopening a
   * post-mutation write window.
   */
  private async growthAlarmFor(scope: string): Promise<MemoryAlarm | null> {
    const countRow = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE status = 'active' AND scope = ?1`)
      .bind(scope)
      .first<{ n: number }>();
    const baseRow = await this.db
      .prepare(`SELECT writes FROM quota_counters WHERE day = ?1`)
      .bind(baselineKey(scope))
      .first<{ writes: number }>();
    if (!baseRow) return null;
    const n = countRow?.n ?? 0;
    const growth = ((n - baseRow.writes) / baseRow.writes) * 100;
    if (growth > GROWTH_ALARM_PERCENT) {
      return {
        code: 'GROWTH_THRESHOLD',
        message: `Net growth ${growth.toFixed(0)}% > ${GROWTH_ALARM_PERCENT}% on ${scope}`,
        scope,
        details: { baseline: baseRow.writes, current: n },
      };
    }
    return null;
  }

  private async raiseAlarm(alarm: MemoryAlarm): Promise<void> {
    this.localAlarms.push(alarm);
    const setPause = (key: string) =>
      this.db.prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, 1)`).bind(key);
    if (!alarm.scope) {
      await setPause('mem:pause').run();
      return;
    }
    // Each pause event is a new occurrence; clearing must target it exactly.
    // CR-F02 (#93) : pause, nouvelle occurrence et owner.request exacte de cette
    // occurrence dans UNE transaction — jamais une pause sans demande de reprise.
    const occurrenceBefore = await this.occurrenceOf(alarm.scope);
    await this.db.batch([
      setPause(pauseKey(alarm.scope)),
      this.db
        .prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, ?2)`)
        .bind(occurrenceKey(alarm.scope), occurrenceBefore + 1),
      ...await alarmRequestStatements(this.db, alarm.scope, occurrenceBefore,
        ALARM_REASONS[alarm.code], Math.floor(Date.now() / 1000)),
    ]);
  }

  /**
   * C5 owner_decisions: decision must be exactly 'approve'.
   * subject is the exact request_id the decision must target — every
   * protected mutation is occurrence-bound, pause clearing included. The C5
   * channel request_id itself encodes the subject (':' is not allowed there).
   */
  private async requireOwnerDecision(
    ref: string | undefined,
    subject: { exact: string },
  ): Promise<void> {
    if (!ref || !ref.trim()) {
      throw new MemoryStoreError('PROTECTED_KIND_OWNER_REQUIRED', 'owner_decision_ref required');
    }
    if (ref !== subject.exact) {
      throw new MemoryStoreError(
        'OWNER_DECISION_SUBJECT',
        `owner_decision_ref ${ref} does not target subject ${subject.exact}`,
      );
    }
    const row = await this.db
      .prepare(`SELECT request_id, decision FROM owner_decisions WHERE request_id = ?1`)
      .bind(ref)
      .first<{ request_id: string; decision: string }>();
    if (!row || row.decision !== 'approve') {
      throw new MemoryStoreError(
        'OWNER_DECISION_INVALID',
        `No approve owner_decisions row for ${ref} (C5 channel)`,
      );
    }
  }

  private async assertCycleCap(key: string, max: number, code: string): Promise<void> {
    const row = await this.db
      .prepare(`SELECT writes FROM quota_counters WHERE day = ?1`)
      .bind(key)
      .first<{ writes: number }>();
    if ((row?.writes ?? 0) >= max) {
      throw new MemoryStoreError(code, `${code}: ${key} cap ${max} reached; consolidate review required`);
    }
  }

  /**
   * CR-F03 (#95, contre-revue Codex #79/6096598889) : une consolidation qui HAUSSE
   * la confiance exige une preuve du registre evidence_ledger — ref evidence_ref ou
   * `ledger:<seq>` — produite par un pair DISTINCT de l'auteur (aucune
   * auto-validation), et NOUVELLE : le ref résolu ne doit figurer dans les evidence_refs
   * d'AUCUNE version de la lignée de l'id, quel que soit son statut (revue
   * Claude PR #100/6098002656) — une consolidation qui le retire ne le
   * blanchit pas, les deux formes du ref (evidence_ref, `ledger:<seq>`) étant
   * vérifiées. Retourne le ref résolu, à joindre aux evidence_refs de la
   * nouvelle version.
   */
  private async requireRaiseEvidence(
    peerEvidenceRef: string | undefined,
    authorPid: string,
    id: string,
  ): Promise<string> {
    if (!peerEvidenceRef || peerEvidenceRef.startsWith(`self:${authorPid}`)) {
      throw new MemoryStoreError(
        'PEER_EVIDENCE_REQUIRED',
        'raising confidence requires a NEW peer ledger evidence_ref (peer_evidence_ref)',
      );
    }
    const seqMatch = /^ledger:(\d+)$/.exec(peerEvidenceRef);
    let row: { seq: number; producer: string; evidence_ref: string } | null = null;
    if (seqMatch) {
      row = await this.db
        .prepare(`SELECT seq, producer, evidence_ref FROM evidence_ledger WHERE seq = ?1`)
        .bind(Number(seqMatch[1]))
        .first();
    } else {
      row = await this.db
        .prepare(`SELECT seq, producer, evidence_ref FROM evidence_ledger WHERE evidence_ref = ?1 LIMIT 1`)
        .bind(peerEvidenceRef)
        .first();
    }
    if (!row) {
      throw new MemoryStoreError('PEER_EVIDENCE_NOT_FOUND', `No evidence_ledger row for ${peerEvidenceRef}`);
    }
    if (row.producer === authorPid) {
      throw new MemoryStoreError('PEER_EVIDENCE_SELF', 'ledger producer cannot be the memory author');
    }
    const ledgerRef = row.evidence_ref || `ledger:${row.seq}`;
    // Anti-recyclage sur la lignée ENTIÈRE de l'id (revue Claude PR
    // #100/6098002656) : le ref résolu — ou son alias `ledger:<seq>` — ne doit
    // soutenir aucune version de l'id, active, superseded ou retirée. Une
    // consolidation intermédiaire qui retire le ref ne le blanchit pas.
    const recycled = await this.db
      .prepare(
        [
          'SELECT 1 FROM memory_entries m, json_each(COALESCE(m.evidence_refs, \'[]\')) j',
          'WHERE m.id = ?1 AND j.value IN (?2, ?3) LIMIT 1',
        ].join(' '),
      )
      .bind(id, row.evidence_ref, `ledger:${row.seq}`)
      .first();
    if (recycled) {
      throw new MemoryStoreError(
        'PEER_EVIDENCE_REQUIRED',
        `evidence ${ledgerRef} already backs a version of ${id}: a confidence raise requires a NEW peer evidence`,
      );
    }
    return ledgerRef;
  }

  /**
   * peerEvidenceRef must match evidence_ledger.evidence_ref or ledger:<seq>,
   * with producer === reviewerPid and producer ≠ authorPid.
   */
  private async requirePeerLedgerEvidence(
    peerEvidenceRef: string,
    reviewerPid: string,
    authorPid: string,
  ): Promise<string> {
    if (!peerEvidenceRef || peerEvidenceRef.startsWith(`self:${authorPid}`)) {
      throw new MemoryStoreError('PEER_EVIDENCE_REQUIRED', 'evidence_ref must be a ledger entry from peer');
    }
    const seqMatch = /^ledger:(\d+)$/.exec(peerEvidenceRef);
    let row: { seq: number; producer: string; evidence_ref: string } | null = null;
    if (seqMatch) {
      row = await this.db
        .prepare(`SELECT seq, producer, evidence_ref FROM evidence_ledger WHERE seq = ?1`)
        .bind(Number(seqMatch[1]))
        .first();
    } else {
      row = await this.db
        .prepare(`SELECT seq, producer, evidence_ref FROM evidence_ledger WHERE evidence_ref = ?1 LIMIT 1`)
        .bind(peerEvidenceRef)
        .first();
    }
    if (!row) {
      throw new MemoryStoreError(
        'PEER_EVIDENCE_NOT_FOUND',
        `No evidence_ledger row for ${peerEvidenceRef}`,
      );
    }
    if (row.producer !== reviewerPid) {
      throw new MemoryStoreError(
        'PEER_EVIDENCE_PRODUCER',
        `ledger producer ${row.producer} must equal reviewer ${reviewerPid}`,
      );
    }
    if (row.producer === authorPid) {
      throw new MemoryStoreError('PEER_EVIDENCE_SELF', 'ledger producer cannot be the memory author');
    }
    return row.evidence_ref || `ledger:${row.seq}`;
  }

  private async latestVersion(id: string): Promise<StoredMemory | null> {
    return this.db
      .prepare(`SELECT * FROM memory_entries WHERE id = ?1 ORDER BY version DESC LIMIT 1`)
      .bind(id)
      .first<StoredMemory>();
  }
}

const CONFIDENCE_RANK: Record<MemoryConfidence, number> = {
  hypothesis: 0,
  observed: 1,
  verified: 2,
  owner_validated: 3,
};

function confidenceRank(c: MemoryConfidence): number {
  return CONFIDENCE_RANK[c] ?? -1;
}
