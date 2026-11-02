/**
 * CC-8 S5 — canary F2 (CC-PLAN-8 §4, v0.2 seq 1270) : rejeu stratifié du
 * journal (coût 0, prompts bornés), rapport rejouable (coût, quotas, latence
 * tracés), branchement vers la décision pure CC-7 sans la modifier ; la
 * sortie est une tâche de promotion pour S6. Aucun appel fournisseur ici.
 */
export {
  CANARY_JOURNAL_WINDOW,
  CANARY_MIN_PER_KIND,
  CANARY_PROMPT_MAX,
  evidenceStateOf,
  journalEventsForReplay,
  replayKindOf,
  selectReplayTasks,
  type JournalEventRow,
  type ReplayTask,
} from './replay';
export {
  runCanary,
  type CanaryCallOutcome,
  type CanaryCallRecord,
  type CanaryCaller,
  type CanaryReport,
  type RunCanaryOptions,
} from './runner';
export {
  branchCanaryToF2,
  canaryResultOf,
  reportHashOf,
  type BranchF2Input,
  type PromotionOutcome,
  type PromotionTaskProposal,
} from './f2';
