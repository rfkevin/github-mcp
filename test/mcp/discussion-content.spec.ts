import { describe, expect, it } from 'vitest';
import { pageMaskedContent } from '../../src/mcp/tools/github/discussion-content';

describe('pagination ciblée des discussions', () => {
  it('reconstruit sans perte emojis, accents, caractères combinés et sauts de ligne', async () => {
    const source = 'A😀B é e\u0301\nfin';
    let offset = 0;
    let revision: string | undefined;
    let rebuilt = '';
    do {
      const page = await pageMaskedContent(source, offset, 3, revision);
      revision = page.revision;
      rebuilt += page.content;
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    } while (true);
    expect(rebuilt).toBe(source);
  });

  it('masque le contenu complet avant pagination', async () => {
    const source = `avant ghp_CANARY123 après ${'é'.repeat(20)}`;
    const first = await pageMaskedContent(source, 0, 9);
    let rebuilt = first.content;
    let offset = first.nextOffset;
    while (offset !== null) {
      const page = await pageMaskedContent(source, offset, 9, first.revision);
      rebuilt += page.content;
      offset = page.nextOffset;
    }
    expect(rebuilt).not.toContain('CANARY123');
    expect(rebuilt).toContain('[jeton masqué]');
  });

  it('refuse un offset au milieu d’un caractère UTF-8', async () => {
    await expect(pageMaskedContent('A😀B', 2, 3)).rejects.toThrow(/frontière UTF-8/);
  });

  it('détecte une modification entre deux pages', async () => {
    const first = await pageMaskedContent('ancienne version', 0, 4);
    await expect(pageMaskedContent('nouvelle version', first.nextOffset!, 4, first.revision)).rejects.toThrow(/changé/);
  });
});
