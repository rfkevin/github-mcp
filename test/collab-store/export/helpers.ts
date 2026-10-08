import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { importStateSnapshot } from '../../../src/collab-store/owner/state-import';
import type { OwnerProof } from '../../../src/collab-store/owner/proof';

export const PROOF: OwnerProof = { kind: 'secret', subject: 'owner-secret' };

/** Participants named in the CC-3 state file (labels are display only). */
export const CC3_PARTICIPANTS: Array<[string, string]> = [
  ['claude', 'Claude'],
  ['muse', 'Muse Spark'],
  ['vibe', 'Vibe GLM'],
  ['sol', 'GPT-5.6 Sol'],
  ['grok', 'Grok'],
];

export async function registerCc3(db: D1Database, tag: string): Promise<void> {
  for (const [participant_id, display_label] of CC3_PARTICIPANTS) {
    await registerParticipant(db, { participant_id, display_label, proof: PROOF, op: tag + '-' + participant_id });
  }
}

export const TARGET = { repository: 'rfkevin/project-mcp-collab', path: 'docs/coordination/cc3/state.md', ref: 'main' };

export function importState(db: D1Database, cycle_id: string, markdown: string) {
  return importStateSnapshot(db, { cycle_id, markdown, proof: PROOF, target: TARGET,
    now: () => new Date('2026-10-08T08:00:00Z') });
}
