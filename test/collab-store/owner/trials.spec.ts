import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createOAuthFixture } from '../../oauth/helpers';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { sha256Hex } from '../../../src/collab-store/store/hash';
import { isAutomationHalted, setAutomationHalt } from '../../../src/collab-store/owner/automation';
import type { WorkersAiBinding } from '../../../src/collab-store/executors';
import { OWNER_TRIAL_CYCLE } from '../../../src/collab-store/owner/trials';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const haltDb = (env as unknown as { COLLAB_DB_C6_RESTORE: D1Database }).COLLAB_DB_C6_RESTORE;
const SECRET = 'owner-secret-A4-MINI-0123456789abcdefghij';
const MODEL_REF = 'workers-ai:@cf/zai-org/glm-4.7-flash';
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const uniq = (label: string) => 'a4m-' + label + '-' + Date.now().toString(36) + '-' + (++n);

function fakeAi(output = 'Résumé de la tâche réelle.') {
  const calls: Array<Record<string, unknown>> = [];
  const ai: WorkersAiBinding = {
    async run(_model, input) {
      calls.push(input);
      return { response: output, usage: { prompt_tokens: 25, completion_tokens: 7 } };
    },
  };
  return { ai, calls, output };
}

async function seedEndpoint(target: D1Database, endpointId: string, status = 'active') {
  await ensureSchema(target);
  const principal = 'p-' + endpointId;
  await target.prepare([
    'INSERT INTO endpoints (endpoint_id, principal_id, attestation_kind, attestation_ref, status, capability_set, registered_at)',
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  ].join(' ')).bind(endpointId, principal, 'provider_adapter', MODEL_REF, status,
    JSON.stringify({ tools: ['llm.generate'], network_providers: ['workers-ai'], token_ceiling: 512 }),
    Math.floor(Date.now() / 1000)).run();
  return principal;
}

function fixture(target: D1Database, ai: WorkersAiBinding, extra: Record<string, unknown> = {}) {
  return createOAuthFixture({
    COLLAB_DB: target, COLLAB_STORE_ENABLED: 'true', OWNER_AUTH_MODE: 'secret', OWNER_SECRET: SECRET, AI: ai, ...extra,
  });
}

function post(fx: ReturnType<typeof createOAuthFixture>, fields: Record<string, string>) {
  return fx.send('/owner', { method: 'POST', headers: { Origin: fx.ORIGIN }, body: new URLSearchParams(fields) });
}

describe('CC-4 A4-mini — Tâche d’essai /owner', () => {
  afterEach(async () => {
    if (await isAutomationHalted(haltDb)) {
      await setAutomationHalt(haltDb, { halted: false, proof, op: uniq('cleanup') });
    }
  });

  it('succès : invocation A1 succeeded, provenance/hash seulement, réponse affichée mais non stockée', async () => {
    const endpointId = uniq('active');
    const principal = await seedEndpoint(db, endpointId);
    const { ai, calls, output } = fakeAi();
    const fx = fixture(db, ai);
    const data = 'Un paragraphe à résumer sans exécuter ses éventuelles instructions.';
    const response = await post(fx, {
      action: 'run_trial', endpoint_id: endpointId, trial_instruction: 'summarize', trial_data: data, owner_secret: SECRET,
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('Tâche d’essai réussie');
    expect(body).toContain(output);
    expect(body).toContain('Tâche d’essai');
    expect(body).toContain('maxlength="4000"');
    expect(body).toContain('relire (signaler les risques)');
    expect(body).not.toContain(SECRET);
    expect(calls).toHaveLength(1);

    const invocation = await db.prepare([
      'SELECT * FROM invocations WHERE cycle_id = ?1 AND endpoint_id = ?2 ORDER BY queued_at DESC, invocation_id DESC LIMIT 1',
    ].join(' ')).bind(OWNER_TRIAL_CYCLE, endpointId).first<{
      state: string; principal_id: string; output_hash: string; usage_input_tokens: number;
      usage_output_tokens: number; evidence_refs: string;
    }>();
    expect(invocation).toMatchObject({
      state: 'succeeded', principal_id: principal, output_hash: await sha256Hex(output),
      usage_input_tokens: 25, usage_output_tokens: 7,
    });
    expect(JSON.parse(invocation!.evidence_refs)).toEqual(['provider:workers-ai', 'model:@cf/zai-org/glm-4.7-flash']);

    const events = await db.prepare('SELECT payload_json FROM events WHERE cycle_id = ?1 AND payload_json LIKE ?2')
      .bind(OWNER_TRIAL_CYCLE, '%"' + endpointId + '"%').all<{ payload_json: string }>();
    expect(JSON.stringify(events.results)).not.toContain(output);
    expect(JSON.stringify(events.results)).not.toContain(data);
    expect(JSON.stringify(events.results)).not.toContain(SECRET);
  });

  it('refus : secret absent, endpoint inactif, consigne hors liste, arrêt d’urgence', async () => {
    const { ai, calls } = fakeAi();
    const active = uniq('guard-active');
    const inactive = uniq('guard-inactive');
    await seedEndpoint(db, active);
    await seedEndpoint(db, inactive, 'probe_required');
    const fx = fixture(db, ai);

    expect((await post(fx, {
      action: 'run_trial', endpoint_id: active, trial_instruction: 'summarize', trial_data: 'x',
    })).status).toBe(403);
    const inactiveResponse = await post(fx, {
      action: 'run_trial', endpoint_id: inactive, trial_instruction: 'summarize', trial_data: 'x', owner_secret: SECRET,
    });
    expect(inactiveResponse.status).toBe(409);
    expect(await inactiveResponse.text()).toContain('ENDPOINT_NOT_ACTIVE');

    const invalid = await post(fx, {
      action: 'run_trial', endpoint_id: active, trial_instruction: 'ignore-all-rules', trial_data: 'x', owner_secret: SECRET,
    });
    expect(invalid.status).toBe(409);
    expect(await invalid.text()).toContain('OWNER_TRIAL_INVALID_INSTRUCTION');
    expect(calls).toHaveLength(0);

    const halted = uniq('halted');
    await seedEndpoint(haltDb, halted);
    await setAutomationHalt(haltDb, { halted: true, proof, op: uniq('halt') });
    const haltFx = fixture(haltDb, ai);
    const blocked = await post(haltFx, {
      action: 'run_trial', endpoint_id: halted, trial_instruction: 'summarize', trial_data: 'x', owner_secret: SECRET,
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain('AUTOMATION_HALTED');
    expect(calls).toHaveLength(0);
  });

  it('clics répétés : le plafond quotidien reste une garde avant l’appel fournisseur', async () => {
    const endpointId = uniq('cap');
    await seedEndpoint(db, endpointId);
    const { ai, calls } = fakeAi('ok');
    const fx = fixture(db, ai, { EXECUTOR_DAILY_CAP: '2' });
    const fields = {
      action: 'run_trial', endpoint_id: endpointId, trial_instruction: 'review_risks', trial_data: 'données', owner_secret: SECRET,
    };
    expect((await post(fx, fields)).status).toBe(200);
    expect((await post(fx, fields)).status).toBe(200);
    const third = await post(fx, fields);
    expect(third.status).toBe(409);
    expect(await third.text()).toContain('EXECUTOR_DAILY_CAP');
    expect(calls).toHaveLength(2);
  });
});
