import { assertWritablePath } from '../security/policy';
import { SENSITIVE_FILE } from '../github/files';

/**
 * Planificateur pur de l'amorçage de collaboration (lot L3). Il ne lit ni n'écrit rien : il compare un
 * manifeste épinglé aux fichiers existants et produit des opérations `create` que `github_apply_changes`
 * applique (aucun second moteur de commit). Règles : on crée seulement ce qui manque, un fichier existant
 * fait toujours foi, un contenu incompatible demande une décision et n'écrit rien.
 */

export const BOOTSTRAP_SCHEMA = 1;
export const RECORD_PATH = 'docs/collaboration/bootstrap-manifest.json';

export type TemplateSource =
  | { kind: 'embedded'; sha256: string }
  | { kind: 'repository'; repository: string; commit: string; path: string; sha256: string };

export type ManifestEntry = {
  target: string;
  ownership: 'project' | 'coordination';
  source: TemplateSource;
  /** Expressions (indicateur m) que tout fichier existant doit contenir pour rester compatible. */
  requiredPatterns?: string[];
};

export type BootstrapManifest = { schema: typeof BOOTSTRAP_SCHEMA; templateVersion: string; entries: ManifestEntry[] };
export type ExistingFile = { sha: string; content: string };
export type EntryAction = 'create' | 'unchanged' | 'kept' | 'action_required';
export type PlanEntry = {
  target: string; action: EntryAction; reason: string; ownership: string; templateSha256: string;
  existingSha?: string; missingPatterns?: string[];
};
export type BootstrapOperation = { type: 'create'; path: string; content: string };
export type BootstrapPlan = {
  status: 'ready' | 'unchanged' | 'action_required';
  templateVersion: string;
  entries: PlanEntry[];
  operations: BootstrapOperation[];
};

export class BootstrapError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function fail(code: string, message: string): never {
  throw new BootstrapError(code, message);
}

export function validateManifest(value: unknown): BootstrapManifest {
  if (typeof value !== 'object' || value === null) fail('MANIFEST_INVALID', 'Manifeste d’amorçage invalide.');
  const manifest = value as Record<string, unknown>;
  if (manifest.schema !== BOOTSTRAP_SCHEMA) fail('MANIFEST_SCHEMA', 'Version de schéma du manifeste non prise en charge.');
  if (typeof manifest.templateVersion !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(manifest.templateVersion)) {
    fail('MANIFEST_INVALID', 'templateVersion invalide.');
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0 || manifest.entries.length > 20) {
    fail('MANIFEST_INVALID', 'Le manifeste doit contenir de 1 à 20 entrées.');
  }
  const seen = new Set<string>();
  const entries = manifest.entries.map((raw: unknown): ManifestEntry => {
    if (typeof raw !== 'object' || raw === null) fail('MANIFEST_INVALID', 'Entrée de manifeste invalide.');
    const entry = raw as Record<string, unknown>;
    const target = entry.target;
    if (typeof target !== 'string') fail('MANIFEST_INVALID', 'Chemin cible manquant.');
    try { assertWritablePath(target); } catch { fail('PATH_DENIED', `Chemin cible refusé : ${target}`); }
    if (SENSITIVE_FILE.test(target)) fail('PATH_DENIED', `Chemin cible sensible refusé : ${target}`);
    if (target === RECORD_PATH) fail('RECORD_PATH_RESERVED', 'Le chemin du registre d’installation est réservé.');
    const key = target.toLowerCase();
    if (seen.has(key)) fail('MANIFEST_INVALID', `Chemin cible en double : ${target}`);
    seen.add(key);
    if (entry.ownership !== 'project' && entry.ownership !== 'coordination') fail('MANIFEST_INVALID', 'ownership invalide.');
    const source = entry.source as Record<string, unknown> | undefined;
    if (!source || typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)) {
      fail('MANIFEST_INVALID', `Empreinte de modèle invalide pour ${target}.`);
    }
    if (source.kind === 'repository') {
      if (typeof source.repository !== 'string' || !REPOSITORY.test(source.repository) ||
        typeof source.commit !== 'string' || !COMMIT.test(source.commit) || typeof source.path !== 'string') {
        fail('MANIFEST_INVALID', `Source de dépôt invalide pour ${target} : dépôt, commit complet et chemin exigés.`);
      }
      try { assertWritablePath(source.path); } catch { fail('PATH_DENIED', `Chemin source refusé : ${String(source.path)}`); }
    } else if (source.kind !== 'embedded') {
      fail('MANIFEST_INVALID', `Type de source inconnu pour ${target}.`);
    }
    const patterns = entry.requiredPatterns;
    if (patterns !== undefined) {
      if (!Array.isArray(patterns) || patterns.length > 5 ||
        patterns.some(pattern => typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 200)) {
        fail('MANIFEST_INVALID', `requiredPatterns invalide pour ${target}.`);
      }
      for (const pattern of patterns as string[]) {
        try { new RegExp(pattern, 'm'); } catch { fail('MANIFEST_INVALID', `Expression invalide pour ${target}.`); }
      }
    }
    return raw as ManifestEntry;
  });
  return { schema: BOOTSTRAP_SCHEMA, templateVersion: manifest.templateVersion, entries };
}

/** Registre d'installation : déterministe, dérivé du seul manifeste. */
export function renderRecord(manifest: BootstrapManifest): string {
  return JSON.stringify({
    schema: manifest.schema,
    templateVersion: manifest.templateVersion,
    installed: manifest.entries.map(entry => ({
      path: entry.target,
      ownership: entry.ownership,
      templateSha256: entry.source.sha256,
      source: entry.source.kind === 'repository'
        ? { repository: entry.source.repository, commit: entry.source.commit, path: entry.source.path }
        : 'embedded',
    })),
  }, null, 2) + '\n';
}

export async function planBootstrap(input: {
  manifest: unknown;
  templates: ReadonlyMap<string, string>;
  existing: ReadonlyMap<string, ExistingFile | undefined>;
}): Promise<BootstrapPlan> {
  const manifest = validateManifest(input.manifest);
  const entries: PlanEntry[] = [];
  const operations: BootstrapOperation[] = [];
  for (const entry of manifest.entries) {
    const template = input.templates.get(entry.target);
    if (template === undefined) fail('TEMPLATE_MISSING', `Modèle introuvable pour ${entry.target}.`);
    if (await sha256Hex(template) !== entry.source.sha256) {
      fail('TEMPLATE_SHA_MISMATCH', `Le modèle de ${entry.target} ne correspond pas à l’empreinte épinglée.`);
    }
    const base = { target: entry.target, ownership: entry.ownership, templateSha256: entry.source.sha256 };
    const existing = input.existing.get(entry.target);
    if (existing === undefined) {
      entries.push({ ...base, action: 'create', reason: 'absent : sera créé depuis le modèle épinglé' });
      operations.push({ type: 'create', path: entry.target, content: template });
    } else if (existing.content === template) {
      entries.push({ ...base, action: 'unchanged', reason: 'identique au modèle épinglé', existingSha: existing.sha });
    } else {
      const missing = (entry.requiredPatterns ?? []).filter(pattern => !new RegExp(pattern, 'm').test(existing.content));
      entries.push(missing.length > 0
        ? { ...base, action: 'action_required', existingSha: existing.sha, missingPatterns: missing,
          reason: 'fichier existant incompatible : une modification demande une autorisation explicite du propriétaire' }
        : { ...base, action: 'kept', existingSha: existing.sha,
          reason: 'fichier existant conservé : il fait foi et n’est jamais écrasé' });
    }
  }

  const record = renderRecord(manifest);
  const recordBase = { target: RECORD_PATH, ownership: 'bootstrap', templateSha256: await sha256Hex(record) };
  const existingRecord = input.existing.get(RECORD_PATH);
  if (existingRecord !== undefined) {
    entries.push(existingRecord.content === record
      ? { ...recordBase, action: 'unchanged', reason: 'registre d’installation identique', existingSha: existingRecord.sha }
      : { ...recordBase, action: 'action_required', existingSha: existingRecord.sha,
        reason: 'registre d’installation différent : une mise à jour des modèles demande une autorisation explicite' });
  } else if (operations.length > 0) {
    entries.push({ ...recordBase, action: 'create', reason: 'enregistre la version des modèles et les chemins installés' });
    operations.push({ type: 'create', path: RECORD_PATH, content: record });
  }

  if (entries.some(entry => entry.action === 'action_required')) {
    return { status: 'action_required', templateVersion: manifest.templateVersion, entries, operations: [] };
  }
  return { status: operations.length > 0 ? 'ready' : 'unchanged', templateVersion: manifest.templateVersion, entries, operations };
}
