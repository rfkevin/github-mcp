import type { SecurityPolicy } from '../../security/policy';
export type GitHubClientOptions = {
    appId: string;
    /** Clé privée PKCS#8 (les `\\n` échappés sont acceptés). */
    privateKey: string;
    installationId: string;
    userAgent?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    apiVersion?: '2022-11-28' | '2026-03-10';
    /** Politique de sécurité appliquée à toutes les écritures. */
    policy?: Partial<SecurityPolicy>;
    /** Liste blanche `owner/repo` (insensible à la casse). Vide = toute l'installation. */
    allowedRepositories?: readonly string[];
    /** Permissions demandées pour le jeton (moindre privilège). Omis = celles de l'installation. */
    tokenPermissions?: Record<string, 'read' | 'write'>;
    /** Autorise la fusion de Pull Requests (désactivé par défaut). */
    allowMerge?: boolean;
    /** Capacité distincte, cible fixe integration uniquement. */
    allowIntegrationMerge?: boolean;
    /** Autorise l'approbation de Pull Requests (désactivé par défaut). */
    allowApproval?: boolean;
    /** Aucune exécution manuelle autorisée par défaut. Les refs sont aussi explicites. */
    allowedWorkflows?: readonly string[];
    allowedWorkflowRefs?: readonly string[];
};
export type FileDeletion = {
    path: string;
    expectedSha?: string;
};
export type ApplyChangeSetOptions = {
    deletions?: readonly FileDeletion[];
    /** Refuser un commit préparé depuis un état de branche devenu obsolète. */
    expectedHeadSha?: string;
};
export type AppliedChangeSet = {
    branch: string;
    commitSha: string;
    changedPaths: string[];
    deletedPaths: string[];
};
