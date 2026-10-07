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
}

function newId(): string {
  return 'mem-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

export class MemoryStore {
  constructor(private readonly db: D1Database) {}

  /** Insert a candidate (status=candidate, version=1 or next). */
  async propose(input: ProposeInput): Promise<StoredMemory> {
    await ensureSchema(this.db);
    const entry: MemoryEntry = validateMemoryEntry({
      scope: input.scope,
      kind: input.kind,
      text: input.text,
      evidence_refs: input.evidence_refs ?? [],
      confidence: input.confidence ?? 'hypothesis',
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
        input.expires_rev ?? null,
      )
      .run();
    return (await this.get(id, version))!;
  }

  /** Activate candidate → active; reviewer must differ from author (I4). */
  async activate(id: string, version: number, reviewerPid: string): Promise<StoredMemory> {
    await ensureSchema(this.db);
    const row = await this.get(id, version);
    if (!row) throw new MemoryStoreError('MEMORY_NOT_FOUND', `Memory ${id}@${version} not found`);
    if (row.status !== 'candidate') {
      throw new MemoryStoreError('MEMORY_NOT_CANDIDATE', `Memory ${id}@${version} status is ${row.status}`);
    }
    validateMemoryActivation(row.author_pid, reviewerPid);
    if (row.evidence_refs === '[]' || !row.evidence_refs) {
      throw new StateContractError(
        'MEMORY_EVIDENCE_REQUIRED',
        'non-candidate entries require at least one evidence_ref',
        'evidence_refs',
      );
    }
    // New version row active; mark previous as superseded if any prior active of same id
    const priorActive = await this.db
      .prepare(`SELECT version FROM memory_entries WHERE id = ?1 AND status = 'active' ORDER BY version DESC LIMIT 1`)
      .bind(id)
      .first<{ version: number }>();
    if (priorActive) {
      await this.db
        .prepare(`UPDATE memory_entries SET status = 'superseded' WHERE id = ?1 AND version = ?2`)
        .bind(id, priorActive.version)
        .run();
    }
    await this.db
      .prepare(`UPDATE memory_entries SET status = 'active', reviewer_pid = ?1 WHERE id = ?2 AND version = ?3`)
      .bind(reviewerPid, id, version)
      .run();
    return (await this.get(id, version))!;
  }

  /** Supersede: retire previous active, propose new text as next version candidate. */
  async supersede(
    id: string,
    authorPid: string,
    text: string,
    evidenceRefs: string[],
    kind?: MemoryKind,
    confidence?: MemoryConfidence,
  ): Promise<StoredMemory> {
    await ensureSchema(this.db);
    const active = await this.db
      .prepare(`SELECT * FROM memory_entries WHERE id = ?1 AND status = 'active' ORDER BY version DESC LIMIT 1`)
      .bind(id)
      .first<StoredMemory>();
    if (!active) throw new MemoryStoreError('MEMORY_NO_ACTIVE', `No active version for ${id}`);
    await this.db
      .prepare(`UPDATE memory_entries SET status = 'superseded' WHERE id = ?1 AND version = ?2`)
      .bind(id, active.version)
      .run();
    return this.propose({
      id,
      scope: active.scope,
      kind: (kind ?? active.kind) as MemoryKind,
      text,
      evidence_refs: evidenceRefs,
      confidence: confidence ?? (active.confidence as MemoryConfidence),
      author_pid: authorPid,
      supersedes: `${id}@${active.version}`,
    });
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

  /** Active entries for scopes, newest version first, hard cap for packet budgets. */
  async listActive(scopes: string[], limit = 50): Promise<StoredMemory[]> {
    await ensureSchema(this.db);
    if (scopes.length === 0) return [];
    const placeholders = scopes.map((_, i) => `?${i + 1}`).join(',');
    const { results } = await this.db
      .prepare(
        `SELECT * FROM memory_entries WHERE status = 'active' AND scope IN (${placeholders})
         ORDER BY version DESC LIMIT ?${scopes.length + 1}`,
      )
      .bind(...scopes, limit)
      .all<StoredMemory>();
    return results ?? [];
  }

  private async latestVersion(id: string): Promise<StoredMemory | null> {
    return this.db
      .prepare(`SELECT * FROM memory_entries WHERE id = ?1 ORDER BY version DESC LIMIT 1`)
      .bind(id)
      .first<StoredMemory>();
  }
}
