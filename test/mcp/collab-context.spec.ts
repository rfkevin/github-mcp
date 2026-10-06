import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/mcp/context';
import { registerCollabContextTools } from '../../src/mcp/tools/github/collab-context';
import { toolRegistry } from './tool-registry';

const stateLines = [
  '# CC-2 state',
  'schema_version: CC-STATE-1',
  'workflow_id: cc2',
  'revision: 2',
  'next_action: implement',
  'base_revision: 1',
  'canonical_ref: main',
  'based_on_sha: abcdef1234567890abcdef1234567890abcdef12',
  'phase: P5',
  'framing_version: 1',
  'framing_ref: issue-16',
  'plan_version: 1',
  'plan_ref: issue-16',
  'execution_ref: issue-16',
  'contract_ref: docs/collaboration/contract.md',
  'acceptance_ref: docs/collaboration/acceptance.md',
  '',
  '## Owner decisions',
  'Approved.',
  '',
  '## Roles',
  '| Actor | Scoped acceptance/assignment | Pending evidence |',
  '| --- | --- | --- |',
  '| Kevin | owner | none |',
  '',
  '## Tasks',
  '| id | status | owner | version | ref | next_action |',
  '| --- | --- | --- | --- | --- | --- |',
  '| L2 | in_progress | Vibe GLM | 1 | branch:l2 | implement |',
];

const state = stateLines.join('\n') + '\n';
const sha = 'a'.repeat(40);

function fixture(content: string) {
  const getTextFile = vi.fn(async () => ({ content, sha: 'blob', size: content.length }));
  const handlers = toolRegistry(registerCollabContextTools, {
    actor: '105856986',
    reads: { files: { getTextFile } },
  } as unknown as ToolContext);
  return handlers.get('github_collab_context')!;
}

describe('outil github_collab_context', () => {
  it('renvoie l envelope de première sortie sans écrire', async () => {
    const handler = fixture(state);
    const result = await handler({ repository: 'rfkevin/project-mcp-collab', ref: sha });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as Record<string, unknown>;
    const cycle = payload.cycle as { phase: string };
    const task = payload.task as { id: string };
    expect(cycle.phase).toBe('P5');
    expect(task.id).toBe('L2');
    expect(typeof payload.nextCheckpoint).toBe('string');
  });

  it('F2-BUG-01 : une erreur de contrat d état expose son code (AMBIGUOUS_TASK) au lieu d un échec générique', async () => {
    const twoTasks = state.replace(
      '| L2 | in_progress | Vibe GLM | 1 | branch:l2 | implement |',
      '| L2 | in_progress | Vibe GLM | 1 | branch:l2 | implement |\n| L3 | in_progress | Claude | 1 | branch:l3 | implement |',
    );
    const handler = fixture(twoTasks);
    const result = await handler({ repository: 'rfkevin/project-mcp-collab', ref: sha });
    expect(result.isError).toBe(true);
    const failure = (result.structuredContent as { error: { code: string; message: string; retryable: boolean } }).error;
    expect(failure.code).toBe('AMBIGUOUS_TASK');
    expect(failure.message).toContain('taskId');
    expect(failure.retryable).toBe(false);
  });

  it('échoue proprement sur un état illisible', async () => {
    const handler = fixture('not a workflow state');
    const result = await handler({ repository: 'rfkevin/project-mcp-collab', ref: sha });
    expect(result.isError).toBe(true);
  });
});