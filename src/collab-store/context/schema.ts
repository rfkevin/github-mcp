import { ensureSchema } from '../store/schema';

const CONTEXT_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS cycle_issue_refs (issue_ref TEXT PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id))',
  'CREATE INDEX IF NOT EXISTS idx_cycle_issue_refs_cycle ON cycle_issue_refs(cycle_id)',
];

export async function ensureContextSchema(db: D1Database): Promise<void> {
  await ensureSchema(db);
  await db.batch(CONTEXT_SCHEMA.map(sql => db.prepare(sql)));
}

export function normalizeIssueRef(input: string): string {
  const value = input.trim();
  const match = value.match(/(?:issue\s*#?|#)(\d+)/i) ?? value.match(/^(\d+)$/);
  if (!match) throw new Error('INVALID_ISSUE_REF');
  return '#' + match[1];
}

export async function mapIssueToCycle(db: D1Database, issue: string, cycleId: string): Promise<void> {
  await ensureContextSchema(db);
  const issueRef = normalizeIssueRef(issue);
  await db.prepare(
    'INSERT INTO cycle_issue_refs (issue_ref, cycle_id) VALUES (?1, ?2) ON CONFLICT(issue_ref) DO UPDATE SET cycle_id = excluded.cycle_id'
  ).bind(issueRef, cycleId).run();
}
