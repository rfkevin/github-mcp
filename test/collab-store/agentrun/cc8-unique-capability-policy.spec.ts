import { describe, expect, it } from 'vitest';
import {
  hasUnifiedCapability, resolveUnifiedCapabilities, type AssignedTaskRole, type VerifiedCapabilityClaims,
} from '../../../src/collab-store/agentrun/agent-capabilities';

const GRANT = { valid: true, branch: 'mcp/105856986/cc8-c0', paths: ['src/safe.ts'] } as const;
const BASE: VerifiedCapabilityClaims = {
  participant_registered: true, cycle_member: true, cycle_open: true, halted: false,
  task_role: 'author', task_assignment_verified: true,
  github_read_granted: true, memory_read_scoped: true,
  question_answer_authorized: false,
  memory_propose_scoped: false, memory_rewrite_scoped: false,
  design_contribution_authorized: false, verdict_sha_pair_verified: false,
};

function claims(overrides: Partial<VerifiedCapabilityClaims> = {}): VerifiedCapabilityClaims {
  return { ...BASE, ...overrides };
}

describe('CC8 C0 — résolveur UNIQUE de capacités du participant, indépendant du kind', () => {
  it('propose le même socle read/ask/announce à tous les rôles et canaux autorisés', () => {
    const expected = ['cycle.read', 'memory.read', 'github.read', 'question.ask', 'salon.announce'];
    for (const role of ['author', 'reviewer', 'tester', 'observer'] as AssignedTaskRole[]) {
      const result = resolveUnifiedCapabilities(claims({ task_role: role }));
      for (const capability of expected) expect(result).toContain(capability);
    }
  });

  it('refuse toutes les capacités aux participants non vérifiés ou non membres', () => {
    expect(resolveUnifiedCapabilities(claims({ participant_registered: false }))).toEqual([]);
    expect(resolveUnifiedCapabilities(claims({ cycle_member: false }))).toEqual([]);
  });

  it('HALT et fermeture : lecture conservée, aucun effet même avec un grant valide', () => {
    for (const overrides of [{ halted: true }, { cycle_open: false }]) {
      const result = resolveUnifiedCapabilities(claims({ ...overrides, github_write_grant: GRANT }));
      expect(result).toEqual(['cycle.read', 'memory.read', 'github.read']);
    }
  });

  it('rôle ne suffit jamais pour écrire GitHub : mandat exact requis, jamais en reviewer/tester', () => {
    expect(hasUnifiedCapability(claims(), 'github.write')).toBe(false);
    expect(hasUnifiedCapability(claims({ task_role: 'author', github_write_grant: GRANT }), 'github.write')).toBe(true);
    for (const role of ['reviewer', 'tester', 'observer', 'none'] as AssignedTaskRole[]) {
      expect(hasUnifiedCapability(claims({ task_role: role, github_write_grant: GRANT }), 'github.write')).toBe(false);
    }
    expect(hasUnifiedCapability(claims({ task_assignment_verified: false, github_write_grant: GRANT }), 'github.write')).toBe(false);
    for (const grant of [
      { ...GRANT, valid: false },
      { ...GRANT, branch: 'main' },
      { ...GRANT, paths: [] },
      { ...GRANT, paths: ['../secret'] },
    ]) expect(hasUnifiedCapability(claims({ github_write_grant: grant }), 'github.write')).toBe(false);
  });

  it('D12 : seule la paire reviewer/tester affectée peut viser un verdict SHA vérifié', () => {
    for (const role of ['reviewer', 'tester'] as AssignedTaskRole[]) {
      expect(hasUnifiedCapability(claims({ task_role: role }), 'review.verdict')).toBe(false);
      expect(hasUnifiedCapability(claims({ task_role: role, verdict_sha_pair_verified: true }), 'review.verdict')).toBe(true);
    }
    expect(hasUnifiedCapability(claims({ task_role: 'author', verdict_sha_pair_verified: true }), 'review.verdict')).toBe(false);
    expect(hasUnifiedCapability(claims({ task_role: 'reviewer', task_assignment_verified: false,
      verdict_sha_pair_verified: true }), 'review.verdict')).toBe(false);
  });

  it('réponse, contribution et mémoire : toujours uniquement par grant spécifique du serveur', () => {
    const none = resolveUnifiedCapabilities(claims());
    for (const denied of ['question.answer', 'design.contribute', 'memory.propose', 'memory.rewrite']) {
      expect(none).not.toContain(denied);
    }
    const yes = resolveUnifiedCapabilities(claims({
      question_answer_authorized: true, design_contribution_authorized: true,
      memory_propose_scoped: true, memory_rewrite_scoped: true,
    }));
    for (const allowed of ['question.answer', 'design.contribute', 'memory.propose', 'memory.rewrite']) {
      expect(yes).toContain(allowed);
    }
  });

  it('la lecture de mémoire et GitHub ne traverse jamais un grant absent', () => {
    const result = resolveUnifiedCapabilities(claims({
      memory_read_scoped: false, github_read_granted: false, task_role: 'observer',
    }));
    expect(result).not.toContain('memory.read');
    expect(result).not.toContain('github.read');
    expect(result).not.toContain('github.write');
    expect(result).toContain('cycle.read');
  });
});
