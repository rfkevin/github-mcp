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

  async isActivationPaused(): Promise<boolean> {
    await ensureSchema(this.db);
    const row = await this.db
      .prepare(`SELECT writes FROM quota_counters WHERE day = ?1`)
      .bind(META_PAUSE)
      .first<{ writes: number }>();
    return (row?.writes ?? 0) > 0;
  }

  /** Clear pause only when a real owner_decisions row exists (C5). */
  async clearActivationPause(ownerDecisionRef: string): Promise<void> {
    await this.requireOwnerDecision(ownerDecisionRef);
    await this.db
      .prepare(`INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, 0)`)
      .bind(META_PAUSE)
      .run();
  }

  /** Insert a candidate (status=candidate, version=1 or next). */
  async propose(input: ProposeInput): Promise<StoredMemory> {
    await ensureSchema(this.db);
    if (PROTECTED_KINDS.has(input.kind)) {
      await this.requireOwnerDecision(input.owner_decision_ref);
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
  async activate(id: string, version: number, reviewerPid: string): Promise<StoredMemory> {
    await ensureSchema(this.db);
    if (await this.isActivationPaused()) {
      throw new MemoryStoreError('ACTIVATION_PAUSED', 'Activations paused pending owner.request');
    }
    const row = await this.get(id, version);
    if (!row) throw new MemoryStoreError('MEMORY_NOT_FOUND', `Memory ${id}@${version} not found`);
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
    await this.assertCycleCap(META_ACT, MAX_ACTIVATIONS_PER_CYCLE, 'ACTIVATION_CAP');
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
    await this.bumpCycleCap(META_ACT);
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
    if (PROTECTED_KINDS.has(active.kind) || PROTECTED_KINDS.has(nextKind)) {
      await this.requireOwnerDecision(ownerDecisionRef);
    }
    if (conf === 'hypothesis' && PROTECTED_KINDS.has(nextKind)) {
      throw new MemoryStoreError('HYPOTHESIS_NOT_RULE', 'hypothesis cannot supersede into a rule kind');
    }
    const conf = confidence ?? (active.confidence as MemoryConfidence);
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
      this.raiseAlarm({
        code: 'INVARIANT_TOUCHED',
        message: `Protected kind supersede on ${id}`,
        scope: active.scope,
        details: { id, ownerDecisionRef },
      });
    }
    return (await this.get(id, nextVersion))!;
  }

  /** Retire (tombstone): status=retired, row kept. */
  async retire(id: string, version?: number): Promise<StoredMemory> {
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
    await this.db
      .prepare(`UPDATE memory_entries SET status = 'retired' WHERE id = ?1 AND version = ?2`)
      .bind(id, target.version)
      .run();
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
    if (refuteCount >= REFUTE_ALARM_THRESHOLD) {
      this.raiseAlarm({
        code: 'REFUTE_THRESHOLD',
        message: `Memory ${id} has ${refuteCount} refutes`,
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

  private async assertBudgetAllows(scope: string, text: string): Promise<void> {
    const family = scopeFamily(scope);
    const budget = MEMORY_TOKEN_BUDGETS[family] ?? 500;
    let used = 0;
    if (family === 'common') {
      const common = await this.db
        .prepare(`SELECT text FROM memory_entries WHERE status = 'active' AND scope = 'common'`)
        .all<{ text: string }>();
      used = (common.results ?? []).reduce((s, r) => s + estimateTokens(r.text), 0);
    } else {
      const { results } = await this.db
        .prepare(`SELECT text FROM memory_entries WHERE status = 'active' AND scope LIKE ?1`)
        .bind(`${family}:%`)
        .all<{ text: string }>();
      used = (results ?? []).reduce((s, r) => s + estimateTokens(r.text), 0);
    }
    if (used + estimateTokens(text) > budget) {
      throw new MemoryStoreError(
        'MEMORY_BUDGET_EXCEEDED',
        `Scope ${family} budget ${budget} tokens exceeded (used ${used}); consolidate/retire first`,
      );
    }
  }

  private async checkGrowthAlarm(scope: string): Promise<void> {
    const family = scopeFamily(scope);
    const countRow =
      family === 'common'
        ? await this.db
            .prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE status = 'active' AND scope = 'common'`)
            .first<{ n: number }>()
        : await this.db
            .prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE status = 'active' AND scope LIKE ?1`)
            .bind(`${family}:%`)
            .first<{ n: number }>();
    const n = countRow?.n ?? 0;
    if (this.baselineActiveCount == null) this.baselineActiveCount = Math.max(1, n - 1);
    const growth = ((n - this.baselineActiveCount) / this.baselineActiveCount) * 100;
    if (growth > GROWTH_ALARM_PERCENT) {
      this.raiseAlarm({
        code: 'GROWTH_THRESHOLD',
        message: `Net growth ${growth.toFixed(0)}% > ${GROWTH_ALARM_PERCENT}% on ${family}`,
        scope,
        details: { baseline: this.baselineActiveCount, current: n },
      });
    }
  }

  private raiseAlarm(alarm: MemoryAlarm): void {
    this.alarms.push(alarm);
    this.activationPaused = true;
  }

  private async latestVersion(id: string): Promise<StoredMemory | null> {
    return this.db
      .prepare(`SELECT * FROM memory_entries WHERE id = ?1 ORDER BY version DESC LIMIT 1`)
      .bind(id)
      .first<StoredMemory>();
  }
}
