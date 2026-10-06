import { describe, expect, it } from 'vitest';
import { buildCollabContext } from '../../src/collab/context';
import { encodeCheckpoint } from '../../src/collab/reading-checkpoint';
import type { CheckpointScope, SourceCoverage } from '../../src/collab/reading-checkpoint';

const lines = [
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
  'The owner approved the implementation phase.',
  '',
  '## Roles',
  '| Actor | Scoped acceptance/assignment | Pending evidence |',
  '| --- | --- | --- |',
  '| Kevin | owner | none |',
  '| Codex | author | L1 PR |',
  '',
  '## Tasks',
  '| id | status | owner | role | owned_paths | dependencies | blocker | version | ref | next_action |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| L2 | in_progress | Vibe GLM | author | src/collab/context.ts, src/collab/reading-checkpoint.ts | L1 | none | 1 | branch:l2 | implement |',
  '',
  '## Evidence',
  '| source | state |',
  '| --- | --- |',
  '| issue-16 | verified |',
];

const state = lines.join('\n') + '\n';
const scope: CheckpointScope = { repository: 'rfkevin/project-mcp-collab', ref: 'main', sha: 'abcdef1234567890abcdef1234567890abcdef12', maskingVersion: 'masked-v1' };

const request = (over: Record<string, unknown> = {}) => ({ scope, ...over });

describe('contexte progressif de collaboration', () => {
  it('première sortie : cycle, tâche, guidance et frontière d arrêt', () => {
    const envelope = buildCollabContext(state, request({ role: 'author' }));
    expect(envelope.cycle.phase).toBe('P5');
    expect(envelope.cycle.revision).toBe(2);
    expect(envelope.cycle.stale).toBe(false);
    expect(envelope.task?.id).toBe('L2');
    expect(envelope.task?.ownedPaths).toEqual(['src/collab/context.ts', 'src/collab/reading-checkpoint.ts']);
    expect(envelope.guidance.actions).toContain('implement_owned_paths');
    expect(envelope.guidance.ownerDecisionRequired).toBe(true);
    expect(envelope.evidence.contractRef).toBe('docs/collaboration/contract.md');
  });

  it('sélectionne la tâche du participant et exige une clarification ciblée en cas d ambiguïté', () => {
    const envelope = buildCollabContext(state, request({ participant: 'Vibe GLM' }));
    expect(envelope.task?.id).toBe('L2');
    expect(() => buildCollabContext(state, request({ taskId: 'L9' }))).toThrow(/No task matches id/);
    const twoTasks = state.replace(
      '| L2 | in_progress | Vibe GLM | author | src/collab/context.ts, src/collab/reading-checkpoint.ts | L1 | none | 1 | branch:l2 | implement |',
      '| L2 | in_progress | Vibe GLM | author | src/collab/context.ts, src/collab/reading-checkpoint.ts | L1 | none | 1 | branch:l2 | implement |\n| L2b | in_progress | Vibe GLM | author | src/other.ts | L1 | none | 1 | branch:l2b | implement |',
    );
    expect(() => buildCollabContext(twoTasks, request({ participant: 'Vibe GLM' }))).toThrow(/Several actionable tasks fit participant/);
  });

  it('signale un snapshot périmé face à une décision owner plus récente', () => {
    const envelope = buildCollabContext(state, request({ observed: { revision: 3 } }));
    expect(envelope.cycle.stale).toBe(true);
    expect(envelope.cycle.staleReason).toContain('newer owner revision');
  });

  it('reprend depuis un checkpoint : relit l édité tardif, rescan pour l absent, continuation pour le partiel', () => {
    const peer: SourceCoverage = { location: 'rfkevin/project-mcp-collab#16/5994414388', fingerprint: 'AAAAAAAA', readComplete: true, observedAt: '2026-10-05T12:26:26Z' };
    const partial: SourceCoverage = { location: 'rfkevin/project-mcp-collab#16/5994416774', fingerprint: 'BBBBBBBB', readComplete: false, observedAt: '2026-10-05T12:26:34Z', continuation: { offset: 4000, revision: 'rev2' } };
    const checkpoint = encodeCheckpoint({ v: 1, scope, stateRevision: 2, sources: [peer, partial], createdAt: '2026-10-05T13:00:00Z' });
    const envelope = buildCollabContext(state, request({
      checkpoint,
      observedFingerprints: [
        { id: 5994414388, fingerprint: 'CCCCCCCC' },
        { id: 5994417825, fingerprint: 'BBBBBBBB' },
      ],
    }));
    expect(envelope.coverage.resumed).toBe(true);
    expect(envelope.coverage.toReread).toEqual([5994414388]);
    expect(envelope.coverage.missing).toEqual([5994416774]);
    expect(envelope.coverage.rescanRequired).toBe(true);
    expect(envelope.coverage.partial).toEqual([{ location: 'rfkevin/project-mcp-collab#16/5994416774', continuation: { offset: 4000, revision: 'rev2' } }]);
    expect(envelope.coverage.readComplete).toContain('rfkevin/project-mcp-collab#16/5994414388');
  });

  it('un checkpoint d un autre scope n est jamais fusionné : couverture repartie de zéro', () => {
    const otherScope: CheckpointScope = { ...scope, repository: 'rfkevin/other-repo' };
    const foreignRead: SourceCoverage = { location: 'rfkevin/other-repo#16/1', fingerprint: 'AAAAAAAA', readComplete: true, observedAt: '2026-10-05T12:26:26Z' };
    const checkpoint = encodeCheckpoint({ v: 1, scope: otherScope, stateRevision: 2, sources: [foreignRead], createdAt: '2026-10-05T13:00:00Z' });
    const envelope = buildCollabContext(state, request({ checkpoint }));
    expect(envelope.coverage.scopeMatch).toBe(false);
    expect(envelope.coverage.rescanRequired).toBe(true);
    expect(envelope.coverage.readComplete).not.toContain('rfkevin/other-repo#16/1');
    const decoded = JSON.parse(atob(envelope.nextCheckpoint.replace(/-/g, '+').replace(/_/g, '/')));
    expect(decoded.sources.map((entry: { location: string }) => entry.location)).not.toContain('rfkevin/other-repo#16/1');
    expect(decoded.sources).toHaveLength(1);
  });

  it('une reprise sans énumération courante reste conservative : rescan exigé, sources suivies non prouvées inchangées', () => {
    const peer: SourceCoverage = { location: 'rfkevin/project-mcp-collab#16/5994414388', fingerprint: 'AAAAAAAA', readComplete: true, observedAt: '2026-10-05T12:26:26Z' };
    const checkpoint = encodeCheckpoint({ v: 1, scope, stateRevision: 2, sources: [peer], createdAt: '2026-10-05T13:00:00Z' });
    const envelope = buildCollabContext(state, request({ checkpoint }));
    expect(envelope.coverage.rescanRequired).toBe(true);
    expect(envelope.coverage.toReread).toEqual([]);
    expect(envelope.coverage.missing).toEqual([5994414388]);
  });

  it('G5-F7 : une source d\'état modifiée depuis le checkpoint est signalée dans refreshed, sinon refreshed reste vide', () => {
    const first = buildCollabContext(state, request());
    expect(first.coverage.refreshed).toEqual([]);
    const same = buildCollabContext(state, request({ checkpoint: first.nextCheckpoint }));
    expect(same.coverage.resumed).toBe(true);
    expect(same.coverage.refreshed).toEqual([]);
    const edited = buildCollabContext(state + '\n<!-- edit after checkpoint -->\n', request({ checkpoint: first.nextCheckpoint }));
    expect(edited.coverage.resumed).toBe(true);
    expect(edited.coverage.refreshed).toEqual([edited.evidence.stateLocation]);
    expect(edited.coverage.readComplete).toContain(edited.evidence.stateLocation);
    expect(edited.coverage.toReread).toEqual([]);
  });

  it('exclusion P1 contractuelle et contamination consignée', () => {
    const p1State = state.replace('phase: P5', 'phase: P1');
    const peer: SourceCoverage = { location: 'rfkevin/project-mcp-collab#13/5984463500', fingerprint: 'AAAAAAAA', readComplete: true, observedAt: '2026-10-05T10:00:00Z', peerProposal: true };
    const checkpoint = encodeCheckpoint({ v: 1, scope, stateRevision: 2, sources: [peer], createdAt: '2026-10-05T13:00:00Z' });
    const contaminated = buildCollabContext(p1State, request({ checkpoint }));
    expect(contaminated.peerProposalExclusion.active).toBe(true);
    expect(contaminated.peerProposalExclusion.contamination).toContain('rfkevin/project-mcp-collab#13/5984463500');
    const clean = buildCollabContext(state, request({}));
    expect(clean.peerProposalExclusion.active).toBe(false);
    expect(clean.peerProposalExclusion.contamination).toEqual([]);
  });

  it('émet un checkpoint suivant décodable couvrant l état lu intégralement', () => {
    const envelope = buildCollabContext(state, request({ timestamp: '2026-10-05T14:00:00Z' }));
    const decoded = JSON.parse(atob(envelope.nextCheckpoint.replace(/-/g, '+').replace(/_/g, '/')));
    const stateEntry = decoded.sources.find((entry: { location: string }) => entry.location.startsWith('workflow-state@'));
    expect(stateEntry.readComplete).toBe(true);
    expect(stateEntry.fingerprint.length).toBeGreaterThanOrEqual(8);
    expect(decoded.stateRevision).toBe(2);
    expect(envelope.coverage.unread).not.toContain(stateEntry.location);
  });

  it('F2 sélection : in_progress gagne sur review pour le même owner ; tester matche sans être owner', () => {
    const multi = [
      '# CC-2 state',
      'schema_version: CC-STATE-1',
      'workflow_id: cc2',
      'revision: 3',
      'next_action: run G5-F8',
      'base_revision: 2',
      'canonical_ref: main',
      'based_on_sha: abcdef1234567890abcdef1234567890abcdef12',
      'phase: P6',
      'framing_version: 1',
      'framing_ref: issue-16',
      'plan_version: 1',
      'plan_ref: issue-16',
      'execution_ref: issue-16',
      'contract_ref: docs/collaboration/contract.md',
      'acceptance_ref: docs/collaboration/acceptance.md',
      '',
      '## Owner decisions',
      'Owner assigned G5-F8.',
      '',
      '## Roles',
      '| Actor | Scoped acceptance/assignment | Pending evidence |',
      '| --- | --- | --- |',
      '| Kevin | owner | none |',
      '| Vibe GLM | G5-F8 operator | evidence |',
      '| Claude | G5-F8 verifier | verdict |',
      '',
      '## Tasks',
      '| id | status | owner | role | reviewer | tester | owned_paths | dependencies | blocker | version | ref | next_action |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| G5-F1 | review | Claude | author | GPT-5.6 Sol | Vibe GLM | WORKFLOW_STATE.md | G5 | none | 1 | branch:state | residual review |',
      '| G5-F8 | in_progress | Vibe GLM | tester | GPT-5.6 Sol | Claude | none | G5-F3 | none | 1 | portalshall | bootstrap runtime |',
      '| OLD | done | Vibe GLM | author | none | none | none | none | none | 1 | old | none |',
      '',
      '## Evidence',
      '| source | state |',
      '| --- | --- |',
      '| issue-16 | verified |',
    ].join('\n') + '\n';

    const vibe = buildCollabContext(multi, request({ participant: 'Vibe GLM' }));
    expect(vibe.task?.id).toBe('G5-F8');

    const claude = buildCollabContext(multi, request({ participant: 'Claude' }));
    expect(claude.task?.id).toBe('G5-F8');

    const none = buildCollabContext(multi, request({ participant: 'Muse Spark' }));
    expect(none.task).toBeNull();
  });

  it('F2 sélection : deux in_progress pour le même participant => AMBIGUOUS_TASK', () => {
    const ambiguous = state.replace(
      '| L2 | in_progress | Vibe GLM | author | src/collab/context.ts, src/collab/reading-checkpoint.ts | L1 | none | 1 | branch:l2 | implement |',
      '| A | in_progress | Vibe GLM | author | src/a.ts | none | none | 1 | a | work |\n| B | in_progress | Vibe GLM | author | src/b.ts | none | none | 1 | b | work |',
    );
    expect(() => buildCollabContext(ambiguous, request({ participant: 'Vibe GLM' }))).toThrow(/AMBIGUOUS_TASK|Several actionable/);
  });
});
