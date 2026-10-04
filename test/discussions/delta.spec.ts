import { describe, expect, it } from 'vitest';
import {
  DeltaError,
  MAX_TRACKED_ITEMS,
  computeDelta,
  encodeCursor,
  fingerprintFromHex,
  type DeltaScope,
  type SnapshotItem,
} from '../../src/discussions/delta';

const scope: DeltaScope = { repository: 'Owner/Repo', kind: 'issue_comment', target: '26', maskingVersion: 'known-secrets-v1' };
const BASE_ID = 5_900_000_000;

/** Révision déterministe dont les 8 premiers caractères changent avec la version du contenu. */
const revisionFor = (version: number, id: number): string =>
  `v${version.toString(36).padStart(3, '0')}${id.toString(36).padStart(6, '0')}ZZZZZZZZ`;

function item(id: number, version = 0, createdAt = new Date(Date.UTC(2026, 9, 1) + (id % 1_000_000) * 1000).toISOString()): SnapshotItem {
  return { id, createdAt, revision: revisionFor(version, id) };
}

const range = (from: number, count: number, version = 0): SnapshotItem[] =>
  Array.from({ length: count }, (_, index) => item(BASE_ID + from + index, version));

const noSecondRead = async (): Promise<readonly SnapshotItem[]> => {
  throw new Error('Aucune seconde énumération attendue.');
};

async function expectDeltaError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'DeltaError', code });
}

describe('delta des discussions', () => {
  it('ne rapporte rien quand rien n’a changé et renvoie le même curseur', async () => {
    const snapshot = range(1, 40);
    const cursor = encodeCursor(scope, snapshot);
    const result = await computeDelta(cursor, scope, snapshot, noSecondRead);
    expect(result).toMatchObject({ added: [], modified: [], deleted: [], unchanged: 40, olderUntracked: 0,
      duplicatesIgnored: 0, reenumerated: false, deferred: 0, hasMore: false });
    expect(result.nextCursor).toBe(cursor);
  });

  it('ne dépend pas de l’ordre de l’énumération', async () => {
    const snapshot = range(1, 25);
    const shuffled = [...snapshot].reverse();
    expect(encodeCursor(scope, shuffled)).toBe(encodeCursor(scope, snapshot));
  });

  it('rapporte un nouvel élément une seule fois', async () => {
    const before = range(1, 10);
    const cursor = encodeCursor(scope, before);
    const after = [...before, item(BASE_ID + 11)];
    const first = await computeDelta(cursor, scope, after, noSecondRead);
    expect(first.added.map(entry => entry.id)).toEqual([BASE_ID + 11]);
    const second = await computeDelta(first.nextCursor, scope, after, noSecondRead);
    expect(second).toMatchObject({ added: [], modified: [], deleted: [] });
  });

  it('rapporte une modification de contenu, pas une modification sans effet', async () => {
    const before = range(1, 10);
    const cursor = encodeCursor(scope, before);
    const edited = before.map(entry => entry.id === BASE_ID + 4 ? item(entry.id, 1) : entry);
    const result = await computeDelta(cursor, scope, edited, noSecondRead);
    expect(result.modified.map(entry => entry.id)).toEqual([BASE_ID + 4]);
    // Même contenu masqué : même empreinte, donc rien à signaler.
    const same = await computeDelta(cursor, scope, before, noSecondRead);
    expect(same.modified).toEqual([]);
  });

  it('un élément modifié puis rétabli à l’identique n’est pas rapporté', async () => {
    const before = range(1, 5);
    const cursor = encodeCursor(scope, before);
    const result = await computeDelta(cursor, scope, range(1, 5, 0), noSecondRead);
    expect(result.modified).toEqual([]);
  });

  it('confirme une suppression par une seconde énumération', async () => {
    const before = range(1, 10);
    const cursor = encodeCursor(scope, before);
    const after = before.filter(entry => entry.id !== BASE_ID + 3);
    let reads = 0;
    const result = await computeDelta(cursor, scope, after, async () => { reads += 1; return after; });
    expect(result.deleted).toEqual([BASE_ID + 3]);
    expect(result.reenumerated).toBe(true);
    expect(reads).toBe(1);
    const next = await computeDelta(result.nextCursor, scope, after, noSecondRead);
    expect(next.deleted).toEqual([]);
  });

  it('ne déclare jamais supprimé un élément que la seconde énumération retrouve', async () => {
    const before = range(1, 10);
    const cursor = encodeCursor(scope, before);
    const missed = before.filter(entry => entry.id !== BASE_ID + 3);
    const result = await computeDelta(cursor, scope, missed, async () => before);
    expect(result.deleted).toEqual([]);
    expect(result.unchanged).toBe(10);
    expect(result.reenumerated).toBe(true);
  });

  it('un élément raté par la seconde énumération seulement reste suivi', async () => {
    const before = range(1, 10);
    const cursor = encodeCursor(scope, before);
    const first = before.filter(entry => entry.id !== BASE_ID + 3);
    const second = before.filter(entry => entry.id !== BASE_ID + 7);
    const result = await computeDelta(cursor, scope, first, async () => second);
    expect(result.deleted).toEqual([]);
    const next = await computeDelta(result.nextCursor, scope, before, noSecondRead);
    expect(next).toMatchObject({ added: [], modified: [], deleted: [], unchanged: 10 });
  });

  it('rapporte ensemble une suppression et une création', async () => {
    const before = range(1, 6);
    const cursor = encodeCursor(scope, before);
    const after = [...before.filter(entry => entry.id !== BASE_ID + 2), item(BASE_ID + 20)];
    const result = await computeDelta(cursor, scope, after, async () => after);
    expect(result.deleted).toEqual([BASE_ID + 2]);
    expect(result.added.map(entry => entry.id)).toEqual([BASE_ID + 20]);
  });

  it('ignore les doublons de pagination et garde le dernier exemplaire', async () => {
    const before = range(1, 4);
    const cursor = encodeCursor(scope, before);
    const duplicated = [...before, item(BASE_ID + 2, 1)];
    const result = await computeDelta(cursor, scope, duplicated, noSecondRead);
    expect(result.duplicatesIgnored).toBe(1);
    expect(result.modified.map(entry => entry.id)).toEqual([BASE_ID + 2]);
  });

  it('conserve les champs supplémentaires des éléments', async () => {
    const before = range(1, 2);
    const cursor = encodeCursor(scope, before);
    const extra = [...before, { ...item(BASE_ID + 9), author: 'owner', maskedBytes: 12 }];
    const result = await computeDelta(cursor, scope, extra, noSecondRead);
    expect(result.added).toEqual([expect.objectContaining({ author: 'owner', maskedBytes: 12 })]);
  });

  it('prend en charge des identifiants au-delà de 32 bits et la limite des entiers sûrs', async () => {
    const huge = [item(Number.MAX_SAFE_INTEGER - 2), item(Number.MAX_SAFE_INTEGER - 1), item(Number.MAX_SAFE_INTEGER)];
    const cursor = encodeCursor(scope, huge);
    const result = await computeDelta(cursor, scope, huge, noSecondRead);
    expect(result.unchanged).toBe(3);
  });

  it('commence par un curseur vide : tout élément est nouveau', async () => {
    const cursor = encodeCursor(scope, []);
    const result = await computeDelta(cursor, scope, range(1, 3), noSecondRead);
    expect(result.added).toHaveLength(3);
  });
});

describe('fenêtre de suivi', () => {
  it('ne suit que les éléments les plus récents et le dit', async () => {
    const snapshot = range(1, MAX_TRACKED_ITEMS + 50);
    const cursor = encodeCursor(scope, snapshot);
    const result = await computeDelta(cursor, scope, snapshot, noSecondRead);
    expect(result.unchanged).toBe(MAX_TRACKED_ITEMS);
    expect(result.olderUntracked).toBe(50);
  });

  it('ne voit ni modification ni suppression en dehors de la fenêtre', async () => {
    const snapshot = range(1, MAX_TRACKED_ITEMS + 50);
    const cursor = encodeCursor(scope, snapshot);
    const changed = snapshot.filter(entry => entry.id !== BASE_ID + 1).map(entry => entry.id === BASE_ID + 2 ? item(entry.id, 1) : entry);
    const result = await computeDelta(cursor, scope, changed, noSecondRead);
    expect(result).toMatchObject({ added: [], modified: [], deleted: [], reenumerated: false });
  });

  it('détecte modification et suppression à l’intérieur de la fenêtre', async () => {
    const snapshot = range(1, MAX_TRACKED_ITEMS + 50);
    const cursor = encodeCursor(scope, snapshot);
    const insideEdited = BASE_ID + MAX_TRACKED_ITEMS + 40;
    const insideDeleted = BASE_ID + MAX_TRACKED_ITEMS + 10;
    const changed = snapshot.filter(entry => entry.id !== insideDeleted).map(entry => entry.id === insideEdited ? item(entry.id, 1) : entry);
    const result = await computeDelta(cursor, scope, changed, async () => changed);
    expect(result.modified.map(entry => entry.id)).toEqual([insideEdited]);
    expect(result.deleted).toEqual([insideDeleted]);
  });

  it('un nouvel élément plus récent que la fenêtre est rapporté, un plus ancien est compté', async () => {
    const snapshot = range(1, MAX_TRACKED_ITEMS + 50);
    const cursor = encodeCursor(scope, snapshot);
    const newest = item(BASE_ID + 9_000);
    const ancient = item(BASE_ID + 9_001, 0, '2020-01-01T00:00:00Z');
    const result = await computeDelta(cursor, scope, [...snapshot, newest, ancient], noSecondRead);
    expect(result.added.map(entry => entry.id)).toEqual([newest.id]);
    expect(result.olderUntracked).toBe(51);
  });

  it('garde un curseur compact pour 300 éléments aux identifiants réalistes', () => {
    const snapshot: SnapshotItem[] = [];
    let id = BASE_ID;
    for (let index = 0; index < MAX_TRACKED_ITEMS; index += 1) {
      id += 1_000_000 + ((index * 7_919) % 90_000_000);
      snapshot.push(item(id));
    }
    expect(encodeCursor(scope, snapshot).length).toBeLessThan(5_000);
  });
});

describe('limite de changements rapportés', () => {
  it('rapporte les nouveaux par tranches sans rien perdre ni répéter', async () => {
    const before = range(1, 10);
    let cursor = encodeCursor(scope, before);
    const current = [...before, ...range(100, 250)];
    const seen: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const result = await computeDelta(cursor, scope, current, noSecondRead, { maxReported: 100 });
      seen.push(...result.added.map(entry => entry.id));
      expect(result.added.length + result.modified.length).toBeLessThanOrEqual(100);
      cursor = result.nextCursor;
      if (!result.hasMore) break;
    }
    expect(seen).toEqual(range(100, 250).map(entry => entry.id));
    const last = await computeDelta(cursor, scope, current, noSecondRead, { maxReported: 100 });
    expect(last).toMatchObject({ added: [], modified: [], hasMore: false });
  });

  it('passe les modifications avant les nouveaux et ne perd aucune modification différée', async () => {
    const before = range(1, 120);
    let cursor = encodeCursor(scope, before);
    const edited = before.map(entry => item(entry.id, 1));
    const current = [...edited, item(BASE_ID + 500)];
    const modified: number[] = [];
    const added: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const result = await computeDelta(cursor, scope, current, noSecondRead, { maxReported: 50 });
      modified.push(...result.modified.map(entry => entry.id));
      added.push(...result.added.map(entry => entry.id));
      cursor = result.nextCursor;
      if (!result.hasMore) break;
    }
    expect(modified).toEqual(before.map(entry => entry.id));
    expect(added).toEqual([BASE_ID + 500]);
  });

  it('refuse une limite inférieure à 1', async () => {
    const cursor = encodeCursor(scope, []);
    await expect(computeDelta(cursor, scope, [], noSecondRead, { maxReported: 0 })).rejects.toThrow(TypeError);
  });
});

describe('validité du curseur', () => {
  const snapshot = range(1, 5);
  const cursor = encodeCursor(scope, snapshot);

  /** Remplace un caractère sans produire un curseur de longueur invalide. */
  const corrupt = (value: string, position: number): string => {
    const replacement = value[position] === 'A' ? 'B' : 'A';
    return value.slice(0, position) + replacement + value.slice(position + 1);
  };

  it.each([0, 5, 20, 40])('refuse un curseur dont un caractère a changé (position %i)', async position => {
    await expectDeltaError(computeDelta(corrupt(cursor, position), scope, snapshot, noSecondRead), 'INVALID_CURSOR');
  });

  it.each(['', '!!!', 'AAAA', 'a'.repeat(20_000)])('refuse un curseur mal formé (%#)', async value => {
    await expectDeltaError(computeDelta(value, scope, snapshot, noSecondRead), 'INVALID_CURSOR');
  });

  it('refuse un curseur tronqué', async () => {
    await expectDeltaError(computeDelta(cursor.slice(0, cursor.length - 6), scope, snapshot, noSecondRead), 'INVALID_CURSOR');
  });

  it('refuse un curseur d’une autre discussion', async () => {
    await expectDeltaError(computeDelta(cursor, { ...scope, target: '27' }, snapshot, noSecondRead), 'FOREIGN_CURSOR');
    await expectDeltaError(computeDelta(cursor, { ...scope, kind: 'pull_request_comment' }, snapshot, noSecondRead), 'FOREIGN_CURSOR');
    await expectDeltaError(computeDelta(cursor, { ...scope, repository: 'owner/other' }, snapshot, noSecondRead), 'FOREIGN_CURSOR');
  });

  it('accepte le dépôt quelle que soit la casse', async () => {
    const result = await computeDelta(cursor, { ...scope, repository: 'OWNER/repo' }, snapshot, noSecondRead);
    expect(result.unchanged).toBe(5);
  });

  it('déclare périmé un curseur issu d’une autre version du masquage', async () => {
    await expectDeltaError(computeDelta(cursor, { ...scope, maskingVersion: 'known-secrets-v2' }, snapshot, noSecondRead), 'CURSOR_STALE');
  });

  it('déclare périmé un curseur d’une autre version du format', async () => {
    const bytes = Uint8Array.from(atob(cursor.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (cursor.length % 4)) % 4)),
      char => char.charCodeAt(0));
    bytes[1] = 2;
    const body = bytes.length - 4;
    let hash = 0x811c9dc5;
    for (let index = 0; index < body; index += 1) {
      hash ^= bytes[index];
      hash = Math.imul(hash, 0x01000193);
    }
    const sum = hash >>> 0;
    bytes.set([(sum >>> 24) & 255, (sum >>> 16) & 255, (sum >>> 8) & 255, sum & 255], body);
    const forged = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await expectDeltaError(computeDelta(forged, scope, snapshot, noSecondRead), 'CURSOR_STALE');
  });

  it('refuse une énumération ou une portée invalide', () => {
    expect(() => encodeCursor(scope, [{ id: 0, createdAt: '2026-10-01T00:00:00Z', revision: 'abcdefgh' }])).toThrow(TypeError);
    expect(() => encodeCursor(scope, [{ id: 1, createdAt: 'pas une date', revision: 'abcdefgh' }])).toThrow(TypeError);
    expect(() => encodeCursor(scope, [{ id: 1, createdAt: '2026-10-01T00:00:00Z', revision: 'court' }])).toThrow(TypeError);
    expect(() => encodeCursor({ ...scope, kind: 'Mauvais Type' }, [])).toThrow(TypeError);
    expect(() => encodeCursor({ ...scope, maskingVersion: '' }, [])).toThrow(TypeError);
  });

  it('expose DeltaError avec un code', async () => {
    try {
      await computeDelta('!!!', scope, snapshot, noSecondRead);
    } catch (error) {
      expect(error).toBeInstanceOf(DeltaError);
    }
  });
});

describe('empreinte', () => {
  it('encode 12 caractères hexadécimaux en 8 caractères base64url', () => {
    expect(fingerprintFromHex('000000000000')).toBe('AAAAAAAA');
    expect(fingerprintFromHex('ffffffffffff')).toBe('________');
    expect(fingerprintFromHex('a'.repeat(64))).toHaveLength(8);
  });

  it('refuse une valeur qui n’est pas un SHA-256 hexadécimal', () => {
    expect(() => fingerprintFromHex('xyz')).toThrow(TypeError);
    expect(() => fingerprintFromHex('ABCDEF012345')).toThrow(TypeError);
  });
});

// --- Oracle aléatoire : le moteur doit coïncider avec un calcul naïf sur des scénarios variés. ---

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('comparaison à un calcul naïf', () => {
  it('coïncide sur 300 scénarios aléatoires', async () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = prng(seed);
      const count = Math.floor(random() * 450);
      const initial: Array<SnapshotItem & { version: number }> = [];
      let id = BASE_ID;
      for (let index = 0; index < count; index += 1) {
        id += 1 + Math.floor(random() * 5_000_000);
        // Les dates ne suivent pas l'ordre des identifiants : aucune hypothèse d'ordre n'est permise.
        const createdAt = new Date(Date.UTC(2026, 0, 1) + Math.floor(random() * 25_000_000) * 1000).toISOString();
        initial.push({ ...item(id, 0, createdAt), version: 0 });
      }
      const cursor = encodeCursor(scope, initial);

      const sorted = [...initial].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
      const tracked = sorted.slice(-MAX_TRACKED_ITEMS);
      const start = tracked.length > 0
        ? { seconds: Date.parse(tracked[0].createdAt) / 1000, id: tracked[0].id } : { seconds: 0, id: 0 };
      const trackedIds = new Set(tracked.map(entry => entry.id));

      const current: Array<SnapshotItem & { version: number }> = [];
      const expectedModified: number[] = [];
      const expectedDeleted: number[] = [];
      let expectedUnchanged = 0;
      let expectedOlder = 0;
      for (const entry of initial) {
        const roll = random();
        const isTracked = trackedIds.has(entry.id);
        if (roll < 0.08) {
          if (isTracked) expectedDeleted.push(entry.id);
          continue;
        }
        if (roll < 0.18) {
          current.push({ ...item(entry.id, 1, entry.createdAt), version: 1 });
          if (isTracked) expectedModified.push(entry.id); else expectedOlder += 1;
        } else {
          current.push(entry);
          if (isTracked) expectedUnchanged += 1; else expectedOlder += 1;
        }
      }
      const expectedAdded: number[] = [];
      const extra = Math.floor(random() * 7);
      for (let index = 0; index < extra; index += 1) {
        id += 1 + Math.floor(random() * 5_000_000);
        const old = random() < 0.3;
        const createdAt = old
          ? new Date(Date.UTC(2025, 0, 1) + Math.floor(random() * 1000) * 1000).toISOString()
          : new Date(Date.UTC(2027, 0, 1) + Math.floor(random() * 1000) * 1000).toISOString();
        const seconds = Date.parse(createdAt) / 1000;
        const afterStart = seconds > start.seconds || (seconds === start.seconds && id >= start.id);
        current.push({ ...item(id, 0, createdAt), version: 0 });
        if (afterStart) expectedAdded.push(id); else expectedOlder += 1;
      }
      // Ordre d'énumération aléatoire, doublons occasionnels.
      current.sort(() => random() - 0.5);
      if (current.length > 0 && random() < 0.3) current.push(current[0]);

      const result = await computeDelta(cursor, scope, current, async () => current);
      const label = `scénario ${seed}`;
      expect(result.added.map(entry => entry.id).sort((a, b) => a - b), label).toEqual(expectedAdded.sort((a, b) => a - b));
      expect(result.modified.map(entry => entry.id).sort((a, b) => a - b), label).toEqual(expectedModified.sort((a, b) => a - b));
      expect(result.deleted, label).toEqual(expectedDeleted.sort((a, b) => a - b));
      expect(result.unchanged, label).toBe(expectedUnchanged);
      expect(result.olderUntracked, label).toBe(expectedOlder);

      // Après ce delta, le même état ne produit plus rien.
      const again = await computeDelta(result.nextCursor, scope, current, async () => current);
      expect(again.added, label).toEqual([]);
      expect(again.modified, label).toEqual([]);
      expect(again.deleted, label).toEqual([]);
    }
  });
});
