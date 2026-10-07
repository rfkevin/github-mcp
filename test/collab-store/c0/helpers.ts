import { env } from 'cloudflare:test';
import { applyProtoSchema } from '../../../src/collab-store/proto/schema';
import { ProtoStore } from '../../../src/collab-store/proto/store';

const bindings = env as unknown as { COLLAB_DB: D1Database; COLLAB_DB_RESTORE: D1Database };
let counter = 0;

export async function freshStore(dailyWriteLimit = 100_000): Promise<{ db: D1Database; store: ProtoStore }> {
  await applyProtoSchema(bindings.COLLAB_DB);
  return { db: bindings.COLLAB_DB, store: new ProtoStore(bindings.COLLAB_DB, { dailyWriteLimit }) };
}

export async function restoreDb(): Promise<D1Database> {
  await applyProtoSchema(bindings.COLLAB_DB_RESTORE);
  return bindings.COLLAB_DB_RESTORE;
}

export function cycleId(label: string): string {
  counter += 1;
  return `c0-${label}-${counter}-${crypto.randomUUID().slice(0, 8)}`;
}

export function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function metric(name: string, value: unknown): void {
  console.log('C0_METRIC ' + JSON.stringify({ name, value }));
}

/** Deterministic PRNG (mulberry32) so replay scenarios are reproducible. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
