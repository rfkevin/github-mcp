import type { ControllerSnapshot, TaskFacts } from '../../../src/collab-store/controller';

// CC-5 L3 — faits de tâche et instantané minimaux pour les règles pures du contrôleur (partagés entre specs).
export function task(overrides: Partial<TaskFacts> = {}): TaskFacts {
  return { task_id: 't1', status: 'accepted', revision: 1, owner: 'vibe', reviewer: 'grok', tester: 'claude', dependencies: [],
    submission: null, verdicts: [], ...overrides };
}

export function snapshot(tasks: TaskFacts[], overrides: Partial<ControllerSnapshot> = {}): ControllerSnapshot {
  return { cycle_id: 'c', revision: 7, phase: 'P6', halted: false, auto_advance: 'none', outputs_satisfied: false, tasks, ...overrides };
}
