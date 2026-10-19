import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { runAgentPilot } from '../../../src/collab-store/agents';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;
const uniq = (t: string) => 'l3b-pilot-' + t + '-' + (++n);

async function seed(cycleId: string): Promise<void> {
  await ensureSchema(db);
  await insertCycleRow(db, cycleId, 'P6');
  await insertPhaseDefinition(db, cycleId, 'P6', []);
  await insertTaskRow(db, {
    taskId: 'l3b', cycle: cycleId, owner: 'grok', reviewer: 'vibe', tester: 'gpt6',
  });
}

describe('CC-5 L3b — pilote agent API', () => {
  it('assemble un paquet borné pour un collaborateur API', async () => {
    const cycleId = uniq('ok');
    await seed(cycleId);
    const result = await runAgentPilot(db, {
      cycleId, participantId: 'grok', taskId: 'l3b', workerId: 'w-pilot-1',
      budgetTokens: 2500, now: 1_700_000_300,
    });
    expect(result.status).toBe('assembled');
    if (result.status !== 'assembled') return;
    expect(result.packet.channel).toBe('api');
    expect(result.packet.constraints.d12_verdicts).toBe('forbidden');
    expect(result.packet.constraints.max_cost_cents).toBe(0);
    expect(result.packet.persona.participant_id).toBe('grok');
    expect(result.packet.tools).toContain('collab_get_context');
    expect(result.packet_bytes).toBeGreaterThan(0);
  });

  it('refuse un verdict D12 candidat sur le canal API', async () => {
    const cycleId = uniq('d12');
    await seed(cycleId);
    const result = await runAgentPilot(db, {
      cycleId, participantId: 'claude', taskId: 'l3b', workerId: 'w-d12',
      candidatePayload: { state: 'AGREE', head: 'a'.repeat(40), base: 'b'.repeat(40) },
      now: 1_700_000_400,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'd12_verdict_forbidden_on_api_channel' });
  });

  it('refuse un outil interdit (evidence.add)', async () => {
    const cycleId = uniq('tool');
    await seed(cycleId);
    const result = await runAgentPilot(db, {
      cycleId, participantId: 'vibe', workerId: 'w-tool',
      requestedTool: 'evidence.add', now: 1_700_000_500,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'tool_forbidden_on_api_channel' });
  });

  it('refuse un participant non persona API', async () => {
    const cycleId = uniq('nope');
    await seed(cycleId);
    const result = await runAgentPilot(db, {
      cycleId, participantId: 'owner', workerId: 'w-owner', now: 1_700_000_600,
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'persona_not_api_enabled' });
  });
});
