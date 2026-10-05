import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_VERSION,
  DELETION_TRACKING_LIMITATION,
  decodeCheckpoint,
  diffSources,
  encodeCheckpoint,
  fingerprintContent,
  mergeCoverage,
  scopeMatches,
} from '../../src/collab/reading-checkpoint';
import type { CheckpointScope, ReadingCheckpoint, SourceCoverage } from '../../src/collab/reading-checkpoint';

const scope: CheckpointScope = { repository: 'rfkevin/project-mcp-collab', ref: 'main', sha: 'dd16faf0e7143a7728923d812ad3378a44e28258', maskingVersion: 'masked-v1' };

const source = (over: Partial<SourceCoverage> = {}): SourceCoverage => ({
  location: 'rfkevin/project-mcp-collab#16/5994414388',
  fingerprint: 'AAAAAAAA',
  readComplete: true,
  observedAt: '2026-10-05T12:26:26Z',
  ...over,
});

const checkpoint = (sources: SourceCoverage[] = [source()]): ReadingCheckpoint => ({
  v: CHECKPOINT_VERSION, scope, stateRevision: 2, sources, createdAt: '2026-10-05T13:00:00Z',
});

describe('checkpoint portable de lecture', () => {
  it('fait un aller-retour encode/decode sans perte', () => {
    const encoded = encodeCheckpoint(checkpoint());
    expect(decodeCheckpoint(encoded)).toEqual(checkpoint());
  });

  it('rejette les payloads corrompus et les versions inconnues', () => {
    expect(() => decodeCheckpoint('not-a-checkpoint')).toThrow(/portable encoded payload|not valid JSON/);
    expect(() => encodeCheckpoint({ ...checkpoint(), v: 99 as never })).toThrow(/Unsupported checkpoint version/);
  });

  it('borne le nombre de sources suivies', () => {
    const many = Array.from({ length: 201 }, (_, index) => source({ location: 'rfkevin/project-mcp-collab#16/' + (5900000000 + index) }));
    expect(() => encodeCheckpoint(checkpoint(many))).toThrow(/at most 200/);
  });

  it('détecte une édition tardive par changement d empreinte, même sur un identifiant ancien', () => {
    const previous = [source({ location: 'rfkevin/project-mcp-collab#16/1', fingerprint: 'AAAAAAAA' })];
    const diff = diffSources(previous, [{ id: 1, fingerprint: 'BBBBBBBB' }], true);
    expect(diff.changed).toEqual([1]);
    expect(diff.rescanRequired).toBe(false);
  });

  it('exige un rescan explicite pour une source suivie absente de l énumération', () => {
    const previous = [source({ location: 'rfkevin/project-mcp-collab#16/1', fingerprint: 'AAAAAAAA' })];
    const diff = diffSources(previous, [{ id: 2, fingerprint: 'AAAAAAAA' }], true);
    expect(diff.missing).toEqual([1]);
    expect(diff.rescanRequired).toBe(true);
  });

  it('un scope différent (dépôt, ref ou masquage) force un rescan sans détail', () => {
    const diff = diffSources([source()], [{ id: 5994414388, fingerprint: 'AAAAAAAA' }], false);
    expect(diff).toEqual({ changed: [], missing: [], rescanRequired: true, unchanged: 0 });
    expect(scopeMatches(scope, { ...scope, maskingVersion: 'masked-v2' })).toBe(false);
    expect(scopeMatches(scope, { ...scope, sha: 'ffffffffffffffffffffffffffffffffffffffff' })).toBe(true);
  });

  it('fusionne la couverture par location sans réécrire les sources non relues', () => {
    const previous = [source({ readComplete: false, continuation: { offset: 4000, revision: 'rev1' } })];
    const fresh = [source({ location: 'rfkevin/project-mcp-collab#16/2', fingerprint: 'CCCCCCCC' })];
    const merged = mergeCoverage(previous, fresh);
    expect(merged).toHaveLength(2);
    expect(merged.find(entry => entry.location.endsWith('/2'))?.fingerprint).toBe('CCCCCCCC');
    expect(merged.find(entry => entry.continuation)?.continuation?.offset).toBe(4000);
  });

  it('expose la limite de suivi des suppressions et des empreintes stables', () => {
    expect(DELETION_TRACKING_LIMITATION).toContain('rescan');
    expect(fingerprintContent('same')).toBe(fingerprintContent('same'));
    expect(fingerprintContent('same')).not.toBe(fingerprintContent('different'));
  });
});
