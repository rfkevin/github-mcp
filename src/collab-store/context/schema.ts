import { ensureSchema } from '../store/schema';
import { CollabStoreError } from '../store/collab-store';

const CONTEXT_SCHEMA = [
  [
    'CREATE TABLE IF NOT EXISTS cycle_issue_refs_v2 (',
    'repository TEXT NOT NULL, issue_number INTEGER NOT NULL,',
    'cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id),',
    'PRIMARY KEY (repository, issue_number))',
  ].join(' '),
  'CREATE INDEX IF NOT EXISTS idx_cycle_issue_refs_v2_cycle ON cycle_issue_refs_v2(cycle_id)',
];

export interface NormalizedIssueRef {
  repository?: string;
  issue_number: number;
}

export async function ensureContextSchema(db: D1Database): Promise<void> {
  await ensureSchema(db);
  await db.batch(CONTEXT_SCHEMA.map(sql => db.prepare(sql)));
}

export function normalizeIssueRef(input: string): NormalizedIssueRef {
  const value = input.trim();
  const qualified = value.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/);
  if (qualified) return { repository: qualified[1], issue_number: Number(qualified[2]) };
  const match = value.match(/(?:issue\s*#?|#)(\d+)/i) ?? value.match(/^(\d+)$/);
  if (!match) {
    throw new CollabStoreError('INVALID_ISSUE_REF', 'Référence issue invalide : ' + input);
  }
  return { issue_number: Number(match[1]) };
}

export async function mapIssueToCycle(
  db: D1Database,
  issue: string,
  cycleId: string,
  repository?: string,
): Promise<void> {
  await ensureContextSchema(db);
  const issueRef = normalizeIssueRef(issue);
  const cycle = await db.prepare('SELECT project FROM cycles WHERE cycle_id = ?1')
    .bind(cycleId).first<{ project: string }>();
  const repo = issueRef.repository ?? repository ?? cycle?.project;
  if (!repo) {
    throw new CollabStoreError(
      'INVALID_ISSUE_REPOSITORY',
      'Le dépôt est requis pour indexer une issue sans collision inter-dépôts.',
    );
  }
  await db.prepare([
    'INSERT INTO cycle_issue_refs_v2 (repository, issue_number, cycle_id) VALUES (?1, ?2, ?3)',
    'ON CONFLICT(repository, issue_number) DO UPDATE SET cycle_id = excluded.cycle_id',
  ].join(' ')).bind(repo, issueRef.issue_number, cycleId).run();
}
