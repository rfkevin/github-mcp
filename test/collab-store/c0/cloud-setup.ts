import { env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

/**
 * Cloud rerun only (vitest.c0-cloud.config.mts). The scratch D1 databases persist between
 * runs, unlike the local ones, so each test file starts from empty prototype tables: leftover
 * quota counters or memory rows would otherwise change the quota and p95 scenarios.
 * Order respects the events -> cycles foreign key.
 */
const TABLES = ['events', 'tasks', 'memory_entries', 'quota_counters', 'cycles'] as const;
const bindings = env as unknown as { COLLAB_DB: D1Database; COLLAB_DB_RESTORE: D1Database };

beforeAll(async () => {
  for (const db of [bindings.COLLAB_DB, bindings.COLLAB_DB_RESTORE]) {
    await db.batch(TABLES.map((table) => db.prepare(`DROP TABLE IF EXISTS ${table}`)));
  }
});
