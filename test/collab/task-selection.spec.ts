import { describe, expect, it } from 'vitest';
import { buildCollabContext } from '../../src/collab/context';
import { parseWorkflowState } from '../../src/collab/state';
import { selectTask } from '../../src/collab/task-selection';
import type { CheckpointScope } from '../../src/collab/reading-checkpoint';
import { CC2_STATE_REV3 } from './fixtures/cc2-state-rev3';
import { CC2_STATE_REV4 } from './fixtures/cc2-state-rev4';

const scope: CheckpointScope = { repository: 'rfkevin/project-mcp-collab', ref: 'main', sha: '245ac6700000000000000000000000000000000a', maskingVersion: 'server-raw-v1' };
const route = (state: string, participant: string) => buildCollabContext(state, { scope, participant });
const replaceLine = (state: string, startsWith: string, line: string) =>
  state.split('\n').map(current => (current.startsWith(startsWith) ? line : current)).join('\n');

describe('routage « <agent>, go » sur l état réel CC-2 révision 3', () => {
  it('Vibe GLM => G5-F8 ; sa cellule tester périmée de G5-F1 (« pass ...; renew ») ne le réveille pas', () => {
    const envelope = route(CC2_STATE_REV3, 'Vibe GLM');
    expect(envelope.task?.id).toBe('G5-F8');
    expect(envelope.task?.participation).toBe('owner');
    expect(envelope.task?.selectedBy).toBe('single_candidate');
  });

  it('Claude => vérification G5-F8 (tester citée par la ligne Roles) malgré G5-F1 dont Claude est owner', () => {
    const envelope = route(CC2_STATE_REV3, 'Claude');
    expect(envelope.task?.id).toBe('G5-F8');
    expect(envelope.task?.participation).toBe('tester');
    expect(envelope.task?.selectedBy).toBe('roles_pending_evidence');
    expect(envelope.task?.nextAction).toContain('Claude: independently verify');
  });

  it('GPT-5.6 Sol => G6 ; sa revue G5-F1 « (pending) » non citée par un pointeur n est pas candidate', () => {
    const envelope = route(CC2_STATE_REV3, 'GPT-5.6 Sol');
    expect(envelope.task?.id).toBe('G6');
    expect(envelope.task?.selectedBy).toBe('single_candidate');
  });

  it('les tâches done/verified/blocked ne sont jamais candidates (Grok n a que des lignes historiques)', () => {
    expect(route(CC2_STATE_REV3, 'Grok').task).toBeNull();
  });

  it('aucune mission active => tâche nulle et guidance consultant, sans mutation implicite', () => {
    const envelope = route(CC2_STATE_REV3, 'Muse Spark');
    expect(envelope.task).toBeNull();
    expect(envelope.guidance.role).toBe('consultant');
    expect(envelope.guidance.ownerDecisionRequired).toBe(true);
    expect(envelope.guidance.actions).not.toContain('implement_owned_paths');
  });

  it('un préfixe ne cite pas une autre tâche : « G5 » ne rend pas G5-F8 candidate', () => {
    const prefixOnly = replaceLine(CC2_STATE_REV3, '| Claude |', '| Claude | verifier | G5 follow-up only |');
    const envelope = route(prefixOnly, 'Claude');
    expect(envelope.task?.id).toBe('G5-F1');
    expect(envelope.task?.selectedBy).toBe('single_candidate');
  });
});

describe('routage sur l état réel CC-2 révision 4 (G5-F9)', () => {
  it('Claude => G5-F9 (owner in_progress) cité par Roles, malgré G5-F1 (owner review)', () => {
    const envelope = route(CC2_STATE_REV4, 'Claude');
    expect(envelope.task?.id).toBe('G5-F9');
    expect(envelope.task?.participation).toBe('owner');
    expect(envelope.task?.selectedBy).toBe('roles_pending_evidence');
  });

  it('Vibe GLM => aucune mission : G5-F8 est blocked et sa cellule tester G5-F1 n est citée par aucun pointeur', () => {
    const envelope = route(CC2_STATE_REV4, 'Vibe GLM');
    expect(envelope.task).toBeNull();
  });

  it('Roles non tranchant (cite deux candidates) => repli sur le next_action d en-tête', () => {
    const both = replaceLine(CC2_STATE_REV4, '| Claude |', '| Claude | author | finish G5-F1 and G5-F9 |');
    const envelope = route(both, 'Claude');
    expect(envelope.task?.id).toBe('G5-F9');
    expect(envelope.task?.selectedBy).toBe('state_next_action');
  });

  it('aucun pointeur tranchant => échec fermé AMBIGUOUS_TASK, sans rang de statut', () => {
    const noPointer = replaceLine(
      replaceLine(CC2_STATE_REV4, '| Claude |', '| Claude | author | wait for the next owner instruction |'),
      'next_action:',
      'next_action: Kevin decides the next dispatch.',
    );
    expect(() => route(noPointer, 'Claude')).toThrow('Several actionable tasks fit participant Claude (G5-F1 (owner, review), G5-F9 (owner, in_progress))');
  });

  it('taskId explicite reste prioritaire et expose la participation déclarée', () => {
    const selected = selectTask(parseWorkflowState(CC2_STATE_REV4), { participant: 'Vibe GLM', taskId: 'G5-F1' });
    expect(selected?.record.id).toBe('G5-F1');
    expect(selected?.participation).toBe('tester');
    expect(selected?.selectedBy).toBe('task_id');
  });

  it('les colonnes optionnelles reviewer/tester sont exposées par le contrat L1', () => {
    const record = selectTask(parseWorkflowState(CC2_STATE_REV4), { taskId: 'G5-F9' })?.record;
    expect(record?.reviewer).toBe('GPT-5.6 Sol');
    expect(record?.tester).toBe('pending independent tester');
  });
});
