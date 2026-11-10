import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { taskPromptWithServerPacket } from '../../../src/collab-store/agentrun/unified-run-packet';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

async function seeded() {
  await ensureSchema(db);
  const cycleId = 'cc8-c2b1-' + crypto.randomUUID();
  const taskId = 'c2b1-task';
  await db.prepare(
    "INSERT INTO cycles (cycle_id, project, phase, revision, status) VALUES (?1, 'rfkevin/github-mcp', 'P6', 1, 'open')",
  ).bind(cycleId).run();
  await db.prepare([
    'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid,',
    'status, owned_paths, target_ref, next_action, revision)',
    "VALUES (?1, ?2, 'c2b1-author', 'c2b1-reviewer', 'c2b1-tester', 'in_progress', '[]', '', 'read source', 1)",
  ].join(' ')).bind(taskId, cycleId).run();
  const row = async (id: string, scope: string, content: string) => db.prepare([
    'INSERT INTO memory_entries (id, version, scope, kind, text, evidence_refs,',
    'confidence, status, author_pid, reviewer_pid, supersedes, uses, last_used_rev, expires_rev)',
    "VALUES (?1, 1, ?2, 'fact', ?3, '[\"ev-c2b1\"]', 'observed', 'active', 'c2b1-author', 'c2b1-reviewer', NULL, 0, NULL, NULL)",
  ].join(' ')).bind(cycleId + id, scope, content).run();
  await row('-own', 'participant:c2b1-author', 'AUTHOR_PRIVATE_C2B1');
  await row('-other', 'participant:someone-else', 'OTHER_PRIVATE_C2B1');
  await row('-common', 'common', 'COMMON_VISIBLE_C2B1');
  return { cycleId, taskId };
}

describe('CC8 C2b1 — packet commun chat/API injecté au prompt des tâches', () => {
  it('injecte rôle et mémoire autorisés du serveur, sans données personnelles tierces', async () => {
    const { cycleId, taskId } = await seeded();
    const prompt = await taskPromptWithServerPacket(db, {
      cycleId, participantId: 'c2b1-author', taskId,
    }, 'Mission attribuée');
    expect(prompt).toContain('Mission attribuée');
    expect(prompt).toContain('DOSSIER CC8 SERVEUR');
    expect(prompt).toContain('"role":"owner"');
    expect(prompt).toContain('AUTHOR_PRIVATE_C2B1');
    expect(prompt).toContain('COMMON_VISIBLE_C2B1');
    expect(prompt).not.toContain('OTHER_PRIVATE_C2B1');
    expect(prompt).toContain('Sources GitHub NON PRÉCHARGÉES');
  });

  it('conserve le même contrat pour un reviewer mais sans mémoire privée auteur', async () => {
    const { cycleId, taskId } = await seeded();
    const prompt = await taskPromptWithServerPacket(db, {
      cycleId, participantId: 'c2b1-reviewer', taskId,
    }, 'Mission de relecture');
    expect(prompt).toContain('"role":"reviewer"');
    expect(prompt).toContain('COMMON_VISIBLE_C2B1');
    expect(prompt).not.toContain('AUTHOR_PRIVATE_C2B1');
  });

  it('refuse la tâche non tenue et ne construit jamais un faux dossier', async () => {
    const { cycleId, taskId } = await seeded();
    await expect(taskPromptWithServerPacket(db, {
      cycleId, participantId: 'c2b1-intruder', taskId,
    }, 'Je suis auteur')).rejects.toThrow();
  });

  it('la réponse sans tâche ne se voit pas attribuer une tâche inventée', async () => {
    const result = await taskPromptWithServerPacket(db, {
      cycleId: 'unused', participantId: 'c2b1-author', taskId: '',
    }, 'Répondre à une question');
    expect(result).toBe('Répondre à une question');
  });
});
