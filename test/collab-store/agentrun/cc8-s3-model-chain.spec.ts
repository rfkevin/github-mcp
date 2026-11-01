import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import wranglerRaw from '../../../wrangler.jsonc?raw';
import { runCapacity } from '../../../src/collab-store/agentrun/capacity';
import {
  ensureModelChainSchema, loadChainSnapshot, loadModelChain, modelCatalog, participantPolicy, resolveParticipantPolicy,
} from '../../../src/collab-store/agentrun/model-policy';
import { latestModelChainActSeq, setAgentModels } from '../../../src/collab-store/owner/model-chains';
import { decideOwnerRequest, executablePayloadSha256, parseOwnerRequest } from '../../../src/collab-store/owner/executable';
import type { OwnerProof } from '../../../src/collab-store/owner/proof';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { OWNER_PROOF } from '../coordinator-helpers';

// CC-8 S3 (CC-PLAN-8 §1.6, validé par Kevin) — chaînes de modèles dans le store.
// AC : changement de chaîne sans PR, refus non-owner, restauration testée, routage identique.
// Configuration réelle rejouée : variables cc3-test lues dans wrangler.jsonc (la liste
// AGENT_RUN_MODELS_VIBE versionnée ne contient PAS zai:glm-4.7-flash ; seule une chaîne du
// store peut y faire router ce maillon sans PR).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const wrangler = JSON.parse(wranglerRaw) as { env: Record<string, { vars: Record<string, string> }> };
const CC3_VARS = wrangler.env['cc3-test'].vars;
const CC3_TEST = { ...CC3_VARS, AI: {} };
const NOW = new Date('2032-11-02T10:00:00Z');
let n = 0;

/** Chaîne convenue de Vibe (CC-PLAN-8 §1.6, première valeur) : glm-5.3 payant inactif → zai:glm-4.7-flash gratuit → secours Workers AI. */
const VIBE_CHAIN = [
  { ref: 'zai:glm-5.3', status: 'inactive' },
  { ref: 'zai:glm-4.7-flash', status: 'primary' },
  { ref: 'workers-ai:@cf/zai-org/glm-4.7-flash', status: 'rollback' },
];

/** Isolation : les chaînes des tests précédents (base partagée) sont retirées. */
async function cleanChain(): Promise<void> {
  await ensureSchema(db);
  await db.prepare('DELETE FROM agent_model_chains').run();
  await db.prepare('DELETE FROM agent_model_chain_versions').run();
  await db.prepare("INSERT INTO cycles (cycle_id) VALUES ('owner-registry') ON CONFLICT(cycle_id) DO NOTHING").run();
}

const setChain = (input: { participant_id: string; expected_version: number; chain?: unknown; rollback?: boolean; reason?: string }) =>
  setAgentModels(db, { proof: OWNER_PROOF, op: 's3-' + (++n), ...input });

describe('CC-8 S3 — résolution store d’abord, wrangler par défaut', () => {
  it('sans chaîne dans le store : routage IDENTIQUE aux listes wrangler (AC4)', async () => {
    await cleanChain();
    for (const pid of ['claude', 'grok', 'vibe', 'gemini']) {
      const resolved = await resolveParticipantPolicy(db, CC3_TEST, pid);
      expect(resolved.source).toBe('env');
      expect(resolved.chain_version).toBeNull();
      expect(resolved.chain).toBeNull();
      expect(resolved.policy).toEqual(participantPolicy(CC3_TEST, pid));
    }
    // Baseline S1a inchangée : Vibe capable par Workers AI (zai:glm-4.7-flash absent de la liste versionnée).
    expect(await runCapacity(db, CC3_TEST, 'vibe', null, 'implement', NOW))
      .toEqual({ capable: true, reason: 'workers-ai:@cf/zai-org/glm-4.7-flash' });
  });

  it('chaîne posée : le maillon primary route SANS aucune PR ni variable wrangler (AC1)', async () => {
    await cleanChain();
    const result = await setChain({ participant_id: 'vibe', expected_version: 0, chain: VIBE_CHAIN });
    expect(result.status).toBe('applied');
    expect(result.version).toBe(1);
    expect(result.chain).toEqual(VIBE_CHAIN);
    const resolved = await resolveParticipantPolicy(db, CC3_TEST, 'vibe');
    expect(resolved.source).toBe('store');
    expect(resolved.chain_version).toBe(1);
    // primary puis rollback (secours de dernier recours) sont routés, dans l’ordre de la chaîne ; inactive jamais routé.
    expect(resolved.policy?.models).toEqual(['zai:glm-4.7-flash', 'workers-ai:@cf/zai-org/glm-4.7-flash']);
    expect(resolved.policy?.family).toBe('zai');
    expect(resolved.policy?.rejected).toEqual([{ ref: 'zai:glm-5.3', reason: 'statut inactive non routé' }]);
    // Même calcul que l’exécution réelle : la capacité suit la chaîne (clé zai posée pour le maillon gratuit).
    const withKey = { ...CC3_TEST, LLM_KEY_ZAI: 'k' };
    expect(await runCapacity(db, withKey, 'vibe', null, 'review', NOW)).toEqual({ capable: true, reason: 'zai:glm-4.7-flash' });
    // Sans la clé : le secours rollback de la même famille prend le relais, jamais de repli inter-familles.
    expect(await runCapacity(db, CC3_TEST, 'vibe', null, 'review', NOW))
      .toEqual({ capable: true, reason: 'workers-ai:@cf/zai-org/glm-4.7-flash' });
  });
});

describe('CC-8 S3 — acte owner : refus non-owner, CAS, restauration (AC2, AC3)', () => {
  it('refus non-owner : la preuve déléguée ne règle jamais une chaîne, rien n’est écrit', async () => {
    await cleanChain();
    const delegated = { kind: 'delegated', subject: 'gpt6' } as unknown as OwnerProof;
    await expect(setAgentModels(db, { participant_id: 'vibe', expected_version: 0, chain: VIBE_CHAIN, proof: delegated, op: 's3-deleg' }))
      .rejects.toMatchObject({ code: 'DELEGATED_FORBIDDEN' });
    expect(await loadModelChain(db, 'vibe')).toBeNull();
  });

  it('CAS sur la version attendue : stale = refus typé, rien n’est écrit', async () => {
    await cleanChain();
    await setChain({ participant_id: 'vibe', expected_version: 0, chain: VIBE_CHAIN });
    await expect(setChain({ participant_id: 'vibe', expected_version: 0, chain: VIBE_CHAIN }))
      .rejects.toMatchObject({ code: 'CHAIN_VERSION_STALE' });
    expect((await loadModelChain(db, 'vibe'))?.version).toBe(1);
  });

  it('restauration : rollback remet la version précédente, instantanés immuables (AC3)', async () => {
    await cleanChain();
    await setChain({ participant_id: 'vibe', expected_version: 0, chain: VIBE_CHAIN }); // v1
    const second = [
      { ref: 'zai:glm-4.7-flash', status: 'primary' },
      { ref: 'zai:glm-5.3', status: 'beta' },
    ];
    await setChain({ participant_id: 'vibe', expected_version: 1, chain: second }); // v2
    const rolled = await setChain({ participant_id: 'vibe', expected_version: 2, rollback: true, reason: 'retour arrière testé' }); // v3 = v1
    expect(rolled.action).toBe('rollback');
    expect(rolled.version).toBe(3);
    expect(rolled.chain).toEqual(VIBE_CHAIN);
    expect((await loadModelChain(db, 'vibe'))?.chain).toEqual(VIBE_CHAIN);
    // Instantanés immuables : chaque version posée reste lisible, jamais réécrite.
    expect(await loadChainSnapshot(db, 'vibe', 1)).toEqual(VIBE_CHAIN);
    expect(await loadChainSnapshot(db, 'vibe', 2)).toEqual(second);
    expect(await loadChainSnapshot(db, 'vibe', 3)).toEqual(VIBE_CHAIN);
    // Restaurer la version 0 retire la chaîne : retour aux défauts wrangler, routage identique à l’existant (AC3 + AC4).
    const before = await runCapacity(db, { ...CC3_TEST, LLM_KEY_GEMINI: 'k' }, 'gemini', null, 'review', NOW);
    const geminiChain = [{ ref: 'gemini:gemini-3.6-flash', status: 'primary' }];
    await setChain({ participant_id: 'gemini', expected_version: 0, chain: geminiChain });
    expect(await runCapacity(db, { ...CC3_TEST, LLM_KEY_GEMINI: 'k' }, 'gemini', null, 'review', NOW))
      .toEqual({ capable: true, reason: 'gemini:gemini-3.6-flash' });
    const removed = await setChain({ participant_id: 'gemini', expected_version: 1, rollback: true });
    expect(removed.action).toBe('rollback');
    expect(removed.chain).toBeNull();
    expect(await loadModelChain(db, 'gemini')).toBeNull();
    expect(await runCapacity(db, { ...CC3_TEST, LLM_KEY_GEMINI: 'k' }, 'gemini', null, 'review', NOW)).toEqual(before);
  });
});

describe('CC-8 S3 — F1 fail-on-diff : la chaîne ne crée jamais de définition', () => {
  it('références hors fiche, familles, statuts et primary manquant : refus typés, rien n’est écrit', async () => {
    await cleanChain();
    // Hors fiche (aucune définition de ce modèle pour Vibe).
    await expect(setChain({ participant_id: 'vibe', expected_version: 0, chain: [{ ref: 'zai:glm-9.9', status: 'primary' }] }))
      .rejects.toMatchObject({ code: 'CHAIN_FICHE_DIFF' });
    // Mélange de familles au sein de la chaîne (endpoint GLM de la fiche Claude ≠ famille anthropic).
    await expect(setChain({ participant_id: 'claude', expected_version: 0,
      chain: [{ ref: 'anthropic:claude-haiku-5-5', status: 'primary' }, { ref: 'workers-ai:@cf/zai-org/glm-4.7-flash', status: 'beta' }] }))
      .rejects.toMatchObject({ code: 'CHAIN_FAMILY_DIFF' });
    // Participant absent de la fiche.
    await expect(setChain({ participant_id: 'solo', expected_version: 0, chain: [{ ref: 'zai:glm-4.7-flash', status: 'primary' }] }))
      .rejects.toMatchObject({ code: 'CHAIN_FICHE_UNKNOWN' });
    // Statut inconnu.
    await expect(setChain({ participant_id: 'vibe', expected_version: 0, chain: [{ ref: 'zai:glm-5.3', status: 'chapeau' }] }))
      .rejects.toMatchObject({ code: 'CHAIN_STATUS_UNKNOWN' });
    // Aucun primary : rien ne serait routé.
    await expect(setChain({ participant_id: 'vibe', expected_version: 0, chain: [{ ref: 'zai:glm-4.7-flash', status: 'candidate' }] }))
      .rejects.toMatchObject({ code: 'CHAIN_NO_PRIMARY' });
    expect(await loadModelChain(db, 'vibe')).toBeNull();
    expect(await loadModelChain(db, 'claude')).toBeNull();
  });
});

describe('CC-8 S3 — demande exécutable set_agent_models', () => {
  it('payload valide : classe exécutable, cible le participant, cycle owner-registry', async () => {
    await cleanChain();
    const params = { participant_id: 'vibe', expected_version: 0, chain: VIBE_CHAIN };
    const payload = JSON.stringify({
      request_id: 's3-parse-' + (++n), summary: 'Chaîne de Vibe (CC-PLAN-8 §1.6)',
      action: 'set_agent_models', params, payload_sha256: await executablePayloadSha256('set_agent_models', params),
      preconditions: { previous_seq: await latestModelChainActSeq(db, 'vibe') },
      reason: 'première valeur convenue', risk: 'aucun appel déclenché par l’acte', rollback: 'rollback owner de la version précédente',
    });
    const parsed = await parseOwnerRequest(payload);
    expect(parsed.kind).toBe('executable');
    if (parsed.kind !== 'executable') return;
    expect(parsed.request.target).toBe('vibe');
    expect(parsed.request.cycle_id).toBe('owner-registry');
    // Structure refusée d’emblée : statut inconnu → demande invalide, non approuvable.
    const bad = JSON.stringify({
      request_id: 's3-parse-bad-' + n, summary: 'invalide', action: 'set_agent_models',
      params: { participant_id: 'vibe', expected_version: 0, chain: [{ ref: 'zai:glm-4.7-flash', status: 'inconnu' }] },
      payload_sha256: await executablePayloadSha256('set_agent_models', { participant_id: 'vibe', expected_version: 0, chain: [{ ref: 'zai:glm-4.7-flash', status: 'inconnu' }] }),
      preconditions: { previous_seq: null }, reason: 'r', risk: 'r', rollback: 'r',
    });
    expect((await parseOwnerRequest(bad)).kind).toBe('invalid');
  });

  it('approbation /owner : la demande exécutable pose la chaîne, rejeu idempotent (AC1 + AC2)', async () => {
    await cleanChain();
    const params = { participant_id: 'vibe', expected_version: 0, chain: VIBE_CHAIN };
    const payload = {
      request_id: 's3-e2e-' + (++n), summary: 'Chaîne de Vibe (première valeur)',
      action: 'set_agent_models', params, payload_sha256: await executablePayloadSha256('set_agent_models', params),
      preconditions: { previous_seq: await latestModelChainActSeq(db, 'vibe') },
      reason: 'première valeur convenue seq 1212', risk: 'aucun appel déclenché par l’acte', rollback: 'rollback owner de la version précédente',
    };
    await db.prepare("INSERT INTO events (cycle_id, at, type, participant_id, payload_json, idempotency_key) VALUES ('owner-registry', ?1, 'owner.request', 'vibe', ?2, ?3)")
      .bind(1, JSON.stringify(payload), 's3-e2e-req-' + n).run();
    const seq = (await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind('s3-e2e-req-' + n).first<{ seq: number }>())!.seq;
    const outcome = await decideOwnerRequest(db, {
      request_id: payload.request_id, decision: 'approve', proof: OWNER_PROOF,
      request_seq: seq, payload_sha256: payload.payload_sha256, now: () => NOW,
    });
    expect(outcome.status).toBe('applied');
    expect(outcome.executed?.action).toBe('set_agent_models');
    expect((await loadModelChain(db, 'vibe'))?.version).toBe(1);
    expect((await resolveParticipantPolicy(db, CC3_TEST, 'vibe')).source).toBe('store');
    // Approbation rejouée : déjà tranchée et exécutée, aucune seconde version.
    const replay = await decideOwnerRequest(db, {
      request_id: payload.request_id, decision: 'approve', proof: OWNER_PROOF,
      request_seq: seq, payload_sha256: payload.payload_sha256, now: () => NOW,
    });
    expect(replay.status).toBe('duplicate');
    expect((await loadModelChain(db, 'vibe'))?.version).toBe(1);
  });
});

describe('CC-8 S3 — vues : le catalogue suit la même source que le routage', () => {
  it('chaîne du store visible avec ses maillons et alias ep-*, défauts wrangler sinon', async () => {
    await cleanChain();
    const before = (await modelCatalog(db, CC3_TEST)).find(entry => entry.participant_id === 'vibe');
    expect(before?.chain).toEqual({ source: 'env', version: null, entries: null });
    await setChain({ participant_id: 'vibe', expected_version: 0, chain: VIBE_CHAIN });
    const after = (await modelCatalog(db, CC3_TEST)).find(entry => entry.participant_id === 'vibe');
    expect(after?.chain).toMatchObject({ source: 'store', version: 1 });
    expect(after?.chain?.entries).toEqual([
      { ref: 'zai:glm-5.3', status: 'inactive', endpoint_id: null },
      { ref: 'zai:glm-4.7-flash', status: 'primary', endpoint_id: 'ep-zai-glm47' },
      { ref: 'workers-ai:@cf/zai-org/glm-4.7-flash', status: 'rollback', endpoint_id: null },
    ]);
  });
});
