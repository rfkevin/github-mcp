import { describe, expect, it } from 'vitest';
import { buildCollabContext, extractLinkTargets } from '../../src/collab/context';
import type { CheckpointScope } from '../../src/collab/reading-checkpoint';
import { LINK_REFS_STATE } from './fixtures/link-refs-state';

const scope: CheckpointScope = { repository: 'rfkevin/project-mcp-collab', ref: 'main', sha: 'abcdef1234567890abcdef1234567890abcdef12', maskingVersion: 'masked-v1' };

describe('G5-F3 : cibles de liens Markdown comme emplacements de sources', () => {
  it('extractLinkTargets : cible unique, cibles multiples, dédupliquée, sans lien', () => {
    expect(extractLinkTargets('[complete plan](docs/coordination/plan-v1.2.md)')).toEqual(['docs/coordination/plan-v1.2.md']);
    expect(extractLinkTargets('see [a](a.md) and [b](b.md)')).toEqual(['a.md', 'b.md']);
    expect(extractLinkTargets('[dupe](a.md) then [dupe again](a.md)')).toEqual(['a.md']);
    expect(extractLinkTargets('[](empty-text.md)')).toEqual(['empty-text.md']);
    expect(extractLinkTargets('docs/collaboration/contract.md')).toEqual([]);
  });

  it('les refs avec liens deviennent leurs cibles dans sources et unread, sans la syntaxe Markdown', () => {
    const envelope = buildCollabContext(LINK_REFS_STATE, { scope });
    const locations = envelope.sources.map(source => source.location);
    expect(locations).toContain('docs/coordination/plan-v1.2.md');
    expect(locations).toContain('docs/coordination/acceptance-v1.md');
    for (const location of locations) {
      expect(location).not.toMatch(/\]\(/);
    }
    expect(envelope.coverage.unread).toContain('docs/coordination/plan-v1.2.md');
    for (const location of envelope.coverage.unread) {
      expect(location).not.toMatch(/\]\(/);
    }
  });

  it('les refs sans lien restent inchangées et evidence garde la valeur brute', () => {
    const envelope = buildCollabContext(LINK_REFS_STATE, { scope });
    const locations = envelope.sources.map(source => source.location);
    expect(locations).toContain('https://example.test/framing');
    expect(locations).toContain('docs/collaboration/contract.md');
    expect(locations).toContain('docs/collaboration/acceptance.md');
    expect(envelope.evidence.planRef).toBe('[complete plan](docs/coordination/plan-v1.2.md)');
    expect(envelope.evidence.executionRef).toBe('[V01-V16](docs/coordination/acceptance-v1.md) plus prose around it');
  });

  it('owned_paths avec lien contribue sa cible ; la tâche garde les chemins bruts', () => {
    const envelope = buildCollabContext(LINK_REFS_STATE, { scope });
    expect(envelope.task?.id).toBe('G5-F3');
    expect(envelope.task?.ownedPaths).toEqual(['[notebook](docs/coordination/plan-v1.2.md)', 'src/collab/context.ts']);
    const owned = envelope.sources.filter(source => source.kind === 'owned_path').map(source => source.location);
    expect(owned).toEqual(['docs/coordination/plan-v1.2.md', 'src/collab/context.ts']);
  });
});
