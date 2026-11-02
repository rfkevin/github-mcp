import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import wranglerRaw from '../../../wrangler.jsonc?raw';
import type { StoreEventType } from '../../../src/collab-store/contracts';
import {
  acquireEventPassLease, eventWake, PASS_LEASE_TTL_S, wakeWorthy, WAKE_EVENT_TYPES,
} from '../../../src/collab-store/agentrun/wake-trigger';
import type { WakeFn } from '../../../src/collab-store/agentrun/orchestrator';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import type { AgentRunObjectEnv } from '../../../src/collab-store/agentrun/object';
import { latestRunStatusActSeq } from '../../../src/collab-store/owner/agent-run-status';
import { handleOwnerRequest } from '../../../src/collab-store/owner/handler';
import { executablePayloadSha256 } from '../../../src/collab-store/owner/executable';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { OWNER_PROOF } from '../coordinator-helpers';

// CC-8 S8a (CC-PLAN-8, consultation S8a — GO de Kevin, AMEND seq 1404) — réveil événementiel.
// Constat : un réveil ne partait qu'au passage du contrôleur (webhook ou passage programmé) ;
// une question adressée attendait le prochain passage pour obtenir une exécution.
// AC : question adressée → exécution créée SANS cron ; 10 écritures → 1 seul passage
// (bail D1) ; duplicate/STALE/type hors liste/bail tenu → aucun passage ;
// owner.decision appliquée → passage ; jamais bloquant pour la réponse du canal.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const wrangler = JSON.parse(wranglerRaw) as { env: Record<string, { vars: Record<string, string> }> };
const CC3_VARS = wrangler.env['cc3-test'].vars;
// Clé Gemini posée : gemini, seul volontaire, est capable (S1a) ; AGENT_RUN est un faux binding
// (le wake de test est injecté) ; COLLAB_DB pointe la base du test pour le bail et le passage.
const WAKE_TEST: AgentRunObjectEnv = { ...CC3_VARS, AI: {} as never, LLM_KEY_GEMINI: 'k', AGENT_RUNS_ENABLED: 'true',
  AGENT_RUN_GITHUB_WRITES: 'true', AGENT_RUN_PARTICIPANTS: 'gemini', COLLAB_DB: db, AGENT_RUN: {} as never };
const REJECT_WAKE: WakeFn = async () => ({ accepted: false, reason: 'test' });
let n = 0;

/** Contexte d'exécution factice : collecte les promesses de waitUntil, les attend à la demande. */
function fakeWaitCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (task: Promise<unknown>) => { pending.push(task); } },
    async run(): Promise<void> { await Promise.all(pending.splice(0)); },
    count: () => pending.length,
  };
}

/** Isolation : bail vidé (singleton mutable), cycles précédents clos, cycle P6 neuf (révision 1). */
async function clean(label: string): Promise<string> {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  await db.prepare('DELETE FROM agent_run_pass_lease').run();
  await db.prepare("UPDATE cycles SET status = 'closed' WHERE status = 'open'").run();
  const cycle = ('0000-cc8-s8a-w-' + label + '-' + (++n)).slice(0, 48);
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  for (const pid of ['gemini', 'vibe']) {
    await registerParticipant(db, { participant_id: pid, display_label: pid, proof: OWNER_PROOF, op: 's8a-reg-' + pid + '-' + cycle })
      .catch(() => undefined);
  }
  return cycle;
}

async function runsOf(cycle: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT participant_id FROM agent_runs WHERE cycle_id = ?1 ORDER BY participant_id')
    .bind(cycle).all<{ participant_id: string }>();
  return (results ?? []).map(row => row.participant_id);
}

/** Semer un réveil pending (outbox) : chaque passage qui le réclame incrémente attempts (rejet → réclamable). */
async function seedPendingWakeup(label: string): Promise<string> {
  const runId = 's8a-wake-' + label + '-' + (++n) + '-' + Date.now().toString(36);
  await db.prepare([
    'INSERT INTO agent_run_wakeups (run_id, lease_key, requested_at, status, claimed_by, claimed_until, attempts, last_error)',
    "VALUES (?1, ?2, 0, 'pending', '', 0, 0, '')",
  ].join(' ')).bind(runId, 'lease-' + runId).run();
  return runId;
}

async function wakeupOf(runId: string): Promise<{ attempts: number; claimed_by: string }> {
  return (await db.prepare('SELECT attempts, claimed_by FROM agent_run_wakeups WHERE run_id = ?1').bind(runId)
    .first<{ attempts: number; claimed_by: string }>())!;
}

describe('CC-8 S8a — unitaire : types réveil et bail anti-rafale', () => {
  it('wakeWorthy : types de la liste ; clarify.ask seulement si to non vide ; autres types non', () => {
    for (const type of WAKE_EVENT_TYPES) {
      if (type !== 'clarify.ask') expect(wakeWorthy(type, '{}')).toBe(true);
    }
    expect(wakeWorthy('clarify.ask', JSON.stringify({ question: 'q', to: 'gemini' }))).toBe(true);
    expect(wakeWorthy('clarify.ask', JSON.stringify({ question: 'q' }))).toBe(false);
    expect(wakeWorthy('clarify.ask', JSON.stringify({ question: 'q', to: '' }))).toBe(false);
    expect(wakeWorthy('clarify.ask', 'pas du json')).toBe(false);
    expect(wakeWorthy('clarify.answer', JSON.stringify({ ask_seq: 1, answer: 'a' }))).toBe(false);
    expect(wakeWorthy('checkpoint', '{}')).toBe(false);
    expect(wakeWorthy('memory.propose', '{}')).toBe(false);
    expect(wakeWorthy('proposal.submit', '{}')).toBe(false);
  });

  it('bail : acquis à t, refusé avant expiration (t+10, t+59), réacquis à expiration (t+60) ; TTL 60 s', async () => {
    await clean('lease');
    expect(await acquireEventPassLease(db, 1_000, 'holder-a')).toBe(true);
    expect(await acquireEventPassLease(db, 1_010, 'holder-b')).toBe(false);
    expect(await acquireEventPassLease(db, 1_059, 'holder-c')).toBe(false);
    expect(await acquireEventPassLease(db, 1_060, 'holder-d')).toBe(true);
    expect(PASS_LEASE_TTL_S).toBe(60);
    const row = (await db.prepare('SELECT id, holder, expires_at FROM agent_run_pass_lease')
      .first<{ id: number; holder: string; expires_at: number }>())!;
    expect(row).toEqual({ id: 1, holder: 'holder-d', expires_at: 1_120 });
  });
});

describe('CC-8 S8a — pipeline du canal /collab/mcp : écriture appliquée → un passage au plus', () => {
  it('question adressée (clarify.ask to gemini) → exécution answer créée SANS cron ; passage sous waitUntil', async () => {
    const cycle = await clean('question');
    await insertTaskRow(db, { taskId: 't-gemini', cycle, owner: 'vibe', reviewer: 'grok', tester: 'gpt6' });
    // Question semée hors store (SQL direct) : le réveil doit venir de l'écriture appliquée suivante du canal.
    await insertEventRow(db, { cycle, type: 'clarify.ask', participant: 'vibe', role: '',
      payload: { question: 'Où en es-tu ?', to: 'gemini' }, key: cycle + ':seed-ask:1', expectedRev: 1 });
    const harness = fakeWaitCtx();
    const store = new CollabStore(db, { onApplied: eventWake(WAKE_TEST, harness.ctx, REJECT_WAKE) });
    const ask = await store.appendEvent({ cycle_id: cycle, type: 'clarify.ask', participant_id: 'vibe', expected_rev: 1,
      payload_json: JSON.stringify({ question: 'Où en es-tu ?', to: 'gemini' }), op_id: 'vibe:' + cycle + ':s8aask:1' });
    expect(ask.status).toBe('applied');
    expect(harness.count()).toBe(1); // le passage est programmé, la réponse du canal n'attend pas
    const started = Date.now();
    await harness.run();
    // waitUntil : le runtime couvre la fenêtre après la réponse ; le passage mesuré ici reste de l'ordre de la seconde.
    expect(Date.now() - started).toBeLessThan(30_000);
    // La question adressée a obtenu son exécution answer au passage ÉVÉNEMENTIEL (aucun cron appelé).
    expect(await runsOf(cycle)).toEqual(['gemini']);
    const claimed = (await db.prepare("SELECT COUNT(*) AS c FROM agent_run_wakeups WHERE claimed_by LIKE 'event-pass:%'")
      .first<{ c: number }>())!.c;
    expect(claimed).toBeGreaterThanOrEqual(1); // livreur du passage = event-pass:…
  });

  it('anti-rafale : dix écritures appliquées en rafale → UN seul passage (bail D1), livreur event-pass', async () => {
    const cycle = await clean('rafale');
    const runId = await seedPendingWakeup('rafale');
    const harness = fakeWaitCtx();
    const store = new CollabStore(db, { onApplied: eventWake(WAKE_TEST, harness.ctx, REJECT_WAKE) });
    for (let i = 0; i < 10; i += 1) {
      const out = await store.appendEvent({ cycle_id: cycle, type: 'evidence.add', participant_id: 'vibe',
        expected_rev: 1 + i, payload_json: JSON.stringify({ task: 't-gemini', source: 'test', state: 'ok' }),
        op_id: 'vibe:' + cycle + ':s8a:' + (i + 1) });
      expect(out.status, 'append ' + i).toBe('applied');
    }
    expect(harness.count()).toBe(10); // chaque écriture appliquée programme sa promesse…
    await harness.run();
    const row = await wakeupOf(runId);
    expect(row.attempts).toBe(1); // …mais un seul passage a réclamé le réveil (bail anti-rafale)
    expect(row.claimed_by).toMatch(/^event-pass:/);
  });

  it('contre-preuves : type hors liste, clarify.ask sans to, duplicate, STALE, bail tenu → aucun passage', async () => {
    const cycle = await clean('contre');
    const runId = await seedPendingWakeup('contre');
    const harness = fakeWaitCtx();
    const store = new CollabStore(db, { onApplied: eventWake(WAKE_TEST, harness.ctx, REJECT_WAKE) });
    const append = (type: StoreEventType, payload: unknown, op_id: string, expected_rev: number) =>
      store.appendEvent({ cycle_id: cycle, type, participant_id: 'vibe', expected_rev,
        payload_json: JSON.stringify(payload), op_id });
    // Type hors liste appliqué : checkpoint ne réveille pas.
    expect((await append('checkpoint', {}, 'vibe:' + cycle + ':s8aquiet:1', 1)).status).toBe('applied');
    // clarify.ask sans to appliquée : question non adressée, aucun réveil.
    expect((await append('clarify.ask', { question: 'note' }, 'vibe:' + cycle + ':s8aorphan:1', 2)).status).toBe('applied');
    expect(harness.count()).toBe(0);
    // Bail tenu AVANT l'écriture réveil (la promesse du hook démarre dès l'append) :
    // l'écriture suivante s'applique, sa promesse s'exécute, mais aucun passage ne part.
    expect(await acquireEventPassLease(db, Math.floor(Date.now() / 1000), 'manuel')).toBe(true);
    const held = await append('evidence.add', { task: 't', source: 's', state: 'ok' }, 'vibe:' + cycle + ':s8adup:1', 3);
    expect(held.status).toBe('applied');
    expect(harness.count()).toBe(1);
    // Duplicate (même op_id rejoué) : statut duplicate, le hook n'est jamais appelé.
    expect((await append('evidence.add', { task: 't', source: 's', state: 'ok' }, 'vibe:' + cycle + ':s8adup:1', 4)).status).toBe('duplicate');
    expect(harness.count()).toBe(1);
    // STALE (révision périmée) : refusé, aucun réveil.
    expect((await append('evidence.add', { task: 't', source: 's', state: 'ok' }, 'vibe:' + cycle + ':s8astale:1', 99)).status).toBe('stale');
    expect(harness.count()).toBe(1);
    await harness.run();
    expect((await wakeupOf(runId)).attempts).toBe(0); // aucun passage n'a réclamé le réveil
  });

  it('inerte : sans AGENT_RUNS_ENABLED ni binding AGENT_RUN, aucune promesse programmée', async () => {
    const cycle = await clean('inerte');
    const off = fakeWaitCtx();
    const storeOff = new CollabStore(db, { onApplied: eventWake({ ...WAKE_TEST, AGENT_RUNS_ENABLED: 'false' }, off.ctx, REJECT_WAKE) });
    const noBinding = fakeWaitCtx();
    const storeNoBinding = new CollabStore(db, { onApplied: eventWake({ ...WAKE_TEST, AGENT_RUN: undefined }, noBinding.ctx, REJECT_WAKE) });
    const cases: Array<[string, CollabStore]> = [['off', storeOff], ['no-binding', storeNoBinding]];
    for (const [label, store] of cases) {
      const out = await store.appendEvent({ cycle_id: cycle, type: 'evidence.add', participant_id: 'vibe',
        expected_rev: await store.currentRevision(cycle), payload_json: JSON.stringify({ task: 't', source: 's', state: 'ok' }),
        op_id: 'vibe:' + cycle + ':s8a' + label + ':1' });
      expect(out.status, label).toBe('applied');
    }
    expect(off.count()).toBe(0);
    expect(noBinding.count()).toBe(0);
  });
});

describe('CC-8 S8a — canal /owner : une décision owner appliquée réveille, un rejeu non', () => {
  const SECRET = 'x'.repeat(32); // owner/config.ts : MIN_OWNER_SECRET_LENGTH = 32.
  const OWNER_ENV = { COLLAB_DB: db, OWNER_AUTH_MODE: 'secret', OWNER_SECRET: SECRET };

  it('approbation d’une demande exécutable set_agent_run_status → passage déclenché ; rejeu duplicate → rien', async () => {
    const cycle = await clean('owner');
    const runId = await seedPendingWakeup('owner');
    const harness = fakeWaitCtx();
    // Décision approuvée = événement owner.decision APPLIQUÉ (type réveil) : le passage doit partir.
    const params = { participant_id: 'gemini', status: 'paused', expected_version: 0 };
    const payload = {
      request_id: 's8a-wake-' + (++n), summary: 'Pause serveur de Gemini (S8a, réveil événementiel)',
      action: 'set_agent_run_status', params, payload_sha256: await executablePayloadSha256('set_agent_run_status', params),
      preconditions: { previous_seq: await latestRunStatusActSeq(db, 'gemini') },
      reason: 'test du réveil sur owner.decision', risk: 'aucun réveil API pour gemini',
      rollback: 'acte set_agent_run_status resumed',
    };
    await insertEventRow(db, { cycle: 'owner-registry', type: 'owner.request', participant: 'vibe', role: '',
      payload, key: 's8a-oreq-' + n });
    const seq = (await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind('s8a-oreq-' + n)
      .first<{ seq: number }>())!.seq;
    const call = () => handleOwnerRequest(new Request('https://test/owner', { method: 'POST', headers: { Origin: 'https://test' },
      body: new URLSearchParams({ action: 'decide', request_id: payload.request_id, decision: 'approve',
        request_seq: String(seq), payload_sha256: payload.payload_sha256, owner_secret: SECRET }) }), OWNER_ENV, 'https://test',
      undefined, undefined, eventWake(WAKE_TEST, harness.ctx, REJECT_WAKE));
    const first = await call();
    expect(first?.status).toBe(200);
    expect(first && (await first.text())).toContain('set_agent_run_status');
    await harness.run();
    const row = await wakeupOf(runId);
    expect(row.attempts).toBe(1); // un passage est parti de la décision appliquée
    expect(row.claimed_by).toMatch(/^event-pass:/);
    // Rejeu du même formulaire : déjà tranchée, statut duplicate — aucune nouvelle décision appliquée.
    const again = await call();
    expect(again?.status).toBe(200);
    expect(harness.count()).toBe(0);
    await harness.run();
    expect((await wakeupOf(runId)).attempts).toBe(1);
  });
});
