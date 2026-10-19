/** CC-5 L4: one-shot D1 claim and fast-forward-only integration update. */
import { evaluateMergeGate, type MergeCandidate } from './merge-gate';
import type { ControllerSnapshot } from '../controller/rules';
import { claimMergeIntent, expireMergeIntent, reconcileMergeIntent, MERGE_INTENT_TTL_SECONDS, type MergeIntent } from './merge-intent';
import type { FencedMergeExecutor } from './github-adapter';
export const CC5_AUTO_MERGE_ENABLED = false;
export interface MergeGitHubPort {
  createTemporaryBranch(base: string): Promise<string>;
  mergeIntoTemporary(branch: string, head: string): Promise<string>;
  readHeads(): Promise<{ head: string; base: string }>;
  /** PATCH refs/heads/integration, force:false. GitHub 422 -> BASE_CHANGED. */
  fastForwardBase(sha: string): Promise<void>;
  deleteTemporaryBranch(branch: string): Promise<void>;
}
export interface MergeExecutionConfig {
  db: D1Database; github: MergeGitHubPort; intent: MergeIntent;
  inspect(): Promise<{ snapshot: ControllerSnapshot; candidate: MergeCandidate }>;
  /** Requires explicit Owner approval before passing true. */
  enabled?: boolean;
}
export function createGitHubMergeExecutor(config: MergeExecutionConfig): FencedMergeExecutor {
  return { async mergeUnderFence(expected, verify) {
    if (!CC5_AUTO_MERGE_ENABLED && config.enabled !== true) throw new Error('L4_MERGE_DISABLED');
    const initial = await config.inspect();
    if (!verify(initial.snapshot,initial.candidate) ||
        !evaluateMergeGate(initial.snapshot,initial.candidate).allowed ||
        expected.head !== config.intent.head || expected.base !== config.intent.base)
      throw new Error('L4_GATE_DENIED');
    if (!await claimMergeIntent(config.db,config.intent)) throw new Error('L4_CLAIM_DENIED');
    let temp: string | null = null;
    try {
      const heads = await config.github.readHeads();
      if (heads.head !== expected.head || heads.base !== expected.base) throw new Error('BASE_OR_HEAD_CHANGED');
      temp = await config.github.createTemporaryBranch(expected.base);
      const mergeSha = await config.github.mergeIntoTemporary(temp,expected.head);
      if (!/^[a-f0-9]{40}$/.test(mergeSha)) throw new Error('L4_INVALID_MERGE_SHA');
      const last = await config.inspect();
      const current = await config.github.readHeads();
      if (!verify(last.snapshot,last.candidate) ||
          !evaluateMergeGate(last.snapshot,last.candidate).allowed ||
          current.head !== expected.head || current.base !== expected.base ||
          last.candidate.now >= config.intent.now+MERGE_INTENT_TTL_SECONDS)
        throw new Error('L4_PRE_PATCH_DENIED');
      try {
        await config.github.fastForwardBase(mergeSha);
      } catch (error) {
        if (error instanceof Error && error.message === 'BASE_CHANGED')
          await expireMergeIntent(config.db,config.intent);
        throw error;
      }
      await reconcileMergeIntent(config.db,config.intent,mergeSha,last.candidate.now);
      return { merged: true, mergeSha };
    } catch (error) {
      if (error instanceof Error && ['BASE_OR_HEAD_CHANGED','L4_PRE_PATCH_DENIED','L4_INVALID_MERGE_SHA'].includes(error.message))
        await expireMergeIntent(config.db,config.intent);
      throw error;
    } finally {
      if (temp) await config.github.deleteTemporaryBranch(temp).catch(() => undefined);
    }
  } };
}
