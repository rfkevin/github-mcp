/**
 * CC-3 C4 — memory_entries lifecycle (plan §4, I4).
 * Versioned rows: propose → activate (reviewer ≠ author) → supersede/retire.
 * Never in-place text rewrite; never silent delete.
 * Budgets, alarms, participant isolation, protected kinds, hypothesis expiry.
 */
import {
  validateMemoryActivation,
  validateMemoryEntry,
  type MemoryConfidence,
  type MemoryEntry,
  type MemoryKind,
  type MemoryStatus,
} from '../contracts/memory';
import { StateContractError } from '../../collab/contracts';
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

const META_PAUSE = 'mem:pause';
const META_ACT = 'mem:act:';
const META_RET = 'mem:ret:';
const META_BASE = 'mem:base:';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

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

  /** Clear pause for a scope; owner_decision_ref must be memory-pause:<scope> approve. */
  async clearActivationPause(ownerDecisionRef: string, scope?: string): Promise<void> {
    await this.requireOwnerDecision(ownerDecisionRef, scope ? `memory-pause:${scope}` : 'memory-pause:');
    if (scope) {
      await this.db
        .prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, 0)`)
        .bind(`${META_PAUSE}:${scope}`)
        .run();
      return;
    }
    // Clear all pause keys (test helper)
    const { results } = await this.db
      .prepare(`SELECT day FROM quota_counters WHERE day LIKE ?1`)
      .bind(`${META_PAUSE}:%`)
      .all<{ day: string }>();
    for (const r of results ?? []) {
      await this.db.prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, 0)`).bind(r.day).run();
    }
  }

  /** Insert a candidate (status=candidate, version=1 or next). */
  async propose(input: ProposeInput): Promise<StoredMemory> {
    await ensureSchema(this.db);
    if (PROTECTED_KINDS.has(input.kind)) {
      // request_id must target memory:* (C5 subject), not a random approve
      await this.requireOwnerDecision(input.owner_decision_ref, 'memory:');
    }
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
    await this.db
      .prepare(
        `INSERT INTO memory_entries
         (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid, supersedes, uses, last_used_rev, expires_rev)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'candidate', ?8, '', ?9, 0, NULL, ?10)`,
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
      )
      .run();
    return (await this.get(id, version))!;
  }

  /** Activate candidate → active; reviewer ≠ author; budget enforced (I4 / §4). */
  async activate(
    id: string,
    version: number,
    reviewerPid: string,
    cycleId = 'default',
  ): Promise<StoredMemory> {
    await ensureSchema(this.db);
    const row = await this.get(id, version);
    if (!row) throw new MemoryStoreError('MEMORY_NOT_FOUND', `Memory ${id}@${version} not found`);
    if (await this.isActivationPaused(row.scope)) {
      throw new MemoryStoreError('ACTIVATION_PAUSED', `Activations paused for scope ${row.scope}`);
    }
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
    await this.assertCycleCap(`${META_ACT}${cycleId}:${row.scope}`, MAX_ACTIVATIONS_PER_CYCLE, 'ACTIVATION_CAP');
    await this.assertBudgetAllows(row.scope, row.text);
    const priorActive = await this.db
      .prepare(`SELECT version FROM memory_entries WHERE id = ?1 AND status = 'active' ORDER BY version DESC LIMIT 1`)
      .bind(id)
      .first<{ version: number }>();
    const stmts: D1PreparedStatement[] = [];
    if (priorActive) {
      stmts.push(
        this.db
          .prepare(`UPDATE memory_entries SET status = 'superseded' WHERE id = ?1 AND version = ?2`)
          .bind(id, priorActive.version),
      );
    }
    stmts.push(
      this.db
        .prepare(
          `UPDATE memory_entries SET status = 'active', reviewer_pid = ?1 WHERE id = ?2 AND version = ?3 AND status = 'candidate'`,
        )
        .bind(reviewerPid, id, version),
    );
    await this.db.batch(stmts);
    const activated = await this.get(id, version);
    if (!activated || activated.status !== 'active') {
      throw new MemoryStoreError('ACTIVATION_RACE', `Candidate ${id}@${version} was not activated (concurrent change)`);
    }
    await this.bumpCycleCap(`${META_ACT}${cycleId}:${row.scope}`);
    await this.checkGrowthAlarm(row.scope);
    if (PROTECTED_KINDS.has(row.kind)) {
      await this.raiseAlarm({
        code: 'INVARIANT_TOUCHED',
        message: `Protected kind ${row.kind} activated on ${id}`,
        scope: row.scope,
        details: { id, version },
      });
    }
    return (await this.get(id, version))!;
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
    if (PROTECTED_KINDS.has(active.kind) || PROTECTED_KINDS.has(nextKind)) {
      await this.requireOwnerDecision(ownerDecisionRef, `memory:${id}`);
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
    const nextVersion = active.version + 1;
    await this.db.batch([
      this.db
        .prepare(`UPDATE memory_entries SET status = 'superseded' WHERE id = ?1 AND version = ?2 AND status = 'active'`)
        .bind(id, active.version),
      this.db
        .prepare(
          `INSERT INTO memory_entries
           (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid, supersedes, uses, last_used_rev, expires_rev)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'candidate', ?8, '', ?9, 0, NULL, NULL)`,
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
   */
  async promoteConfidence(
    id: string,
    version: number,
    reviewerPid: string,
    peerEvidenceRef: string,
    newConfidence: MemoryConfidence,
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
   */
  async promoteScope(
    id: string,
    version: number,
    reviewerPid: string,
    newScope: string,
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
           (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid, supersedes, uses, last_used_rev, expires_rev)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'candidate', ?8, '', ?9, 0, NULL, NULL)`,
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
        ),
    ]);
    return (await this.get(id, nextVersion))!;
  }

  /** Retire (tombstone): status=retired, row kept. Cap ≤10 per cycle+scope. */
  async retire(id: string, version?: number, cycleId = 'default'): Promise<StoredMemory> {
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

  private async checkGrowthAlarm(scope: string): Promise<void> {
    const countRow = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE status = 'active' AND scope = ?1`)
      .bind(scope)
      .first<{ n: number }>();
    const n = countRow?.n ?? 0;
    const baseKey = META_BASE + scope;
    let baseRow = await this.db
      .prepare(`SELECT writes FROM quota_counters WHERE day = ?1`)
      .bind(baseKey)
      .first<{ writes: number }>();
    if (!baseRow) {
      const baseline = Math.max(1, n - 1);
      await this.db
        .prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, ?2)`)
        .bind(baseKey, baseline)
        .run();
      baseRow = { writes: baseline };
    }
    const growth = ((n - baseRow.writes) / baseRow.writes) * 100;
    if (growth > GROWTH_ALARM_PERCENT) {
      await this.raiseAlarm({
        code: 'GROWTH_THRESHOLD',
        message: `Net growth ${growth.toFixed(0)}% > ${GROWTH_ALARM_PERCENT}% on ${scope}`,
        scope,
        details: { baseline: baseRow.writes, current: n },
      });
    }
  }

  private async raiseAlarm(alarm: MemoryAlarm): Promise<void> {
    this.localAlarms.push(alarm);
    const key = alarm.scope ? `${META_PAUSE}:${alarm.scope}` : META_PAUSE;
    await this.db
      .prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, 1)`)
      .bind(key)
      .run();
  }

  /**
   * C5 owner_decisions: decision must be exactly 'approve'.
   * subjectPrefix e.g. memory-pause:scope or memory:id — request_id must start with it.
   */
  private async requireOwnerDecision(
    ref: string | undefined,
    subjectPrefix?: string,
  ): Promise<void> {
    if (!ref || !ref.trim()) {
      throw new MemoryStoreError('PROTECTED_KIND_OWNER_REQUIRED', 'owner_decision_ref required');
    }
    if (subjectPrefix && !ref.startsWith(subjectPrefix) && ref !== subjectPrefix) {
      // allow exact match or prefix: request_id encodes subject
      if (!ref.includes(subjectPrefix.replace(/:$/, ''))) {
        throw new MemoryStoreError(
          'OWNER_DECISION_SUBJECT',
          `owner_decision_ref ${ref} does not target ${subjectPrefix}`,
        );
      }
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
      throw new MemoryStoreError(code, `${key} cap ${max} reached; consolidate review required`);
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
