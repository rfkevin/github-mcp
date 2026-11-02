import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import wranglerRaw from '../../../wrangler.jsonc?raw';
import { planAgentRuns } from '../../../src/collab-store/agentrun';
import { coordinatorRunOverview, runCapacity } from '../../../src/collab-store/agentrun/capacity';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import {
  latestRunStatusActSeq, loadAgentRunStatus, RUN_STATUSES, setAgentRunStatus, type RunStatus,
} from '../../../src/collab-store/owner/agent-run-status';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { decideOwnerRequest, executablePayloadSha256, parseOwnerRequest } from '../../../src/collab-store/owner/executable';
import type { OwnerProof } from '../../../src/collab-store/owner/proof';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { OWNER_PROOF } from '../coordinator-helpers';

// CC-8 S8a (CC-PLAN-8, consultation S8a — GO de Kevin) — pause serveur RÉVERSIBLE d'un agent.
// Constat : la pause mémoire (C4) ne couvre pas les réveils du planificateur ; un agent que
// Kevin met de côté reçoit pourtant des exécutions au passage suivant.
// AC : pause → aucun réveil confié (AGENT_PAUSED avant toute politique, route ou sonde),
// aucune exécution créée ; resumed → resservi ; CAS de version ; jamais déléguable ;
// approbation /owner e2e idempotente ; verdict AGENT_PAUSED visible du coordinateur.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const wrangler = JSON.parse(wranglerRaw) as { env: Record<string, { vars: Record<string, string> }> };
const CC3_VARS = wrangler.env['cc3-test'].vars;
const AGENTS = ['claude', 'grok', 'vibe', 'gemini'];
const CC3_TEST = { ...CC3_VARS, AI: {}, LLM_KEY_GEMINI: 'k', AGENT_RUN_GITHUB_WRITES: 'true', AGENT_RUN_PARTICIPANTS: AGENTS.join(',') };
const NOW = new Date('2032-11-02T10:00:00Z');
let n = 0;

/** Isolation (base partagée) : statuts retirés, cycles précédents clos, cycle P6 neuf (révision 1). */
async function clean(label: string): Promise<string> {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  await loadAgentRunStatus(db, 'bootstrap-s8a'); // crée agent_run_status si besoin
  await db.prepare('DELETE FROM agent_run_status').run();
  await db.prepare("UPDATE cycles SET status = 'closed' WHERE status = 'open'").run();
  const cycle = ('0000-cc8-s8a-p-' + label + '-' + (++n)).slice(0, 48);
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  return cycle;
}

const pause = (participant_id: string, expected_version: number, status: RunStatus = 'paused', reason?: string) =>
  setAgentRunStatus(db, { participant_id, status, expected_version, ...(reason ? { reason } : {}), proof: OWNER_PROOF, op: 's8a-' + (++n) });

async function runsOf(cycle: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT participant_id FROM agent_runs WHERE cycle_id = ?1 ORDER BY participant_id')
    .bind(cycle).all<{ participant_id: string }>();
  return (results ?? []).map(row => row.participant_id);
}

describe('CC-8 S8a — pause serveur : runCapacity refuse AVANT toute politique, route ou sonde', () => {
  it('pause → AGENT_PAUSED (même pour une sonde) ; resumed → capable de nouveau ; les autres ne sont pas touchés', async () => {
    await clean('capacite');
    expect((await runCapacity(db, CC3_TEST, 'gemini', null, 'implement', NOW)).capable).toBe(true);
    const paused = await pause('gemini', 0, 'paused', 'pause serveur testée');
    expect(paused).toMatchObject({ status: 'applied', participant_id: 'gemini', run_status: 'paused', version: 1 });
    for (const kind of ['implement', 'review', 'probe']) {
      const refused = await runCapacity(db, CC3_TEST, 'gemini', null, kind, NOW);
      expect(refused, kind).toEqual({ capable: false, reason: 'AGENT_PAUSED : gemini est en pause serveur (acte owner set_agent_run_status) ; aucun réveil ne lui est confié' });
    }
    expect((await runCapacity(db, CC3_TEST, 'vibe', null, 'implement', NOW)).capable).toBe(true);
    const resumed = await pause('gemini', 1, 'resumed');
    expect(resumed).toMatchObject({ run_status: 'resumed', version: 2 });
    expect((await runCapacity(db, CC3_TEST, 'gemini', null, 'implement', NOW)).capable).toBe(true);
  });

  it('fail-closed : sans ligne (aucun acte posé) le participant reste actif — jamais de pause implicite', async () => {
    await clean('implicite');
    expect(await loadAgentRunStatus(db, 'claude')).toBeNull();
    // Claude sans ligne : refus budgétaire habituel, PAS AGENT_PAUSED.
    expect((await runCapacity(db, CC3_TEST, 'claude', null, 'implement', NOW)).reason).toMatch(/^MODEL_BUDGET_EXHAUSTED/);
  });
});

describe('CC-8 S8a — acte owner : CAS de version, jamais déléguable, rejeu idempotent', () => {
  it('CAS : expected_version périmé → RUN_STATUS_VERSION_STALE, rien n’est écrit', async () => {
    await clean('cas');
    await pause('gemini', 0);
    await expect(pause('gemini', 0, 'resumed')).rejects.toMatchObject({ code: 'RUN_STATUS_VERSION_STALE' });
    expect((await loadAgentRunStatus(db, 'gemini'))?.status).toBe('paused');
  });

  it('refus typés : status inconnu, version invalide, participant réservé, preuve déléguée', async () => {
    await clean('refus');
    await expect(pause('gemini', 0, 'flying' as unknown as RunStatus)).rejects.toMatchObject({ code: 'RUN_STATUS_INVALID' });
    await expect(pause('gemini', -1)).rejects.toMatchObject({ code: 'RUN_STATUS_VERSION_INVALID' });
    await expect(pause('owner', 0)).rejects.toMatchObject({ code: 'INVALID_PARTICIPANT_ID' });
    const delegated = { kind: 'delegated', subject: 'gpt6' } as unknown as OwnerProof;
    await expect(setAgentRunStatus(db, { participant_id: 'gemini', status: 'paused', expected_version: 0, proof: delegated, op: 's8a-' + (++n) }))
      .rejects.toMatchObject({ code: 'DELEGATED_FORBIDDEN' });
    expect(await loadAgentRunStatus(db, 'gemini')).toBeNull();
  });

  it('statuts exacts et rejeu : RUN_STATUSES = paused/resumed ; le même op_id rejoué = duplicate, une seule version', async () => {
    expect(RUN_STATUSES).toEqual(['paused', 'resumed']);
    await clean('rejeu');
    const op = 's8a-replay-' + (++n);
    const first = await setAgentRunStatus(db, { participant_id: 'grok', status: 'paused', expected_version: 0, proof: OWNER_PROOF, op });
    const replay = await setAgentRunStatus(db, { participant_id: 'grok', status: 'paused', expected_version: 1, proof: OWNER_PROOF, op });
    expect(replay.status).toBe('duplicate');
    expect(replay.event.seq).toBe(first.event.seq);
    expect(await loadAgentRunStatus(db, 'grok')).toMatchObject({ version: 1, status: 'paused' });
  });
});

describe('CC-8 S8a — demande exécutable set_agent_run_status (préparation et approbation)', () => {
  it('payload valide : classe exécutable, cible le participant, cycle owner-registry ; structures invalides refusées', async () => {
    await clean('parse');
    const params = { participant_id: 'gemini', status: 'paused', expected_version: 0 };
    const payload = JSON.stringify({
      request_id: 's8a-parse-' + (++n), summary: 'Pause serveur de Gemini (S8a)',
      action: 'set_agent_run_status', params, payload_sha256: await executablePayloadSha256('set_agent_run_status', params),
      preconditions: { previous_seq: await latestRunStatusActSeq(db, 'gemini') },
      reason: 'pause réversible', risk: 'aucun réveil pour gemini', rollback: 'acte set_agent_run_status resumed',
    });
    const parsed = await parseOwnerRequest(payload);
    expect(parsed.kind).toBe('executable');
    if (parsed.kind !== 'executable') return;
    expect(parsed.request.target).toBe('gemini');
    expect(parsed.request.cycle_id).toBe('owner-registry');
    for (const bad of [
      { participant_id: 'gemini', status: 'flying', expected_version: 0 },
      { participant_id: 'gemini', status: 'paused' },
      { participant_id: 'gemini', status: 'paused', expected_version: 0, extra: 'champ' },
    ]) {
      const invalid = JSON.stringify({
        request_id: 's8a-bad-' + (++n), summary: 'invalide', action: 'set_agent_run_status', params: bad,
        payload_sha256: await executablePayloadSha256('set_agent_run_status', bad),
        preconditions: { previous_seq: null }, reason: 'r', risk: 'r', rollback: 'r',
      });
      expect((await parseOwnerRequest(invalid)).kind).toBe('invalid');
    }
  });

  it('approbation /owner : l’acte exact est exécuté (v1 paused), rejeu idempotent, précondition = dernier acte', async () => {
    await clean('e2e');
    const params = { participant_id: 'gemini', status: 'paused', expected_version: 0 };
    const payload = {
      request_id: 's8a-e2e-' + (++n), summary: 'Pause serveur de Gemini (S8a)',
      action: 'set_agent_run_status', params, payload_sha256: await executablePayloadSha256('set_agent_run_status', params),
      preconditions: { previous_seq: await latestRunStatusActSeq(db, 'gemini') },
      reason: 'consultation S8a (AMEND seq 1404)', risk: 'aucun réveil pour gemini', rollback: 'acte set_agent_run_status resumed',
    };
    await db.prepare("INSERT INTO events (cycle_id, at, type, participant_id, payload_json, idempotency_key) VALUES ('owner-registry', ?1, 'owner.request', 'vibe', ?2, ?3)")
      .bind(1, JSON.stringify(payload), 's8a-req-' + n).run();
    const seq = (await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind('s8a-req-' + n).first<{ seq: number }>())!.seq;
    const outcome = await decideOwnerRequest(db, {
      request_id: payload.request_id, decision: 'approve', proof: OWNER_PROOF,
      request_seq: seq, payload_sha256: payload.payload_sha256, now: () => NOW,
    });
    expect(outcome.status).toBe('applied');
    expect(outcome.executed).toMatchObject({ action: 'set_agent_run_status', cycle_id: 'owner-registry' });
    expect(outcome.executed?.detail).toContain('gemini → paused (v1)');
    expect(await loadAgentRunStatus(db, 'gemini')).toMatchObject({ version: 1, status: 'paused' });
    expect(await latestRunStatusActSeq(db, 'gemini')).toBe(outcome.event.seq);
    expect((await runCapacity(db, CC3_TEST, 'gemini', null, 'implement', NOW)).reason).toMatch(/^AGENT_PAUSED/);
    // Rejeu du même formulaire : déjà tranchée et exécutée, aucune seconde version.
    const replay = await decideOwnerRequest(db, {
      request_id: payload.request_id, decision: 'approve', proof: OWNER_PROOF,
      request_seq: seq, payload_sha256: payload.payload_sha256, now: () => NOW,
    });
    expect(replay.status).toBe('duplicate');
    expect((await loadAgentRunStatus(db, 'gemini'))?.version).toBe(1);
  });
});

describe('CC-8 S8a — planificateur et vue du coordinateur : pause = aucune exécution, verdict journalisé', () => {
  it('pause → aucune exécution, AGENT_PAUSED consigné ; resumed → resservi au passage suivant', async () => {
    const cycle = await clean('plan');
    for (const pid of AGENTS) {
      await registerParticipant(db, { participant_id: pid, display_label: pid, proof: OWNER_PROOF, op: 's8a-reg-' + pid + '-' + (++n) })
        .catch(() => undefined);
    }
    const others = AGENTS.filter(pid => pid !== 'gemini');
    await insertTaskRow(db, { taskId: 't-gemini', cycle, owner: 'gemini', reviewer: others[0], tester: others[1] });
    await pause('gemini', 0, 'paused', 'pause pour le test du planificateur');
    const env = { ...CC3_TEST, AGENT_RUN_PARTICIPANTS: 'gemini' };
    const blocked = await planAgentRuns(db, env, { now: 1_992_000_000 });
    expect(blocked).toMatchObject({ created: 0, incapable: 1 });
    expect(blocked.incapable_detail?.[0].reason).toMatch(/^AGENT_PAUSED : gemini/);
    expect(await runsOf(cycle)).toEqual([]);
    // Verdict consigné (agent_run_capacity) et rendu au coordinateur (collab_agent_runs_overview).
    const view = await coordinatorRunOverview(db, cycle, { now: 1_992_000_010 });
    const row = view.capacity.find(entry => entry.participant_id === 'gemini');
    expect(row?.capable).toBe(false);
    expect(row?.reason).toMatch(/^AGENT_PAUSED/);
    // Réversibilité : l'acte opposé rend le service, l'exécution part au passage suivant.
    await pause('gemini', 1, 'resumed');
    const served = await planAgentRuns(db, env, { now: 1_992_000_900 });
    expect(served.created).toBe(1);
    expect(await runsOf(cycle)).toEqual(['gemini']);
  });
});
