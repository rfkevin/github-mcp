import { expect } from 'vitest';
import { createOAuthFixture } from '../../oauth/helpers';

/**
 * Harnais E2E HTTP partagé des specs /collab/mcp (CC-3, CR-A/CR-B) : fixture
 * OAuth réelle, /owner protégé par secret pour Kevin, sessions agents
 * distinctes. Chaque spec instancie son scénario avec un préfixe et un secret
 * propres pour isoler ses cycles, ses scopes et son quota journalier.
 */
export type ToolResult = { isError?: boolean; structuredContent: Record<string, unknown> };

/** Code de l'erreur typée d'un refus d'outil ; undefined si l'appel a réussi. */
export const toolCode = (result: ToolResult): string | undefined =>
  (result.structuredContent.error as { code: string } | undefined)?.code;

export interface E2eClient {
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  pseudonym: string;
}

/**
 * Scénario complet : owner (secret) + clients OAuth. Le pseudonyme d'un client
 * (C5) est renvoyé par le refus PARTICIPANT_MISMATCH d'une sonde, sans rien
 * écrire ; agent() l'enregistre auprès de l'owner et le mappe à un participant
 * déclaré.
 */
export function e2eScenario(db: D1Database, prefix: string, secret: string) {
  const fixture = createOAuthFixture({
    COLLAB_DB: db,
    COLLAB_STORE_ENABLED: 'true',
    OWNER_AUTH_MODE: 'secret',
    OWNER_SECRET: secret,
  });
  const owner = (fields: Record<string, string>) =>
    fixture.send('/owner', {
      method: 'POST',
      headers: { Origin: fixture.ORIGIN },
      body: new URLSearchParams({ ...fields, owner_secret: secret }),
    });
  const probeCycle = `${prefix}-probe`;
  let rpcId = 10;
  let seq = 0;
  const uniq = (label: string) => `${prefix}-${label}-${Date.now().toString(36)}-${++seq}`;
  async function client(): Promise<E2eClient> {
    const session = await fixture.mcpSession(
      'mcp:read collab: offline_access',
      'http://localhost:4321/callback',
      fixture.ORIGIN + '/collab/mcp',
    );
    const call = async (name: string, args: Record<string, unknown>) =>
      fixture.rpcResult(
        await (
          await fixture.send('/collab/mcp', {
            method: 'POST',
            headers: session.headers,
            body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
          })
        ).text(),
      ) as ToolResult;
    const probe = await call('collab_append_event', {
      cycle: probeCycle,
      expected_rev: 0,
      op_id: `p:${probeCycle}:x:1`,
      type: 'owner.request',
      participant_id: 'agent:probe',
      payload_json: '{}',
    });
    const pseudonym = (probe.structuredContent.error as { message: string }).message.match(/unregistered:[0-9a-f]{16}/)![0];
    return { call, pseudonym };
  }
  async function agent(label: string): Promise<E2eClient & { pid: string }> {
    const { call, pseudonym } = await client();
    const pid = uniq(label);
    expect((await owner({ action: 'register', participant_id: pid, display_label: label })).status).toBe(200);
    expect((await owner({ action: 'map', oauth_client_id: pseudonym, participant_id: pid })).status).toBe(200);
    return { call, pid, pseudonym };
  }
  return { owner, client, agent, uniq };
}
