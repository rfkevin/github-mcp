/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

// Sens des dépendances : les couches métier ne dépendent pas de la couche MCP.
// Les utilitaires partagés vivent dans src/errors et src/workflow.
const sources = import.meta.glob<string>(['../src/writes/**/*.ts', '../src/merges/**/*.ts', '../src/errors/**/*.ts', '../src/workflow/**/*.ts'],
  { query: '?raw', import: 'default', eager: true });

describe('architecture : sens des imports', () => {
  it('lit bien les sources contrôlées', () => {
    expect(Object.keys(sources)).toEqual(expect.arrayContaining(['../src/writes/batch/plan.ts', '../src/errors/public-failure.ts']));
  });
  it('n’importe jamais src/mcp depuis writes, merges, errors ou workflow', () => {
    const offenders = Object.entries(sources)
      .filter(([, content]) => /from\s+['"](?:\.\.\/)+mcp\//.test(content))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
