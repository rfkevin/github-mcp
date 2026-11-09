/**
 * CC8 C0 — un seul contrat logique de capacités pour les canaux chat et API.
 *
 * Les champs sont des ATTESTATIONS serveur (identité OAuth, rôle du store,
 * droits C4, mandat GitHub), jamais des paramètres fournis par le modèle.
 * Ce résolveur ne remplace PAS les gardes D1/HALT/CAS/D12 au point d'effet.
 *
 * C0 est une fondation pure : aucun outil n'est exposé automatiquement tant
 * que les hôtes chat et API ne consomment pas explicitement son résultat.
 */
export type UnifiedCapability =
  | 'cycle.read'
  | 'memory.read'
  | 'github.read'
  | 'question.ask'
  | 'question.answer'
  | 'salon.announce'
  | 'task.status'
  | 'task.handover'
  | 'memory.propose'
  | 'memory.rewrite'
  | 'design.contribute'
  | 'review.verdict'
  | 'github.write';

export type AssignedTaskRole = 'author' | 'reviewer' | 'tester' | 'observer' | 'none';

/** Contrat du contrôleur serveur ; aucune décision n'est déduite du task_kind. */
export interface VerifiedCapabilityClaims {
  /** Participant vérifié et actif dans le cycle, pas seulement un label déclaré. */
  participant_registered: boolean;
  cycle_member: boolean;
  cycle_open: boolean;
  halted: boolean;
  /** Rôle sur la tâche courante, calculé depuis les attributions du store. */
  task_role: AssignedTaskRole;
  task_assignment_verified: boolean;
  /** Les ressources externes, la mémoire C4 et les questions ont leurs propres autorisations. */
  github_read_granted: boolean;
  memory_read_scoped: boolean;
  question_answer_authorized: boolean;
  memory_propose_scoped: boolean;
  memory_rewrite_scoped: boolean;
  design_contribution_authorized: boolean;
  /** Le serveur a validé la PR et le couple head/base soumis pour un pair D12. */
  verdict_sha_pair_verified: boolean;
  /** Mandat de modification GitHub lié à CET auteur, CETTE branche et SES chemins. */
  github_write_grant?: {
    valid: boolean;
    branch: string;
    paths: readonly string[];
  };
}

const READ_BASE = ['cycle.read'] as const;
const ROLE_MEMBERS: ReadonlySet<AssignedTaskRole> = new Set(['author', 'reviewer', 'tester']);

function canWriteGitHub(claims: VerifiedCapabilityClaims): boolean {
  const grant = claims.github_write_grant;
  return claims.task_assignment_verified && claims.task_role === 'author'
    && !!grant?.valid && /^mcp\/[^\s]+$/.test(grant.branch)
    && grant.paths.length > 0 && grant.paths.every(path =>
      typeof path === 'string' && path.length > 0 && !path.startsWith('/')
      && !path.split('/').includes('..'));
}

/**
 * Les lectures restent possibles après HALT/fermeture pour diagnostic.
 * Toute écriture exige un cycle ouvert, hors HALT et un participant vérifié.
 * Une capacité est une permission D'AFFICHAGE D'OUTIL, non un permis d'effet.
 */
export function resolveUnifiedCapabilities(claims: Readonly<VerifiedCapabilityClaims>): readonly UnifiedCapability[] {
  if (!claims.participant_registered || !claims.cycle_member) return [];
  const capabilities: UnifiedCapability[] = [...READ_BASE];
  if (claims.memory_read_scoped) capabilities.push('memory.read');
  if (claims.github_read_granted) capabilities.push('github.read');
  if (claims.halted || !claims.cycle_open) return capabilities;

  // Les actions de salon ne dépendent pas du genre de mission.
  capabilities.push('question.ask', 'salon.announce');
  if (claims.question_answer_authorized) capabilities.push('question.answer');

  if (claims.task_assignment_verified && ROLE_MEMBERS.has(claims.task_role)) {
    capabilities.push('task.status', 'task.handover');
    if ((claims.task_role === 'reviewer' || claims.task_role === 'tester')
      && claims.verdict_sha_pair_verified) capabilities.push('review.verdict');
  }
  if (claims.memory_propose_scoped) capabilities.push('memory.propose');
  if (claims.memory_rewrite_scoped) capabilities.push('memory.rewrite');
  if (claims.design_contribution_authorized && claims.task_assignment_verified) {
    capabilities.push('design.contribute');
  }
  if (canWriteGitHub(claims)) capabilities.push('github.write');
  return capabilities;
}

export function hasUnifiedCapability(
  claims: Readonly<VerifiedCapabilityClaims>, capability: UnifiedCapability,
): boolean {
  return resolveUnifiedCapabilities(claims).includes(capability);
}
