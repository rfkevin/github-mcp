/**
 * CC-3 C2 — collab store configuration (fail-closed by default).
 * COLLAB_STORE_ENABLED mounts the /collab/mcp route; without a bound COLLAB_DB
 * the route answers 503 instead of failing open.
 */
export interface CollabStoreEnv {
  /** D1 binding holding the canonical C1 schema. Required when the store is enabled. */
  COLLAB_DB?: D1Database;
  /** Feature flag: 'true' mounts /collab/mcp. Anything else (or absent) = disabled. */
  COLLAB_STORE_ENABLED?: string;
  /** Optional daily write quota override (default DEFAULT_DAILY_WRITE_LIMIT). */
  COLLAB_DAILY_WRITE_LIMIT?: string;
}

export const DEFAULT_DAILY_WRITE_LIMIT = 5000;

export function collabStoreEnabled(value: string | undefined): boolean {
  return value === 'true';
}

export function collabDailyWriteLimit(value: string | undefined): number {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_DAILY_WRITE_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_DAILY_WRITE_LIMIT;
  return parsed;
}
