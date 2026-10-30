import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { pauseRequestId } from '../../../src/collab-store/memory/memory-store';
import { e2eScenario, type E2eClient } from './e2e-harness';

// Réplique canon CR-F02 dans un fichier minimal neuf : même parcours et mêmes
// assertions que memory-pause-resume-e2e (qui passe), isolée de tout autre test.
// Diagnostic du bug M1b : si ce fichier passe, c'est le contexte de
// memory-inventory-e2e.spec.ts qui est en cause ; sinon, c'est la position
// d'exécution des fichiers dans le run vitest.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

type Agent = E2eClient & { pid: string };

async function revision(cycle: string): Promise<number> {
  return (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())?.revision ?? 0;
}

async function append(agent: Agent, cycle: string, op: string, type: string, memory: Record<string, unknown>) {
  return agent.call('collab_append_event', { cycle, expected_rev: await revision(cycle),
    op_id: agent.pid + ':' + cycle + ':' + op + ':1', type, participant_id: agent.pid,
    payload_json: JSON.stringify({ memory }) });
}

const fact = (id: string, scope: string, text: string) =>
  ({ id, scope, kind: 'fact', text, evidence_refs: ['ev:m1bx-' + id], confidence: 'observed' });

const counted = async (key: string): Promise<number> =>
  (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(key).first<{ writes: number }>())?.writes ?? 0;

describe('CC-7 diagnostic — canon CR-F02 répliqué (fichier minimal)', () => {
  it('pause posée dès la 2e activation (repique de diagnostic)', async () => {
    const { agent, uniq } = e2eScenario(db, 'm1bx', 'owner-secret-CRF2-0123456789abcdefghijklm');
    const [alpha, beta] = [await agent('alpha'), await agent('beta')];
    const cycle = uniq('cycle');
    const scope = 'role:' + uniq('pause');
    const ids = [0, 1, 2, 3].map(n => uniq('mem' + n));
    for (const [n, id] of ids.entries()) {
      expect((await append(alpha, cycle, 'p' + n, 'memory.propose', fact(id, scope, 'fait partage numero ' + n))).structuredContent.status).toBe('applied');
    }
    const review = (n: number) => append(beta, cycle, 'r' + n, 'memory.review', { id: ids[n], version: 1 });
    expect((await review(0)).structuredContent.status).toBe('applied');
    expect((await review(1)).structuredContent.status).toBe('applied');
    expect(await counted('mem:pause:' + scope)).toBe(1);
    expect(await counted('mem:occ:' + scope)).toBe(1);
    expect(await counted('mem:base:' + scope)).toBe(1);
    const request = (await db.prepare(
      "SELECT json_extract(payload_json, '$.request_id') AS request_id FROM events WHERE cycle_id = 'memory-alarms' AND type = 'owner.request' AND json_extract(payload_json, '$.scope') = ?1 ORDER BY seq",
    ).bind(scope).first<{ request_id: string }>())!;
    expect(request.request_id).toBe(await pauseRequestId(scope, 1));
  }, 60_000);
});
