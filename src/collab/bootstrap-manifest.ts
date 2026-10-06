import type { BootstrapManifest } from './bootstrap';

/**
 * Modèles minimaux de l'amorçage : des pointeurs, jamais une copie de l'historique de coordination.
 * Chaque modèle est épinglé par son SHA-256 dans le manifeste ; un modèle modifié sans mise à jour de
 * l'empreinte est refusé (TEMPLATE_SHA_MISMATCH). Le manifeste accepte aussi une source de dépôt
 * épinglée sur un commit (kind 'repository') : l'empreinte y joue le même rôle.
 */
export const EMBEDDED_TEMPLATES: Readonly<Record<string, string>> = {
  'AGENTS.md': `# AGENTS.md

Collaboration entry point (pointer only; project rules stay in this file).

- Workflow, state and phases: see the coordination repository rfkevin/project-mcp-collab (WORKFLOW.md and WORKFLOW_STATE.md at its main). Do not copy them here.
- Project memory: AGENT_MEMORY.md (append-only).
- Before work: read this file, the memory, then your assigned task. Agent labels are coordination labels, not authentication.
- Write only inside your task's owned paths, on a task branch; never on the default branch.
`,
  'AGENT_MEMORY.md': `# Project memory (append-only)

Append new entries at the end. Never edit, reorder or delete earlier entries; correct a mistake with a new entry that cites the old one.

Entry format: a heading of the form ### YYYY-MM-DD-agent-topic, then declared author, verified facts, limits, advice and next step. Do not store secrets.
`,
};

export const BOOTSTRAP_MANIFEST: BootstrapManifest = {
  schema: 1,
  templateVersion: 'collab-bootstrap-1',
  entries: [
    { target: 'AGENTS.md', ownership: 'project', source: { kind: 'embedded', sha256: 'c420140ef1e55577173b92f2853f70ad6935256951545f5ecde1353f535a9f58' } },
    { target: 'AGENT_MEMORY.md', ownership: 'project', source: { kind: 'embedded', sha256: '0f4024a98aa5b94eff2aa968539af4b098c5e816c1a750cc3a8fa5a9e82fbafc' },
      requiredPatterns: ['^#\\s+\\S'] },
  ],
};
