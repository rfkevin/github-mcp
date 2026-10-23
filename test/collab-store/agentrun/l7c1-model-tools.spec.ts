import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  createRun, runStep, leaseKeyOf, ModelCallError, createWorkersAiModel, createReadToolHost, readModelResponse,
  meteredDb, READ_TOOLS_BY_KIND, type GitHubReads, type ToolHost, type ModelClient, type AgentMessage,
} from '../../../src/collab-store/agentrun';
import {
  objectWake, objectAlarm, consumeQuota, utcDay, ROWS_PER_STEP, GB_S_PER_STEP, DO_ROWS_PER_ALARM, QUOTA_RETRY_S,
  type ObjectSlot, type OrchestratorDeps,
} from '../../../src/collab-store/agentrun/orchestrator';
import { engineFor, AGENT_RUN_SYSTEM } from '../../../src/collab-store/agentrun/object';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { githubReadsFrom } from '../../../src/agent-run-object';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-5 l7 incrément 7c-1 — modèle réel (Workers AI, simulé ici par un faux binding),
// outils de lecture, mesure des lignes écrites et quota Go-s (plan v1.1, store seq 719).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const MODEL_REF = 'workers-ai:@cf/zai-org/glm-4.7-flash';
const T = 1_960_000_000;
let n = 0;

interface AiCall { model: string; input: Record<string, unknown> }

function fakeAi(responses: unknown[] | ((call: AiCall, index: number) => unknown)) {
  const calls: AiCall[] = [];
  return {
    calls,
    async run(model: string, input: Record<string, unknown>) {
      const call = { model, input };
      calls.push(call);
      const index = calls.length - 1;
      const next = typeof responses === 'function' ? responses(call, index) : responses[index];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function openAi(content: string, toolCalls: Array<{ id: string; name: string; args: unknown }> = [], usage = { prompt_tokens: 100, completion_tokens: 20 }) {
  return { choices: [{ message: { content, tool_calls: toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }], usage };
}

async function newRun(at: number, kind = 'research', participant = 'vibe') {
  await ensureSchema(db);
  const id = ++n;
  const input = {
    runId: 'l7c1-run-' + id + '-' + Date.now().toString(36), cycleId: 'l7c1-cycle-' + id, participantId: participant, taskId: 'l7',
    taskKind: kind, prompt: 'Lis le contexte et résume.', maxSteps: 10, maxTokens: 1_000_000, maxCostCents: 0, deadlineAt: at + 86_400, now: at,
  };
  expect((await createRun(db, input)).created).toBe(true);
  return { ...input, leaseKey: leaseKeyOf(input.cycleId, input.participantId, input.taskId) };
}

async function seedCycle(cycle: string) {
  const store = new CollabStore(db);
  await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'agent:seed', expected_rev: 0, payload_json: '{"note":"amorce"}',
    op_id: 'agent.seed:' + cycle + ':seed:1' });
}

function fakeGithub(): GitHubReads & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getTextFile(repository, path, ref) { calls.push('file:' + repository + ':' + path + '@' + ref); return { path, sha: 'a'.repeat(40), size: 5, content: 'x'.repeat(40_000) }; },
    async getPullRequest(repository, number) { calls.push('pr:' + repository + '#' + number); return { number, title: 't', state: 'open', draft: true, merged: false, head: { ref: 'h', sha: 'b'.repeat(40) }, base: { ref: 'b', sha: 'c'.repeat(40) }, body: 'SECRET-LIKE BODY' }; },
    async listCheckRuns(repository, ref) { calls.push('checks:' + repository + '@' + ref); return [{ name: 'ci', status: 'completed', conclusion: 'success', head_sha: ref, output: { text: 'long' } }]; },
  };
}

async function neuronsUsed(at: Date): Promise<number> {
  const key = 'neurons:workers-ai:' + at.toISOString().slice(0, 10);
  return (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(key).first<{ writes: number }>())?.writes ?? 0;
}

describe('CC-5 l7c-1 — modèle Workers AI', () => {
  it('lit les deux formes de réponse et les appels d’outils (arguments chaîne ou objet)', () => {
    const a = readModelResponse(openAi('ok', [{ id: 'x', name: 'store_context', args: {} }]));
    expect(a.output).toEqual({ text: 'ok', tool_calls: [{ id: 'x', name: 'store_context', args: {} }] });
    expect(a.input).toBe(100);
    const b = readModelResponse({ response: 'legacy', tool_calls: [{ name: 'store_delta', arguments: { since_seq: 3 } }] });
    expect(b.output).toEqual({ text: 'legacy', tool_calls: [{ id: 'call-0', name: 'store_delta', args: { since_seq: 3 } }] });
    expect(b.input).toBeNull();
    const c = readModelResponse({ choices: [{ message: { content: null, tool_calls: [{ function: { name: 'x', arguments: '{pas du json' } }] } }] });
    expect(c.output.tool_calls[0]).toEqual({ id: 'call-0', name: 'x', args: {} });
  });

  it('refuse un modèle hors liste gratuite ou payant, et un plafond de sortie hors bornes', () => {
    const base = { ai: fakeAi([]), db, neuronBudget: 8000, schemas: () => [], system: 's', maxOutputTokens: 512 };
    expect(() => createWorkersAiModel({ ...base, ref: 'workers-ai:@cf/zai-org/glm-5.3' })).toThrow(/paiement/);
    expect(() => createWorkersAiModel({ ...base, ref: 'openrouter:x/y' })).toThrow();
    expect(() => createWorkersAiModel({ ...base, ref: MODEL_REF, maxOutputTokens: 0 })).toThrow();
  });

  it('envoie consigne, messages et schémas des seuls outils autorisés ; réserve puis ramène les neurons au réel ; coût 0', async () => {
    const ai = fakeAi([openAi('je lis', [{ id: 'c1', name: 'store_context', args: {} }])]);
    const at = new Date('2032-01-05T10:00:00Z');
    const host = createReadToolHost({ db, repository: null, github: null });
    const model = createWorkersAiModel({ ai, ref: MODEL_REF, db, neuronBudget: 8000, schemas: kind => host.schemas(kind), system: 'CONSIGNE', maxOutputTokens: 256, now: () => at });
    const messages: AgentMessage[] = [{ role: 'user', content: 'go' }];
    const result = await model.complete({ messages, tools: ['store_context', 'github_read_file'], task_kind: 'research' });
    expect(result.usage).toEqual({ tokens: 120, cost_cents: 0 });
    expect(result.output.tool_calls).toEqual([{ id: 'c1', name: 'store_context', args: {} }]);
    const sent = ai.calls[0].input as { messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }>; max_tokens: number };
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'CONSIGNE' });
    expect(sent.max_tokens).toBe(256);
    // github_read_file demandé mais absent de l'hôte (pas de dépôt) : jamais exposé au modèle.
    expect(sent.tools.map(t => t.function.name)).toEqual(['store_context']);
    // Réel : ceil((100 × 5500 + 20 × 36400) / 1e6) = 2 neurons, réserve ramenée.
    expect(await neuronsUsed(at)).toBe(2);
  });

  it('budget de neurons insuffisant : aucun appel, ModelCallError sans usage', async () => {
    const ai = fakeAi([openAi('jamais')]);
    const at = new Date('2032-01-06T10:00:00Z');
    const model = createWorkersAiModel({ ai, ref: MODEL_REF, db, neuronBudget: 1, schemas: () => [], system: 's', maxOutputTokens: 8192, now: () => at });
    const error = await model.complete({ messages: [{ role: 'user', content: 'x'.repeat(5000) }], tools: [], task_kind: 'research' }).catch(e => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).usage).toBeNull();
    expect(ai.calls.length).toBe(0);
    expect(await neuronsUsed(at)).toBe(0);
  });

  it('erreur du fournisseur : usage = borne d’entrée (jamais 0), réserve laissée au pire cas', async () => {
    const ai = fakeAi([new Error('boom')]);
    const at = new Date('2032-01-07T10:00:00Z');
    const model = createWorkersAiModel({ ai, ref: MODEL_REF, db, neuronBudget: 8000, schemas: () => [], system: 's', maxOutputTokens: 100, now: () => at });
    const error = await model.complete({ messages: [{ role: 'user', content: 'abc' }], tools: [], task_kind: 'research' }).catch(e => e) as ModelCallError;
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error.usage!.tokens).toBeGreaterThan(0);
    expect(await neuronsUsed(at)).toBeGreaterThan(0);
  });

  it('A1 — sans usage rapporté, les résultats d’outils renvoyés au modèle sont comptés dans les jetons', async () => {
    const ai = fakeAi(() => ({ response: 'fin' }));
    const model = createWorkersAiModel({ ai, ref: MODEL_REF, db, neuronBudget: 8000, schemas: () => [], system: 's', maxOutputTokens: 64, now: () => new Date('2032-01-08T10:00:00Z') });
    const small = await model.complete({ messages: [{ role: 'user', content: 'q' }], tools: [], task_kind: 'research' });
    const big = await model.complete({ messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 'store_context', args: {} }] },
      { role: 'tool', tool_call_id: 'a', content: 'y'.repeat(16_000) },
    ], tools: [], task_kind: 'research' });
    expect(big.usage.tokens - small.usage.tokens).toBeGreaterThanOrEqual(16_000);
  });
});

describe('CC-5 l7c-1 — hôte d’outils en lecture seule', () => {
  it('allowlist figée par type de tâche, deny-by-default, aucun outil d’écriture', () => {
    const host = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github: fakeGithub() });
    expect(host.list('research')).toEqual([...READ_TOOLS_BY_KIND.research]);
    expect(host.list('fix')).toEqual([]);
    expect(host.list('__proto__')).toEqual([]);
    expect(host.spec('planning', 'github_check_runs')).toBeNull();
    for (const kind of Object.keys(READ_TOOLS_BY_KIND)) {
      for (const name of host.list(kind)) expect(host.spec(kind, name)).toEqual({ name, effect: 'read' });
    }
    const noRepo = createReadToolHost({ db, repository: null, github: null });
    expect(noRepo.list('research')).toEqual(['store_context', 'store_delta']);
  });

  it('parcours moteur réel : contexte et delta du SEUL participant de l’exécution, résultat tronqué, puis fin', async () => {
    const run = await newRun(T);
    await seedCycle(run.cycleId);
    const github = fakeGithub();
    const host = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github });
    const outputs = [
      openAi('contexte', [{ id: 'a', name: 'store_context', args: { cycle: 'autre-cycle', participant: 'kevin' } }]),
      openAi('fichier', [{ id: 'b', name: 'github_read_file', args: { path: 'README.md', ref: 'main' } }, { id: 'c', name: 'store_delta', args: { since_seq: 0 } }]),
      openAi('Résumé : rien à signaler.'),
    ];
    const ai = fakeAi(outputs);
    const model = createWorkersAiModel({ ai, ref: MODEL_REF, db, neuronBudget: 8000, schemas: k => host.schemas(k), system: 's', maxOutputTokens: 128, now: () => new Date('2032-01-09T10:00:00Z') });
    const deps = { model, tools: host, now: () => T, workerId: 'w1' };
    expect((await runStep(db, run.runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, run.runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, run.runId, deps)).outcome).toBe('completed');
    const steps = (await db.prepare('SELECT results FROM agent_run_steps WHERE run_id = ?1 ORDER BY n').bind(run.runId).all<{ results: string }>()).results
      .map(row => JSON.parse(row.results) as Array<{ id: string; content: string }>);
    // Les arguments du modèle ne choisissent ni le cycle ni le participant.
    expect(JSON.parse(steps[0][0].content)).toMatchObject({ cycle_id: run.cycleId });
    expect(steps[1][0].content.length).toBeLessThanOrEqual(16 * 1024 + 20);
    expect(steps[1][0].content.endsWith('…[tronqué]')).toBe(true);
    expect(github.calls).toEqual(['file:rfkevin/github-mcp:README.md@main']);
    expect(JSON.parse(steps[1][1].content).events[0]).toMatchObject({ type: 'checkpoint' });
    // Le modèle a reçu en messages les résultats tronqués, comme données.
    const third = ai.calls[2].input as { messages: Array<{ role: string; content: string }> };
    expect(third.messages.filter(m => m.role === 'tool').length).toBe(3);
  });

  it('refus en code : outil inconnu, outil interdit au canal API, arguments invalides, dépôt imposé par l’hôte', async () => {
    const run = await newRun(T + 100);
    const github = fakeGithub();
    const host = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github });
    const ai = fakeAi([
      openAi('essais', [
        { id: 'a', name: 'collab_append_event', args: {} },
        { id: 'b', name: 'github_write_file', args: {} },
        { id: 'c', name: 'github_check_runs', args: { sha: 'main' } },
        { id: 'd', name: 'github_pull_request', args: { number: 7, repository: 'evil/repo' } },
      ]),
      openAi('fin'),
    ]);
    const model = createWorkersAiModel({ ai, ref: MODEL_REF, db, neuronBudget: 8000, schemas: k => host.schemas(k), system: 's', maxOutputTokens: 64, now: () => new Date('2032-01-10T10:00:00Z') });
    expect((await runStep(db, run.runId, { model, tools: host, now: () => T + 100, workerId: 'w' })).outcome).toBe('stepped');
    const [row] = (await db.prepare('SELECT results FROM agent_run_steps WHERE run_id = ?1').bind(run.runId).all<{ results: string }>()).results;
    const results = JSON.parse(row.results) as Array<{ content: string; error?: boolean }>;
    expect(results[0].content).toContain('tool_forbidden_on_api_channel');
    expect(results[1].content).toContain('tool_not_allowlisted');
    expect(results[2].error).toBe(true);
    expect(JSON.parse(results[3].content)).not.toHaveProperty('body');
    expect(github.calls).toEqual(['pr:rfkevin/github-mcp#7']);
    expect(await db.prepare('SELECT COUNT(*) AS c FROM agent_run_effects WHERE run_id = ?1').bind(run.runId).first<{ c: number }>()).toEqual({ c: 0 });
  });
});

function fakeSlot() {
  const values = new Map<string, unknown>();
  const box = { alarm: null as number | null };
  const slot: ObjectSlot = {
    get: (async (key: string) => values.get(key)) as ObjectSlot['get'],
    put: (async (key: string, value: unknown) => { values.set(key, value); }) as ObjectSlot['put'],
    delete: async key => values.delete(key),
    getAlarm: async () => box.alarm,
    setAlarm: async at => { box.alarm = at; },
    deleteAlarm: async () => { box.alarm = null; },
  };
  return { slot, box };
}

async function quota(day: string, kind: string): Promise<number> {
  return (await db.prepare('SELECT used FROM agent_run_quota WHERE day = ?1 AND kind = ?2').bind(day, kind).first<{ used: number }>())?.used ?? 0;
}

function orchestratorDeps(slot: ObjectSlot, clock: { ms: number }, model: ModelClient, tools: ToolHost, gbLimit?: string, stepMs = 0): OrchestratorDeps {
  return {
    db, slot, ownsLease: () => true, workerId: () => 'w-' + crypto.randomUUID(),
    env: { AGENT_RUNS_ENABLED: 'true', AGENT_RUN_DAILY_GB_S: gbLimit },
    nowMs: () => clock.ms,
    engine: (_runId, stepDb) => ({ model: { complete: async input => { clock.ms += stepMs; return model.complete(input); } }, tools, now: () => Math.floor(clock.ms / 1000),
      ...(stepDb ? {} : {}) }),
  };
}

describe('CC-5 l7c-1 — quotas mesurés', () => {
  it('meteredDb additionne meta.rows_written des requêtes et des lots, sans changer les résultats', async () => {
    await ensureSchema(db);
    const metered = meteredDb(db);
    await metered.db.prepare("INSERT INTO agent_run_journal (at, kind, run_id, detail) VALUES (1, 'probe', 'm', 'a')").run();
    await metered.db.batch([
      metered.db.prepare("INSERT INTO agent_run_journal (at, kind, run_id, detail) VALUES (2, 'probe', 'm', 'b')"),
      metered.db.prepare("INSERT INTO agent_run_journal (at, kind, run_id, detail) VALUES (3, 'probe', 'm', 'c')"),
    ]);
    const read = await metered.db.prepare("SELECT COUNT(*) AS c FROM agent_run_journal WHERE run_id = 'm'").first<{ c: number }>();
    expect(read).toEqual({ c: 3 });
    expect(metered.rowsWritten()).toBeGreaterThanOrEqual(3);
  });

  it('lignes : réservation au pire cas puis réel mesuré + écritures de l’objet ; Go-s : durée mesurée, arrondie au supérieur', async () => {
    const at = T + 5 * 86_400;
    const run = await newRun(at, 'research');
    const clock = { ms: at * 1000 };
    const { slot, box } = fakeSlot();
    const model: ModelClient = { complete: async () => ({ output: { text: 'fin', tool_calls: [] }, usage: { tokens: 1, cost_cents: 0 } }) };
    const tools = createReadToolHost({ db, repository: null, github: null });
    expect(await objectWake(orchestratorDeps(slot, clock, model, tools, undefined, 10_000), run.runId, run.leaseKey)).toEqual({ accepted: true });
    box.alarm = null;
    const result = await objectAlarm(orchestratorDeps(slot, clock, model, tools, undefined, 10_000));
    expect(result).toMatchObject({ action: 'finished', outcome: 'completed' });
    const day = utcDay(at);
    const rows = await quota(day, 'rows_written');
    expect(rows).toBeGreaterThan(DO_ROWS_PER_ALARM);
    expect(rows).toBeLessThan(ROWS_PER_STEP);
    // 10 s × 0,128 Go = 1,28 Go-s → 2.
    expect(await quota(day, 'do_gb_s')).toBe(2);
  });

  it('Go-s épuisé : aucune étape, réservation de lignes rendue, alarme dans une heure, journalisé', async () => {
    const at = T + 6 * 86_400;
    const run = await newRun(at, 'research');
    const clock = { ms: at * 1000 };
    const { slot, box } = fakeSlot();
    let calls = 0;
    const model: ModelClient = { complete: async () => { calls += 1; return { output: { text: 'fin', tool_calls: [] }, usage: { tokens: 1, cost_cents: 0 } }; } };
    const tools = createReadToolHost({ db, repository: null, github: null });
    expect(await objectWake(orchestratorDeps(slot, clock, model, tools, String(GB_S_PER_STEP - 1)), run.runId, run.leaseKey)).toEqual({ accepted: true });
    box.alarm = null;
    const result = await objectAlarm(orchestratorDeps(slot, clock, model, tools, String(GB_S_PER_STEP - 1)));
    expect(result).toEqual({ action: 'quota_wait', next_at: clock.ms + QUOTA_RETRY_S * 1000 });
    expect(calls).toBe(0);
    expect(await quota(utcDay(at), 'rows_written')).toBe(0);
    expect((await db.prepare("SELECT detail FROM agent_run_journal WHERE run_id = ?1 AND kind = 'quota_exhausted'").bind(run.runId).first<{ detail: string }>())?.detail).toBe('do_gb_s');
    expect(await consumeQuota(db, 'do_gb_s', 14_000, 13_000, at)).toBe(false);
  });

  it('A1 — double réveil = deux requêtes comptées, une seule étape et aucun double effet', async () => {
    const at = T + 7 * 86_400;
    const run = await newRun(at, 'research');
    const clock = { ms: at * 1000 };
    const { slot, box } = fakeSlot();
    let calls = 0;
    const model: ModelClient = { complete: async () => { calls += 1; return { output: { text: 'fin', tool_calls: [] }, usage: { tokens: 1, cost_cents: 0 } }; } };
    const tools = createReadToolHost({ db, repository: null, github: null });
    const d = orchestratorDeps(slot, clock, model, tools);
    expect(await objectWake(d, run.runId, run.leaseKey)).toEqual({ accepted: true });
    expect(await objectWake(d, run.runId, run.leaseKey)).toEqual({ accepted: true });
    expect(await quota(utcDay(at), 'do_requests')).toBe(2);
    box.alarm = null;
    expect(await objectAlarm(d)).toMatchObject({ action: 'finished', outcome: 'completed' });
    expect(await objectAlarm(d)).toEqual({ action: 'none' });
    expect(calls).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS c FROM agent_run_steps WHERE run_id = ?1').bind(run.runId).first<{ c: number }>()).toEqual({ c: 1 });
  });
});

describe('CC-5 l7c-1 — câblage', () => {
  it('sans AGENT_RUN_MODEL ou sans binding AI : modèle simulé de 7b (aucun appel réel)', async () => {
    const simulated = engineFor({}, db)('r');
    expect((await simulated.model.complete({ messages: [], tools: [], task_kind: 'x' })).output.text).toContain('simulée');
    const noAi = engineFor({ AGENT_RUN_MODEL: MODEL_REF }, db)('r');
    expect(noAi.tools.list('research')).toEqual([]);
  });

  it('avec AGENT_RUN_MODEL et AI : modèle Workers AI, lecture store seule sans dépôt, consigne commune sans pouvoir d’écriture', async () => {
    const ai = fakeAi([openAi('fin')]);
    const deps = engineFor({ AGENT_RUN_MODEL: MODEL_REF, AI: ai, AGENT_RUN_REPOSITORY: 'pas un dépôt' }, db)('r');
    expect(deps.tools.list('research')).toEqual(['store_context', 'store_delta']);
    await deps.model.complete({ messages: [{ role: 'user', content: 'x' }], tools: deps.tools.list('research'), task_kind: 'research' });
    const sent = ai.calls[0].input as { messages: Array<{ role: string; content: string }> };
    expect(sent.messages[0].content).toBe(AGENT_RUN_SYSTEM);
    expect(AGENT_RUN_SYSTEM).toContain('lecture seule');
  });

  it('lectures GitHub injectées par la racine du Worker seulement, avec les trois identifiants de l’App', () => {
    expect(githubReadsFrom({})).toBeNull();
    expect(githubReadsFrom({ GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2' })).toBeNull();
    const reads = githubReadsFrom({ GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2', GITHUB_PRIVATE_KEY: 'test-only-not-a-key' });
    expect(Object.keys(reads ?? {}).sort()).toEqual(['getPullRequest', 'getTextFile', 'listCheckRuns']);
  });
});
