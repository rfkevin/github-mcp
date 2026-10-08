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
export const PAUSE_REQUEST_PREFIX = 'mem-pause-';
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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Pause-clearing approvals are bound to the scope's current pause occurrence. */
export async function pauseRequestId(scope: string, occurrence: number): Promise<string> {
  return PAUSE_REQUEST_PREFIX + (await sha256Hex(scope)).slice(0, 20) + '-' + occurrence;
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

const META_PAUSE = 'mem:pause';
const META_OCC = 'mem:occ:';
const META_ACT = 'mem:act:';
const META_RET = 'mem:ret:';
const META_BASE = 'mem:base:';

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
        .bind(`${META_PAUSE}:${scope}`)
        .first<{ writes: number }>();
      return (row?.writes ?? 0) > 0;
    }
    // Any paused scope (for tests / diagnostics)
    const { results } = await this.db
      .prepare(`SELECT writes FROM quota_counters WHERE day LIKE ?1 AND writes > 0 LIMIT 1`)
      .bind(`${META_PAUSE}:%`)
      .all<{ writes: number }>();
    return (results?.length ?? 0) > 0;
  }

  /**
   * Current pause-clearing request_id for a scope: the approval must target
   * the live pause occurrence exactly (plan §4 Protected, tests T3/T4).
   */
  async pauseClearRequestId(scope: string): Promise<string> {
    await ensureSchema(this.db);
    const row = await this.db
      .prepare(`SELECT writes FROM quota_counters WHERE day = ?1`)
      .bind(`${META_OCC}${scope}`)
      .first<{ writes: number }>();
    return pauseRequestId(scope, row?.writes ?? 0);
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
      .bind(`${META_PAUSE}:${scope}`)
      .run();
  }

  /** Insert a candidate (status=candidate, version=1 or next). */
  async propose(input: ProposeInput): Promise<StoredMemory> {
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
    await this.db
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
        input.supersedes ?? null,
        expiresRev,
        // A03/F3 (review Sol): persist the canonical cost so the in-batch
        // budget guard measures exactly what estimateTokens measures.
        estimateTokens(entry.text),
      )
      .run();
    return (await this.get(id, version))!;
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
    await ensureSchema(this.db);
    const row = await this.get(id, version);
    if (!row) throw new MemoryStoreError('MEMORY_NOT_FOUND', `Memory ${id}@${version} not found`);
    await this.assertNotPaused(row.scope);
    if (row.status !== 'candidate') {
      throw new MemoryStoreError('MEMORY_NOT_CANDIDATE', `Memory ${id}@${version} status is ${row.status}`);
    }
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
    const pauseKey = `${META_PAUSE}:${row.scope}`;
    const baseKey = `${META_BASE}${row.scope}`;
    const occKey = `${META_OCC}${row.scope}`;
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
        '  AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE day = ?3 AND writes > 0)',
        '  AND COALESCE((SELECT writes FROM quota_counters WHERE day = ?4), 0) < ?5',
        `  AND COALESCE((SELECT SUM(COALESCE(token_cost, (length(text) + 3) / 4)) FROM memory_entries WHERE status = 'active' AND scope = ?6), 0) + ?7 <= ?8`,
        '  THEN 1 ELSE 0 END',
      ].join(' ')).bind(id, version, pauseKey, capKey, MAX_ACTIVATIONS_PER_CYCLE, row.scope, newTokens, budget),
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
    statements.push(
      this.db
        .prepare(`UPDATE memory_entries SET status = 'superseded' WHERE id = ?1 AND status = 'active' AND version <> ?2`)
        .bind(id, version),
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
        .bind(pauseKey, row.scope, baseKey),
      this.db.prepare(`${bumpOccurrence} WHERE ${growthExceeded}`).bind(occKey, row.scope, baseKey),
    );
    if (protectedKind) {
      // A03: INVARIANT_TOUCHED pause + occurrence, also inside the batch.
      statements.push(
        this.db.prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, 1)`).bind(pauseKey),
        this.db.prepare(bumpOccurrence).bind(occKey),
      );
    }
    statements.push(this.db.prepare(`DELETE FROM collab_store_guard`));
    let results: Array<{ meta?: { changes?: number } }>;
    try {
      results = (await this.db.batch(statements)) as unknown as Array<{ meta?: { changes?: number } }>;
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
      await this.assertNotPaused(row.scope);
      await this.assertCycleCap(capKey, MAX_ACTIVATIONS_PER_CYCLE, 'ACTIVATION_CAP');
      await this.assertBudgetAllows(row.scope, row.text);
      throw error;
    }
    // A03: explicit CAS control — the activation UPDATE must have applied
    // exactly one row. The batch's own change count is authoritative: a
    // concurrent activation of another candidate version of the same id can
    // supersede this row between our own commit and the durable re-read —
    // that is the expected I4 convergence (exactly one active version), not
    // a race. The re-read only backs the check up when meta is unavailable.
    const activated = await this.get(id, version);
    const changes = results[activateIndex]?.meta?.changes;
    if (changes === 0 || !activated || (changes !== 1 && activated.status === 'candidate')) {
      throw new MemoryStoreError('ACTIVATION_RACE', `Candidate ${id}@${version} was not activated (concurrent change)`);
    }
    const growth = await this.growthAlarmFor(row.scope);
    if (growth) this.localAlarms.push(growth);
    if (protectedKind) {
      this.localAlarms.push({
        code: 'INVARIANT_TOUCHED',
        message: `Protected kind ${row.kind} activated on ${id}`,
        scope: row.scope,
        details: { id, version },
      });
    }
    return activated;
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
  ): Promise<StoredMemory> {
    await ensureSchema(this.db);
    const active = await this.db
      .prepare(`SELECT * FROM memory_entries WHERE id = ?1 AND status = 'active' ORDER BY version DESC LIMIT 1`)
      .bind(id)
      .first<StoredMemory>();
    if (!active) throw new MemoryStoreError('MEMORY_NO_ACTIVE', `No active version for ${id}`);
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
    const entry = validateMemoryEntry({
      scope: active.scope,
      kind: nextKind,
      text,
      evidence_refs: evidenceRefs,
      confidence: conf,
      status: 'candidate',
      author_pid: authorPid,
    });
    await this.db.batch([
      this.db
        .prepare(`UPDATE memory_entries SET status = 'superseded' WHERE id = ?1 AND version = ?2 AND status = 'active'`)
        .bind(id, active.version),
      this.db
        .prepare(
          `INSERT INTO memory_entries
           (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid, supersedes, uses, last_used_rev, expires_rev, token_cost)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'candidate', ?8, '', ?9, 0, NULL, NULL, ?10)`,
        )
        .bind(
          id,
          nextVersion,
          entry.scope,
          entry.kind,
          entry.text,
          JSON.stringify(entry.evidence_refs),
          entry.confidence,
          entry.author_pid,
          `${id}@${active.version}`,
          estimateTokens(entry.text),
        ),
    ]);
    if (PROTECTED_KINDS.has(active.kind) || PROTECTED_KINDS.has(nextKind)) {
      await this.raiseAlarm({
        code: 'INVARIANT_TOUCHED',
        message: `Protected kind supersede on ${id}`,
        scope: active.scope,
        details: { id, ownerDecisionRef },
      });
    }
    return (await this.get(id, nextVersion))!;
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
      );
    }
    if (PROTECTED_KINDS.has(row.kind)) {
      // Candidate: the decision is bound to this confidence occurrence.
      await this.requireOwnerDecision(ownerDecisionRef, {
        exact: await promoteConfidenceRequestId(id, version, newConfidence),
      });
    }
    if (row.status === 'active') {
      return this.supersede(id, row.author_pid, row.text, refs, row.kind as MemoryKind, newConfidence);
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
   * promoteScopeRequestId(id, resulting version, newScope) (plan §4).
   */
  async promoteScope(
    id: string,
    version: number,
    reviewerPid: string,
    newScope: string,
    ownerDecisionRef?: string,
  ): Promise<StoredMemory> {
    await ensureSchema(this.db);
    const row = await this.get(id, version);
    if (!row) throw new MemoryStoreError('MEMORY_NOT_FOUND', `Memory ${id}@${version} not found`);
    if (row.status !== 'active') {
      throw new MemoryStoreError('MEMORY_NOT_ACTIVE', 'only active memories can be scope-promoted');
    }
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
    const nextVersion = row.version + 1;
    await this.db.batch([
      this.db
        .prepare(`UPDATE memory_entries SET status = 'superseded' WHERE id = ?1 AND version = ?2 AND status = 'active'`)
        .bind(id, row.version),
      this.db
        .prepare(
          `INSERT INTO memory_entries
           (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid, supersedes, uses, last_used_rev, expires_rev, token_cost)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'candidate', ?8, '', ?9, 0, NULL, NULL, ?10)`,
        )
        .bind(
          id,
          nextVersion,
          entry.scope,
          entry.kind,
          entry.text,
          JSON.stringify(entry.evidence_refs),
          entry.confidence,
          entry.author_pid,
          `${id}@${row.version}`,
          estimateTokens(entry.text),
        ),
    ]);
    return (await this.get(id, nextVersion))!;
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
    if (PROTECTED_KINDS.has(target.kind)) {
      await this.requireOwnerDecision(ownerDecisionRef, { exact: retireRequestId(id, target.version) });
    }
    const retKey = `${META_RET}${cycleId}:${target.scope}`;
    await this.assertCycleCap(retKey, MAX_RETIREMENTS_PER_CYCLE, 'RETIREMENT_CAP');
    await this.db
      .prepare(`UPDATE memory_entries SET status = 'retired' WHERE id = ?1 AND version = ?2`)
      .bind(id, target.version)
      .run();
    await this.bumpCycleCap(retKey);
    return (await this.get(id, target.version))!;
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
      .bind(`${META_BASE}${scope}`)
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
    const key = alarm.scope ? `${META_PAUSE}:${alarm.scope}` : META_PAUSE;
    await this.db
      .prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, 1)`)
      .bind(key)
      .run();
    if (alarm.scope) {
      // Each pause event is a new occurrence; clearing must target it exactly.
      const occKey = `${META_OCC}${alarm.scope}`;
      const occRow = await this.db
        .prepare(`SELECT writes FROM quota_counters WHERE day = ?1`)
        .bind(occKey)
        .first<{ writes: number }>();
      await this.db
        .prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, ?2)`)
        .bind(occKey, (occRow?.writes ?? 0) + 1)
        .run();
    }
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

  private async bumpCycleCap(key: string): Promise<void> {
    const row = await this.db
      .prepare(`SELECT writes FROM quota_counters WHERE day = ?1`)
      .bind(key)
      .first<{ writes: number }>();
    const next = (row?.writes ?? 0) + 1;
    await this.db
      .prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, ?2)`)
      .bind(key, next)
      .run();
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
