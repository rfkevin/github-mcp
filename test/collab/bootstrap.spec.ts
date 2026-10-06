import { describe, expect, it } from 'vitest';
import { BootstrapError, RECORD_PATH, planBootstrap, renderRecord, sha256Hex, validateManifest, type BootstrapManifest, type ExistingFile } from '../../src/collab/bootstrap';
import { BOOTSTRAP_MANIFEST, EMBEDDED_TEMPLATES } from '../../src/collab/bootstrap-manifest';

const templates = new Map(Object.entries(EMBEDDED_TEMPLATES));
const file = (content: string, sha = 'a'.repeat(40)): ExistingFile => ({ sha, content });
const plan = (existing: Record<string, ExistingFile> = {}, manifest: unknown = BOOTSTRAP_MANIFEST, tpl = templates) =>
  planBootstrap({ manifest, templates: tpl, existing: new Map(Object.entries(existing)) });
const codeOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as BootstrapError).code; }
  return undefined;
};
const entry = (target: string, extra: object = {}) => ({
  target, ownership: 'project', source: { kind: 'embedded', sha256: 'a'.repeat(64) }, ...extra,
});
const manifestOf = (entries: unknown[]) => ({ schema: 1, templateVersion: 'v1', entries });

describe('amorçage additif : planificateur', () => {
  it('les empreintes du manifeste correspondent aux modèles embarqués', async () => {
    for (const item of BOOTSTRAP_MANIFEST.entries) {
      expect(await sha256Hex(EMBEDDED_TEMPLATES[item.target]!)).toBe(item.source.sha256);
    }
  });

  it('dépôt vide : crée les modèles et le registre, dans cet ordre', async () => {
    const result = await plan();
    expect(result.status).toBe('ready');
    expect(result.operations.map(op => op.path)).toEqual(['AGENTS.md', 'AGENT_MEMORY.md', RECORD_PATH]);
    expect(result.entries.every(item => item.action === 'create')).toBe(true);
    expect(result.operations[2]!.content).toBe(renderRecord(BOOTSTRAP_MANIFEST));
  });

  it('dépôt partiel : ne crée que ce qui manque et conserve l’existant', async () => {
    const result = await plan({ 'AGENTS.md': file('# Règles du projet\nspécifiques\n') });
    expect(result.status).toBe('ready');
    expect(result.entries.find(item => item.target === 'AGENTS.md')!.action).toBe('kept');
    expect(result.operations.map(op => op.path)).toEqual(['AGENT_MEMORY.md', RECORD_PATH]);
  });

  it('fichier personnalisé compatible : conservé, jamais écrasé', async () => {
    const result = await plan({ 'AGENT_MEMORY.md': file('# Mémoire\n\nhistorique\n') });
    expect(result.entries.find(item => item.target === 'AGENT_MEMORY.md')!.action).toBe('kept');
    expect(result.operations.some(op => op.path === 'AGENT_MEMORY.md')).toBe(false);
  });

  it('fichier incompatible : action_required et aucune opération', async () => {
    const result = await plan({ 'AGENT_MEMORY.md': file('rien qui ressemble à un titre') });
    expect(result.status).toBe('action_required');
    expect(result.operations).toEqual([]);
    expect(result.entries.find(item => item.target === 'AGENT_MEMORY.md')).toMatchObject({
      action: 'action_required', missingPatterns: ['^#\\s+\\S'],
    });
  });

  it('dépôt déjà amorcé : unchanged, idempotent', async () => {
    const done = {
      'AGENTS.md': file(EMBEDDED_TEMPLATES['AGENTS.md']!),
      'AGENT_MEMORY.md': file(EMBEDDED_TEMPLATES['AGENT_MEMORY.md']!),
      [RECORD_PATH]: file(renderRecord(BOOTSTRAP_MANIFEST)),
    };
    const first = await plan(done);
    expect(first.status).toBe('unchanged');
    expect(first.operations).toEqual([]);
    expect(await plan(done)).toEqual(first);
  });

  it('application interrompue (modèles sans registre) : recrée seulement le registre', async () => {
    const result = await plan({
      'AGENTS.md': file(EMBEDDED_TEMPLATES['AGENTS.md']!),
      'AGENT_MEMORY.md': file(EMBEDDED_TEMPLATES['AGENT_MEMORY.md']!),
    });
    expect(result.status).toBe('unchanged');
    expect(result.operations).toEqual([]);
  });

  it('registre différent : action_required, rien n’est écrit', async () => {
    const result = await plan({ [RECORD_PATH]: file('{"schema":1,"templateVersion":"ancien"}\n') });
    expect(result.status).toBe('action_required');
    expect(result.operations).toEqual([]);
  });

  it('modèle altéré : TEMPLATE_SHA_MISMATCH', async () => {
    const altered = new Map(templates).set('AGENTS.md', 'autre contenu');
    expect(await codeOf(plan({}, BOOTSTRAP_MANIFEST, altered))).toBe('TEMPLATE_SHA_MISMATCH');
  });

  it('modèle absent : TEMPLATE_MISSING', async () => {
    expect(await codeOf(plan({}, BOOTSTRAP_MANIFEST, new Map()))).toBe('TEMPLATE_MISSING');
  });

  it('refuse manifestes et chemins dangereux', () => {
    expect(() => validateManifest(null)).toThrow(BootstrapError);
    expect(() => validateManifest({ ...manifestOf([entry('a.md')]), schema: 2 })).toThrow(/schéma/);
    expect(() => validateManifest(manifestOf([]))).toThrow(BootstrapError);
    for (const bad of ['.env', '../x.md', '/abs.md', '.git/config']) {
      expect(() => validateManifest(manifestOf([entry(bad)])), bad).toThrow(BootstrapError);
    }
    expect(() => validateManifest(manifestOf([entry(RECORD_PATH)]))).toThrow(/réservé/);
    expect(() => validateManifest(manifestOf([entry('A.md'), entry('a.md')]))).toThrow(/double/);
    expect(() => validateManifest(manifestOf([entry('a.md', { ownership: 'autre' })]))).toThrow(BootstrapError);
    expect(() => validateManifest(manifestOf([entry('a.md', { requiredPatterns: ['('] })]))).toThrow(BootstrapError);
    expect(() => validateManifest(manifestOf([{ ...entry('a.md'), source: { kind: 'embedded', sha256: 'zz' } }]))).toThrow(BootstrapError);
  });

  it('une source de dépôt exige un commit complet', () => {
    const repo = (commit: string) => ({ ...entry('a.md'), source: { kind: 'repository', repository: 'o/r', commit, path: 'T.md', sha256: 'b'.repeat(64) } });
    expect(() => validateManifest(manifestOf([repo('main')]))).toThrow(/commit complet/);
    expect(() => validateManifest(manifestOf([repo('c'.repeat(40))]))).not.toThrow();
  });

  it('le registre est déterministe', () => {
    const manifest: BootstrapManifest = validateManifest(BOOTSTRAP_MANIFEST);
    expect(renderRecord(manifest)).toBe(renderRecord(manifest));
    expect(JSON.parse(renderRecord(manifest)).installed).toHaveLength(2);
  });
});
