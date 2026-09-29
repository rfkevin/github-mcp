import { describe, expect, it } from 'vitest';
import {
  assertSelectedRepository,
  assertWritableBranch,
  assertWritablePath,
  buildWorkingBranch,
  PolicyViolationError,
  validateChangeSet,
} from '../src/security/policy';

describe('branch policy', () => {
  it('génère une branche MCP', () => {
    expect(buildWorkingBranch('Claude Desktop', 'Fix login')).toBe(
      'mcp/claude-desktop/fix-login',
    );
  });

  it('autorise une branche MCP valide', () => {
    expect(() =>
      assertWritableBranch('mcp/claude/fix-login'),
    ).not.toThrow();
  });

  it.each([
    'main',
    'master',
    'client',
    'client/claude',
    'client/codex',
    'client/production',
    'mcp/claude',
    'mcp/claude/fix/login',
    'mcp/../main',
    'mcp//fix-login',
    'mcp/Claude/fix-login',
  ])('refuse la branche %s', branch => {
    expect(() => assertWritableBranch(branch)).toThrow(PolicyViolationError);
  });

  it('refuse les écritures en lecture seule', () => {
    expect(() =>
      assertWritableBranch('mcp/claude/fix-login', {
        readOnly: true,
      }),
    ).toThrowError('Ce dépôt est configuré en lecture seule.');
  });
});

describe('repository policy', () => {
  it('autorise un dépôt sélectionné', () => {
    expect(() =>
      assertSelectedRepository('owner/project', ['owner/project']),
    ).not.toThrow();
  });

  it('refuse un dépôt non sélectionné', () => {
    expect(() =>
      assertSelectedRepository('owner/other', ['owner/project']),
    ).toThrowError('Le dépôt ne fait pas partie des dépôts autorisés.');
  });
});

describe('path policy', () => {
  it('autorise un fichier source normal', () => {
    expect(() => assertWritablePath('src/app.ts')).not.toThrow();
  });

  it.each([
    '.github/workflows/build.yml',
    '.git/config',
    '../secret.txt',
    '/absolute/file.ts',
    'src\\file.ts',
    'src/%2e%2e/file.ts',
  ])('refuse le chemin %s', path => {
    expect(() => assertWritablePath(path)).toThrow(PolicyViolationError);
  });
});

describe('change set policy', () => {
  it('accepte une modification texte valide', () => {
    expect(() =>
      validateChangeSet([
        {
          path: 'src/app.ts',
          content: 'export const ok = true;',
          expectedSha: 'a'.repeat(40),
        },
      ]),
    ).not.toThrow();
  });

  it('refuse les fichiers dupliqués', () => {
    expect(() =>
      validateChangeSet([
        { path: 'src/app.ts', content: 'one' },
        { path: 'src/app.ts', content: 'two' },
      ]),
    ).toThrowError('Le fichier src/app.ts est dupliqué.');
  });

  it('refuse le contenu binaire', () => {
    expect(() =>
      validateChangeSet([
        { path: 'src/app.ts', content: 'bad\u0000content' },
      ]),
    ).toThrow(PolicyViolationError);
  });
});