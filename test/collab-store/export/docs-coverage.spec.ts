import { describe, expect, it } from 'vitest';
import guide from '../../../docs/collaboration/cc3/collab-store-guide.md?raw';
import stateParser from '../../../src/collab/state.ts?raw';

// CC-3 C6 — R3 : la documentation couvre chaque outil, chaque code d'erreur et
// chaque opération de Kevin. Un lot qui ajoute un code l'ajoute au guide
// (docs/collaboration/cc3/collab-store-guide.md, section 7).
const CODE = /(?:Error|fail)\(\s*'([A-Z][A-Z0-9_]{2,})'|code: '([A-Z][A-Z0-9_]{2,})'/g;
// Codes du contrat L1 (src/collab/contracts.ts) atteignables par le parser d'état et les contrats du store.
const L1_REACHABLE = ['INVALID_PHASE', 'INVALID_TASK_STATUS', 'UNSUPPORTED_SCHEMA', 'INVALID_REVISION', 'INVALID_SHA', 'DUPLICATE_ROLE'];

async function storeSources(): Promise<Array<[string, string]>> {
  const modules = import.meta.glob('../../../src/collab-store/**/*.ts', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
  const entries = await Promise.all(Object.entries(modules).map(async ([path, load]) => [path, await load()] as [string, string]));
  // proto/ = prototype C0 gelé, non servi par le Worker.
  return entries.filter(([path]) => !path.includes('/collab-store/proto/'));
}

function codesOf(source: string): string[] {
  return [...source.matchAll(CODE)].map(match => match[1] ?? match[2]);
}

function documented(code: string): boolean {
  return guide.includes('`' + code + '`');
}

describe('CC-3 C6 — couverture de la documentation (R3)', () => {
  it('chaque code d’erreur émis par le store et par le parser d’état est documenté', async () => {
    const missing = new Map<string, string>();
    for (const [path, source] of [...await storeSources(), ['src/collab/state.ts', stateParser] as [string, string]]) {
      for (const code of codesOf(source)) if (!documented(code)) missing.set(code, path);
    }
    for (const code of L1_REACHABLE) if (!documented(code)) missing.set(code, 'src/collab/contracts.ts');
    expect(Object.fromEntries(missing), 'codes à ajouter à docs/collaboration/cc3/collab-store-guide.md §7').toEqual({});
  });

  it('chaque outil de /collab/mcp a sa section', async () => {
    const tools = (await storeSources()).flatMap(([, source]) => [...source.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map(match => match[1]));
    expect(tools).toContain('collab_export');
    for (const tool of tools) expect(guide, tool).toContain('### `' + tool + '`');
  });

  it('chaque opération de Kevin du plan (K1–K8) et les nouvelles opérations C6 sont décrites', () => {
    for (const id of ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8', 'K-import', 'K-fallback', 'K-decide', 'K-rotate']) {
      expect(guide, id).toMatch(new RegExp('^\\| ' + id + ' \\|', 'm'));
    }
  });

  it('le guide décrit le repli explicite et l’absence d’écriture GitHub de substitution (R4)', () => {
    expect(guide).toContain('github_collab_context');
    expect(guide).toContain('COLLAB_FALLBACK_STATE');
    expect(guide).toMatch(/Ne pas écrire à la place du store/);
  });
});
