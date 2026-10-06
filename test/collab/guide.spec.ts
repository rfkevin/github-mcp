/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { READ_TOOLS, WRITE_TOOLS } from '../oauth/helpers';
import { WORKFLOW_INSTRUCTIONS } from '../../src/mcp/workflow-guidance';

// Le guide L6 ne doit jamais citer un chemin, un lien ou un outil qui n'existe pas (carte périmée = guide trompeur).
const docs = import.meta.glob(['../../docs/**/*.md'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const doc = (name: string): string => {
  const text = docs[`../../docs/${name}`];
  if (text === undefined) throw new Error(`document introuvable : ${name}`);
  return text;
};
const GUIDE_DOCS = ['collaboration/usage.md', 'collaboration/troubleshooting.md', 'collaboration/profile-decision.md'];
const TOOLS = new Set<string>([...READ_TOOLS, ...WRITE_TOOLS, 'github_apply_changes']);

function resolve(from: string, target: string): string {
  const parts = [...from.split('/').slice(0, -1), ...target.split('/')];
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

// Les clés de glob sont relatives à ce fichier (« ./ » pour le même dossier) : on les ramène à la racine du dépôt.
const files = new Set<string>([
  ...Object.keys(import.meta.glob(['../../src/**/*.ts', '../../test/**/*.ts', '../../docs/**/*.md'])).map(key => resolve('test/collab/guide.spec.ts', key)),
  'test/collab/guide.spec.ts', // import.meta.glob exclut le fichier appelant
  'AGENTS.md', 'AGENT_MEMORY.md', 'TOOL_IMPROVEMENTS.md',
]);

function exists(path: string): boolean {
  if (!path.includes('*')) return files.has(path);
  const pattern = new RegExp('^' + path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
  return [...files].some(file => pattern.test(file));
}

describe('guide de participation CC-2 (L6)', () => {
  it.each(GUIDE_DOCS)('%s : tous les liens relatifs pointent vers un fichier existant', name => {
    const links = [...doc(name).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map(match => match[1]!).filter(link => !/^[a-z]+:/.test(link));
    for (const link of links) expect(exists(resolve(`docs/${name}`, link)), `${name} -> ${link}`).toBe(true);
  });

  it('usage.md : chaque chemin cité (y compris abrégé) existe', () => {
    let directory = '';
    for (const line of doc('collaboration/usage.md').split('\n').filter(row => row.startsWith('|'))) {
      directory = '';
      for (const token of [...line.matchAll(/`([\w./*-]+\.(?:ts|md))`/g)].map(match => match[1]!)) {
        const path = token.includes('/') ? token : token.endsWith('.md') ? `docs/collaboration/${token}` : `${directory}${token}`;
        directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : directory;
        const candidate = path.startsWith('docs/') || path.startsWith('src/') || path.startsWith('test/') ? path : `docs/collaboration/${path}`;
        expect(exists(candidate), `usage.md -> ${token} (${candidate})`).toBe(true);
      }
    }
  });

  it('chaque outil cité par le guide, le dépannage et la décision est enregistré', () => {
    const texts = GUIDE_DOCS.map(doc);
    const cited = new Set(texts.flatMap(text => [...text.matchAll(/\bgithub_[a-z]+(?:_[a-z]+)*\b/g)].map(match => match[0])));
    expect(cited.has('github_collab_context')).toBe(true);
    for (const tool of cited) expect(TOOLS.has(tool), tool).toBe(true);
  });

  it('les consignes d’initialisation renvoient au guide sans grossir de plus de 600 octets', () => {
    expect(WORKFLOW_INSTRUCTIONS).toContain('github_collab_context');
    expect(WORKFLOW_INSTRUCTIONS).toContain('docs/collaboration/usage.md');
    expect(new TextEncoder().encode(WORKFLOW_INSTRUCTIONS).length).toBeLessThanOrEqual(6585 + 600);
  });

  it('la décision de profil ne revendique aucun gain non mesuré', () => {
    const text = doc('collaboration/profile-decision.md');
    expect(text).toContain('not_tested');
    expect(text).toMatch(/borne haute théorique/);
  });
});
