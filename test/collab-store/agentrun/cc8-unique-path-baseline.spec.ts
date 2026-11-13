import { describe, expect, it } from 'vitest';
import { providerMessagesFromHistory, type CompletedHistoryStep } from '../../../src/collab-store/agentrun/engine';
import { READ_TOOLS_BY_KIND } from '../../../src/collab-store/agentrun/read-tools';
import { WRITE_TOOLS_BY_KIND } from '../../../src/collab-store/agentrun/store-tools';
import { GITHUB_WRITE_TOOLS_BY_KIND } from '../../../src/collab-store/agentrun/github-tools';
import { taskKindMaxSteps, taskKindMaxTokens, type PlannedTaskKind } from '../../../src/collab-store/agentrun/plan';
import { PREPARATION_ROUNDS_MAX, preparationViolation } from '../../../src/collab-store/agentrun/guided-preparation';

/**
 * CC8 E0-0: golden baseline AVANT le résolveur du chemin unique.
 *
 * Ces attentes fixent la partition après l'ajout explicite par Kevin des clarifications API dans CC8.
 * La migration doit comparer l'ancien et le nouveau résolveur, puis modifier
 * ces références seulement après validation explicite des nouveaux privilèges.
 */
const READS = {
  answer: ['store_context', 'store_delta'],
  design: ['store_context', 'store_delta'],
  review: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs', 'github_diff'],
  test: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs', 'github_diff'],
  implement: ['store_context', 'store_delta', 'github_list_directory', 'github_read_file', 'github_pull_request', 'github_check_runs'],
  research: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs'],
  planning: ['store_context', 'store_delta', 'github_read_file'],
  status: ['store_context', 'store_delta', 'github_check_runs'],
} as const;

const STORE_WRITES = {
  answer: ['store_answer', 'store_ask'],
  design: ['store_ask', 'store_answer'],
  review: ['store_ask', 'store_answer'],
  test: ['store_ask', 'store_answer'],
  implement: ['store_task_status', 'store_ask', 'store_answer'],
  research: ['store_ask', 'store_answer'],
  planning: ['store_ask', 'store_answer'],
  status: ['store_task_status', 'store_ask', 'store_answer'],
} as const;

const GITHUB_WRITES = {
  answer: [],
  design: [],
  review: [],
  test: [],
  implement: ['github_create_branch', 'github_commit_files', 'github_open_draft_pr', 'github_open_pr'],
  research: [],
  planning: [],
  status: [],
} as const;

const KINDS = Object.keys(READS) as Array<keyof typeof READS>;

describe('CC8 E0-0 — comportement avant unification (golden baseline)', () => {
  it.each(KINDS)('lecture et écriture actuellement offertes au kind %s', kind => {
    expect([...(READ_TOOLS_BY_KIND[kind] ?? [])]).toEqual(READS[kind]);
    expect([...(WRITE_TOOLS_BY_KIND[kind] ?? [])]).toEqual(STORE_WRITES[kind]);
    expect([...(GITHUB_WRITE_TOOLS_BY_KIND[kind] ?? [])]).toEqual(GITHUB_WRITES[kind]);
  });

  it('les verdicts D12 et les contributions de conception ne sont PAS des écritures génériques', () => {
    for (const kind of KINDS) {
      const writes = [...(WRITE_TOOLS_BY_KIND[kind] ?? []), ...(GITHUB_WRITE_TOOLS_BY_KIND[kind] ?? [])];
      expect(writes).not.toContain('store_verdict');
      expect(writes).not.toContain('store_contribute');
      if (kind !== 'implement') expect(writes).not.toContain('github_commit_files');
    }
  });

  it('capture les plafonds applicatifs actuels, distincts des privilèges des outils', () => {
    for (const kind of KINDS as PlannedTaskKind[]) {
      expect([taskKindMaxTokens(kind), taskKindMaxSteps(kind)]).toEqual([-1, -1]);
    }
    expect(taskKindMaxTokens('review', { AGENT_RUN_COST_CENTS_REVIEW: '1' })).toBe(-1);
    expect(taskKindMaxTokens('implement', { AGENT_RUN_FREE_IMPLEMENT_MAX_TOKENS: '120000' })).toBe(-1);
  });

  it('caractérise la préparation guidée responsable des échecs initiaux (sans la normaliser)', () => {
    expect(PREPARATION_ROUNDS_MAX).toBe(3);
    expect(preparationViolation({ text: 'Analyse sans outil', tool_calls: [] }, ['store_context']))
      .toBe('no_tool_call');
  });

  it('préserve le dernier tour complet et retire les anciens contenus sensibles du contexte compact', () => {
    const step = (id: string, result: Record<string, unknown>): CompletedHistoryStep => ({
      model_output: JSON.stringify({ text: 'action-' + id, tool_calls: [
        { id, name: 'store_context', args: {} },
      ] }),
      results: JSON.stringify([{ id, content: JSON.stringify(result) }]),
    });
    const steps = [
      step('old', { data: 'SECRET_ANCIEN', padding: 'x'.repeat(60_000), sha: 'a'.repeat(40), status: 'completed' }),
      step('new', { current: 'VERIFICATION_EN_COURS', sha: 'b'.repeat(40) }),
    ];
    const full = providerMessagesFromHistory('mission', steps, false);
    const compact = providerMessagesFromHistory('mission', steps, true);
    expect(JSON.stringify(full)).toContain('SECRET_ANCIEN');
    expect(JSON.stringify(compact)).not.toContain('SECRET_ANCIEN');
    expect(compact[0].content).toContain('a'.repeat(40));
    expect(compact.at(-1)?.content).toContain('VERIFICATION_EN_COURS');
    expect(compact.at(-1)?.tool_call_id).toBe('new');
    expect(providerMessagesFromHistory('mission', steps, true)).toEqual(compact);
  });
});
