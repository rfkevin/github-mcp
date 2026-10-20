// CC-5 l3d — aides de test communes aux actes du coordinateur mandaté (phases souples, demandes de correction).

/** Preuve owner de test (canal secret), identique à celle des autres specs. */
export const OWNER_PROOF = { kind: 'secret' as const, subject: 'owner-secret' };

/** Fabrique d'identifiants uniques et courts (48 caractères au plus), préfixés. */
export function uniqueIds(prefix: string): (label: string) => string {
  let counter = 0;
  return label => [prefix, label, ++counter, Date.now().toString(36)].join('-').slice(0, 48);
}

/** Code d'erreur d'une promesse rejetée, 'NO_ERROR' si elle aboutit. */
export function codeOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(() => 'NO_ERROR', (error: unknown) => (error as { code?: string } | null)?.code ?? 'UNKNOWN');
}

/**
 * Base D1 qui exécute `mutate` juste avant le LOT D'ÉCRITURE, reconnu à son nombre d'instructions : les lots
 * d'amorçage du schéma passent avant les vérifications et ne doivent pas déclencher la course.
 */
export function racingBatch(db: D1Database, writeBatchSize: number, mutate: (target: D1Database) => Promise<unknown>): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (statements.length === writeBatchSize) await mutate(target);
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export type CollabToolResult = { isError?: boolean; content: Array<{ text: string }> };
export type CollabToolHandler = (args: Record<string, unknown>) => Promise<CollabToolResult>;

/** Gestionnaire réel d'un outil /collab/mcp pour un client OAuth donné (identité issue du jeton). */
export async function collabToolHandler(db: D1Database, name: string, clientId: string): Promise<CollabToolHandler> {
  const { registerCollabStoreTools } = await import('../../src/collab-store/mcp/tools');
  const { createCollabToolContext } = await import('../../src/collab-store/mcp/context');
  const context = createCollabToolContext({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true' }, 'agent:x', ['collab:'], {}, clientId);
  let handler: CollabToolHandler | null = null;
  registerCollabStoreTools({ registerTool(tool: string, _spec: unknown, h: CollabToolHandler) { if (tool === name) handler = h; } } as never, context);
  if (!handler) throw new Error('outil introuvable : ' + name);
  return handler;
}

/**
 * Identité issue du jeton : un client associé à `participant` obtient un résultat applicatif ; un client inconnu est
 * refusé (« non associé »). Renvoie le résultat JSON du client associé.
 */
export async function toolIdentityCheck(db: D1Database, input: {
  tool: string; participant: string; allowed: Record<string, unknown>; denied: Record<string, unknown>;
}): Promise<{ ok: Record<string, unknown>; denied: CollabToolResult }> {
  const { mapClient } = await import('../../src/collab-store/owner/decisions');
  const client = 'tool-client-' + input.participant;
  await mapClient(db, { oauth_client_id: client, participant_id: input.participant,
    proof: { kind: 'secret', subject: 'owner-secret' }, op: 'map-' + client });
  const allowed = await (await collabToolHandler(db, input.tool, client))(input.allowed);
  if (allowed.isError) throw new Error('outil refusé à tort : ' + allowed.content[0]?.text);
  const denied = await (await collabToolHandler(db, input.tool, client + '-inconnu'))(input.denied);
  return { ok: JSON.parse(allowed.content[0].text) as Record<string, unknown>, denied };
}
