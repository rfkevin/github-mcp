/**
 * CC-5 l7 (incrément 7c-1) — compteur des lignes D1 réellement écrites.
 *
 * L'orchestrateur 7b réservait une estimation pessimiste fixe (12 lignes par
 * étape). 7c-1 mesure : chaque requête et chaque lot passés par ce wrapper
 * additionnent `meta.rows_written` rapporté par D1 (index compris). Le wrapper
 * ne change rien au comportement : mêmes requêtes, mêmes lots, mêmes erreurs ;
 * un lot reçoit les instructions d'origine (D1 refuse des objets étrangers).
 */

function rowsOf(result: unknown): number {
  const meta = (result as { meta?: { rows_written?: unknown } } | null | undefined)?.meta;
  const rows = meta?.rows_written;
  return typeof rows === 'number' && Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0;
}

class MeteredStatement {
  constructor(readonly inner: D1PreparedStatement, private readonly add: (rows: number) => void) {}

  bind(...values: unknown[]): MeteredStatement {
    return new MeteredStatement(this.inner.bind(...values), this.add);
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.inner.run<T>();
    this.add(rowsOf(result));
    return result;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.inner.all<T>();
    this.add(rowsOf(result));
    return result;
  }

  first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    // first() ne rapporte pas de meta : les requêtes du moteur qui écrivent passent par run() ou batch().
    return column === undefined ? this.inner.first<T>() : this.inner.first<T>(column);
  }

  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    return this.inner.raw<T>(options as { columnNames: false }) as Promise<T[]>;
  }
}

export interface MeteredDb {
  db: D1Database;
  rowsWritten(): number;
}

/** Enveloppe une base D1 ; `rowsWritten()` rend le total mesuré depuis la création. */
export function meteredDb(db: D1Database): MeteredDb {
  let total = 0;
  const add = (rows: number) => { total += rows; };
  const wrapped = {
    prepare(sql: string) {
      return new MeteredStatement(db.prepare(sql), add);
    },
    async batch<T = unknown>(statements: Array<D1PreparedStatement | MeteredStatement>): Promise<D1Result<T>[]> {
      const inner = statements.map(statement => statement instanceof MeteredStatement ? statement.inner : statement);
      const results = await db.batch<T>(inner as D1PreparedStatement[]);
      for (const result of results) add(rowsOf(result));
      return results;
    },
    exec(sql: string) {
      return db.exec(sql);
    },
    dump() {
      return (db as unknown as { dump(): Promise<ArrayBuffer> }).dump();
    },
    withSession(...args: unknown[]) {
      return (db as unknown as { withSession(...a: unknown[]): unknown }).withSession(...args);
    },
  };
  return { db: wrapped as unknown as D1Database, rowsWritten: () => total };
}
