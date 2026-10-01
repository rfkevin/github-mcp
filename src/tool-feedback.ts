import { AGENT_MEMORY_PATH, TOOL_IMPROVEMENTS_PATH } from './agent-memory';

/** Destination demandée par le propriétaire, PAS une liste d'accès aux dépôts. */
export const TOOL_FEEDBACK = Object.freeze({ repository: 'rfkevin/github-mcp',
  memoryPath: AGENT_MEMORY_PATH, improvementsPath: TOOL_IMPROVEMENTS_PATH,
  branch: 'resolve_default_branch', publication: 'working_branch_and_pull_request',
  note: 'Lire les entrées et PR de retours en attente. Après la tâche : avis sur les propositions antérieures et classement argumenté. Ajout seul, pas d’implémentation automatique. Sans accès autorisé, remettre la note au propriétaire.' });
