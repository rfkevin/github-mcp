/**
 * CC-3 C4 — evidence_ledger (I11 / Sol A2).
 * Append-only objective records. producer ≠ subject unless producer is system.
 * No update/delete paths exist.
 */
import { validateLedgerEntry, type LedgerEntry } from '../contracts/memory';
import { equivalentParticipantIds, participantsEquivalent } from '../identity/families';
import { ensureSchema } from '../store/schema';
import { StateContractError } from '../../collab/contracts';

export class LedgerStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LedgerStoreError';
  }
}

export interface StoredLedgerRow {
  seq: number;
  subject_pid: string;
  producer: string;
  kind: string;
  payload_json: string;
  evidence_ref: string;
  at: number;
}

export class EvidenceLedger {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Append one objective record. Rejects self-writes (I11). */
  async append(entry: LedgerEntry): Promise<StoredLedgerRow> {
    await ensureSchema(this.db);
    const valid = validateLedgerEntry(entry);
    if (valid.producer !== 'system' && await participantsEquivalent(this.db, valid.producer, valid.subject_pid)) {
      throw new StateContractError(
        'LEDGER_SELF_WRITE',
        'A logical identity cannot produce its own ledger record, including through an equivalent participant id.',
        'producer',
      );
    }
    const at = Math.floor(this.now().getTime() / 1000);
    const result = await this.db
      .prepare(
        `INSERT INTO evidence_ledger (subject_pid, producer, kind, payload_json, evidence_ref, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         RETURNING seq, subject_pid, producer, kind, payload_json, evidence_ref, at`,
      )
      .bind(
        valid.subject_pid,
        valid.producer,
        valid.kind,
        valid.payload_json,
        valid.evidence_ref ?? '',
        at,
      )
      .first<StoredLedgerRow>();
    if (!result) throw new LedgerStoreError('LEDGER_APPEND_FAILED', 'Insert did not return a row');
    return result;
  }

  async listBySubject(subjectPid: string, limit = 100): Promise<StoredLedgerRow[]> {
    await ensureSchema(this.db);
    const equivalents = await equivalentParticipantIds(this.db, subjectPid);
    const placeholders = equivalents.map((_, index) => '?' + (index + 1)).join(',');
    const { results } = await this.db
      .prepare(
        `SELECT seq, subject_pid, producer, kind, payload_json, evidence_ref, at
         FROM evidence_ledger WHERE subject_pid IN (${placeholders}) ORDER BY seq DESC LIMIT ?${equivalents.length + 1}`,
      )
      .bind(...equivalents, limit)
      .all<StoredLedgerRow>();
    return results ?? [];
  }
}
