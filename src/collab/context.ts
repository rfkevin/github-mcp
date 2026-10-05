import { StateContractError } from './contracts';
import type { AgentRole, StateSnapshot, TaskRecord } from './contracts';
import { parseWorkflowState, taskRecords, validateSnapshotCurrency } from './state';
import { derivePhaseGuidance } from './phase';
import type { PhaseGuidance } from './phase';
import { DELETION_TRACKING_LIMITATION, decodeCheckpoint, diffSources, encodeCheckpoint, fingerprintContent, mergeCoverage, scopeMatches } from './reading-checkpoint';
import type { CheckpointScope, SourceCoverage, SourceObservation } from './reading-checkpoint';

/** Phases où les propositions de pairs sont lisibles ; avant cela l'exclusion P1 est contractuelle. */
const PEER_PROPOSAL_PERMITTED = ['P2', 'P3', 'P4', 'P5', 'P6'];
const ACTIONABLE_STATUSES = ['proposed', 'accepted', 'in_progress', 'review'];
const COVERAGE_NOTE = 'Reading coverage is a fact about fetched content, not proof that the model understood it.';

export type ContextRequest = {
  scope: CheckpointScope;
  participant?: string;
  taskId?: string;
  /** Rôle déclaré (advisory) ; sans déclaration, le rôle le moins privilégié est retenu. */
  role?: AgentRole;
  /** Checkpoint portable encodé ; absent = jointure fraîche. */
  checkpoint?: string;
  /** Empreintes de l'énumération courante, quand le client les connaît. */
  observedFingerprints?: SourceObservation[];
  /** Décision owner plus récente que le snapshot, si observée. */
  observed?: { revision?: number; sha?: string };
  /** Horodatage ISO du checkpoint émis ; fourni par l'appelant, pas par ce module pur. */
  timestamp?: string;
};

export type ContextSource = {
  location: string;
  kind: 'state' | 'framing' | 'plan' | 'execution' | 'contract' | 'acceptance' | 'owned_path';
  peerProposal: boolean;
};

export type ContextEnvelope = {
  cycle: { workflowId: string; phase: string; revision: number; baseRevision: number | null; schemaVersion: string; legacy: boolean; stale: boolean; staleReason?: string };
  task: { id: string; status: string; owner: string; role: string | null; ownedPaths: string[]; dependencies: string | null; blocker: string | null; version: string; ref: string; nextAction: string } | null;
  guidance: PhaseGuidance;
  evidence: { stateLocation: string; stateSha: string; framingRef: string | null; planRef: string | null; executionRef: string | null; contractRef: string | null; acceptanceRef: string | null };
  peerProposalExclusion: { active: boolean; reason: string; contamination: string[] };
  sources: ContextSource[];
  coverage: { resumed: boolean; scopeMatch: boolean; readComplete: string[]; toReread: number[]; partial: Array<{ location: string; continuation: { offset: number; revision: string } }>; missing: number[]; rescanRequired: boolean; deletionTrackingLimitation: string; unread: string[] };
  nextCheckpoint: string;
  advisory: string;
};

function selectTask(snapshot: StateSnapshot, request: ContextRequest): TaskRecord | null {
  const records = taskRecords(snapshot);
  if (request.taskId) {
    const found = records.find(record => record.id === request.taskId);
    if (!found) {
      throw new StateContractError('TASK_NOT_FOUND', 'No task matches id ' + request.taskId + ' in the canonical state');
    }
    return found;
  }
  if (request.participant) {
    const mine = records.filter(record => record.owner === request.participant && ACTIONABLE_STATUSES.includes(record.status));
    if (mine.length === 0) return null;
    if (mine.length > 1) {
      throw new StateContractError('AMBIGUOUS_TASK', 'Several actionable tasks fit participant ' + request.participant + ' (' + mine.map(record => record.id).join(', ') + '): specify taskId.');
    }
    return mine[0];
  }
  const actionable = records.filter(record => ACTIONABLE_STATUSES.includes(record.status));
  if (actionable.length === 0) return null;
  if (actionable.length > 1) {
    throw new StateContractError('AMBIGUOUS_TASK', 'Several actionable tasks fit the instruction (' + actionable.map(record => record.id).join(', ') + '): specify taskId or participant.');
  }
  return actionable[0];
}

export function buildCollabContext(stateContent: string, request: ContextRequest): ContextEnvelope {
  const snapshot = parseWorkflowState(stateContent);
  const phase = snapshot.headers.phase;
  const revision = Number(snapshot.headers.revision);

  let stale = false;
  let staleReason: string | undefined;
  if (request.observed) {
    try {
      validateSnapshotCurrency(snapshot, request.observed);
    } catch (error) {
      if (error instanceof StateContractError && (error.code === 'STALE_REVISION' || error.code === 'STALE_SHA')) {
        stale = true;
        staleReason = error.code === 'STALE_REVISION'
          ? 'A newer owner revision exists: reread the canonical state before acting.'
          : 'The observed head differs from based_on_sha: reread the canonical state before acting.';
      } else {
        throw error;
      }
    }
  }

  const task = selectTask(snapshot, request);
  const role = request.role ?? 'consultant';
  const guidance = derivePhaseGuidance(phase, role);

  const exclusionActive = !PEER_PROPOSAL_PERMITTED.includes(phase);
  let scopeMatch = true;
  const previous = request.checkpoint ? decodeCheckpoint(request.checkpoint) : null;
  if (previous) scopeMatch = scopeMatches(previous.scope, request.scope);
  const contamination = previous && exclusionActive
    ? previous.sources.filter(source => source.peerProposal).map(source => source.location)
    : [];

  const diff = previous
    ? diffSources(previous.sources, request.observedFingerprints ?? [], scopeMatch)
    : { changed: [] as number[], missing: [] as number[], rescanRequired: false, unchanged: 0 };

  const stateLocation = 'workflow-state@' + request.scope.repository + '/' + request.scope.ref;
  const ownedPaths = task?.ownedPaths && task.ownedPaths !== 'none'
    ? task.ownedPaths.split(',').map(part => part.trim()).filter(Boolean)
    : [];
  const sources: ContextSource[] = [{ location: stateLocation, kind: 'state', peerProposal: false }];
  const refKinds = [
    ['framing_ref', 'framing'],
    ['plan_ref', 'plan'],
    ['execution_ref', 'execution'],
    ['contract_ref', 'contract'],
    ['acceptance_ref', 'acceptance'],
  ] as const;
  for (const [key, kind] of refKinds) {
    if (snapshot.headers[key]) sources.push({ location: snapshot.headers[key], kind, peerProposal: false });
  }
  for (const path of ownedPaths) sources.push({ location: path, kind: 'owned_path', peerProposal: false });

  const readComplete = previous ? previous.sources.filter(source => source.readComplete).map(source => source.location) : [];
  const partial = previous
    ? previous.sources
      .filter(source => !source.readComplete && source.continuation)
      .map(source => ({ location: source.location, continuation: { offset: source.continuation!.offset, revision: source.continuation!.revision } }))
    : [];
  const unread = sources
    .map(source => source.location)
    .filter(location => !previous || !previous.sources.some(source => source.location === location));

  const stateCoverage: SourceCoverage = {
    location: stateLocation,
    fingerprint: fingerprintContent(stateContent),
    readComplete: true,
    observedAt: snapshot.headers.based_on_sha,
  };
  const nextCheckpoint = encodeCheckpoint({
    v: 1,
    scope: request.scope,
    stateRevision: revision,
    sources: mergeCoverage(previous ? previous.sources : [], [stateCoverage]),
    createdAt: request.timestamp ?? '',
  });

  return {
    cycle: {
      workflowId: snapshot.headers.workflow_id,
      phase,
      revision,
      baseRevision: snapshot.headers.base_revision !== undefined ? Number(snapshot.headers.base_revision) : null,
      schemaVersion: snapshot.schemaVersion,
      legacy: snapshot.legacySchema,
      stale,
      ...(staleReason ? { staleReason } : {}),
    },
    task: task
      ? {
        id: task.id, status: task.status, owner: task.owner, role: task.role ?? null,
        ownedPaths, dependencies: task.dependencies ?? null, blocker: task.blocker ?? null,
        version: task.version, ref: task.ref, nextAction: task.nextAction,
      }
      : null,
    guidance,
    evidence: {
      stateLocation, stateSha: snapshot.headers.based_on_sha,
      framingRef: snapshot.headers.framing_ref ?? null,
      planRef: snapshot.headers.plan_ref ?? null,
      executionRef: snapshot.headers.execution_ref ?? null,
      contractRef: snapshot.headers.contract_ref ?? null,
      acceptanceRef: snapshot.headers.acceptance_ref ?? null,
    },
    peerProposalExclusion: {
      active: exclusionActive,
      reason: exclusionActive
        ? 'Peer proposal bodies are excluded until the permitted phase; contamination is recorded if already read.'
        : 'Peer proposals are readable in this phase.',
      contamination,
    },
    sources,
    coverage: {
      resumed: previous !== null, scopeMatch, readComplete, toReread: diff.changed, partial,
      missing: diff.missing, rescanRequired: diff.rescanRequired,
      deletionTrackingLimitation: DELETION_TRACKING_LIMITATION, unread,
    },
    nextCheckpoint,
    advisory: COVERAGE_NOTE + (previous && !scopeMatch
      ? ' The provided checkpoint targets a different scope: coverage was rebuilt from a fresh index.'
      : ''),
  };
}
