import { describe, expect, it } from 'vitest';
import { buildCollabContext } from '../../src/collab/context';
import { parseWorkflowState } from '../../src/collab/state';
import { selectTask } from '../../src/collab/task-selection';
import type { CheckpointScope } from '../../src/collab/reading-checkpoint';
import { CC2_STATE_REV3 } from './fixtures/cc2-state-rev3';

const scope: CheckpointScope = { repository: 'rfkevin/project-mcp-collab', ref: 'main', sha: '27252e6f22df6b02fee0237780744ad0e086ae65', maskingVersion: 'server-raw-v1' };
const route = (state: string, participant: string) => buildCollabContext(state, { scope, participant });
const replaceLine = (state: string, startsWith: string, line: string) =>
  state.split('\n').map(current => (current.startsWith(startsWith) ? line : current)).join('\n');

describe('routage « <agent>, go » sur l état réel CC-2 révision 3', () => {
  it('Vibe GLM => G5-F8 malgré G5-F1 où Vibe est tester historique (next_action d en-tête)', () => {
    const envelope = route(CC2_STATE_REV3, 'Vibe GLM');
    expect(envelope.task?.id).toBe('G5-F8');
    expect(envelope.task?.participation).toBe('owner');
    expect(envelope.task?.selectedBy).toBe('state_next_action');
  });

  it('Claude => responsabilité de vérificateur G5-F8 malgré G5-F1 dont Claude est owner (ligne Roles)', () => {
    const envelope = route(CC2_STATE_REV3, 'Claude');
    expect(envelope.task?.id).toBe('G5-F8');
    expect(envelope.task?.participation).toBe('tester');
    expect(envelope.task?.selectedBy).toBe('roles_pending_evidence');
    expect(envelope.task?.nextAction).toContain('Claude: independently verify');
  });

  it('les tâches done/verified/blocked ne sont jamais candidates (Grok n a que des lignes historiques)', () => {
    const envelope = route(CC2_STATE_REV3, 'Grok');
    expect(envelope.task).toBeNull();
  });

  it('aucune mission active => tâche nulle et guidance consultant, sans mutation implicite', () => {
    const envelope = route(CC2_STATE_REV3, 'Muse Spark');
    expect(envelope.task).toBeNull();
    expect(envelope.guidance.role).toBe('consultant');
    expect(envelope.guidance.ownerDecisionRequired).toBe(true);
    expect(envelope.guidance.actions).not.toContain('implement_owned_paths');
  });

  it('ambiguïté active sans pointeur canonique => échec fermé AMBIGUOUS_TASK listant les candidates', () => {
    const noPointer = replaceLine(
      CC2_STATE_REV3,
      '| Claude |',
      '| Claude | L3 and L6 author; L7/G5 closure; G5-F8 independent verifier | wait for the next owner instruction |',
    );
    expect(() => route(noPointer, 'Claude')).toThrow('Several actionable tasks fit participant Claude (G5-F1 (owner), G5-F8 (tester))');
  });

  it('un pointeur qui cite plusieurs candidates ne tranche pas : on passe au pointeur suivant, puis échec fermé', () => {
    const both = replaceLine(
      CC2_STATE_REV3,
      '| Claude |',
      '| Claude | verifier | finish G5-F1 and G5-F8 |',
    );
    expect(() => route(both, 'Claude')).toThrow(/no canonical pointer/);
  });

  it('taskId explicite reste prioritaire et expose la participation', () => {
    const selected = selectTask(parseWorkflowState(CC2_STATE_REV3), { participant: 'Claude', taskId: 'G5-F1' });
    expect(selected?.record.id).toBe('G5-F1');
    expect(selected?.participation).toBe('owner');
    expect(selected?.selectedBy).toBe('task_id');
  });

  it('un identifiant préfixe ne correspond pas à un autre (G5 ne cite pas G5-F8)', () => {
    const prefixOnly = replaceLine(
      CC2_STATE_REV3,
      '| Claude |',
      '| Claude | verifier | G5 follow-up only |',
    );
    expect(() => route(prefixOnly, 'Claude')).toThrow(/no canonical pointer/);
  });

  it('GPT-5.6 Sol => G6 (ligne Roles) malgré sa revue G5-F1 notée « (pending) »', () => {
    const envelope = route(CC2_STATE_REV3, 'GPT-5.6 Sol');
    expect(envelope.task?.id).toBe('G6');
    expect(envelope.task?.participation).toBe('owner');
  });
});
