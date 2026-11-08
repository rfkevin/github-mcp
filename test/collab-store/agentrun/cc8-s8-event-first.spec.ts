import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { storeCompletionVerified, createRun, runStep, runSummary, type EngineDeps, type ToolHost } from '../../../src/collab-store/agentrun/engine';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
let counter = 0;
type Kind = 'answer' | 'review' | 'test' | 'design';

async function fixture(kind: Kind, eventType: string, payload: Record<string, unknown>) {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  const id = ++counter, cycle_id = 's8-effect-' + Date.now() + '-' + id;
  const participant_id = 'gemini', task_id = 'proof-task', run_id = cycle_id + '-run';
  await db.prepare("INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P6', 1, 'open')")
    .bind(cycle_id).run();
  const key = 's8-proof-' + cycle_id;
  await db.prepare('INSERT INTO events (cycle_id, at, type, participant_id, payload_json, idempotency_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(cycle_id, 1990000001, eventType, participant_id, JSON.stringify(payload), key).run();
  const event = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number }>();
  const prompt = kind === 'answer' ? 'Question #1812 du cycle ' + cycle_id + ' adressée à votre participant.'
    : (kind === 'review' || kind === 'test')
      ? 'Couple exact à vérifier : head ' + HEAD + ', base ' + BASE + '.'
      : 'Tâche proof-task du cycle ' + cycle_id + ' : une contribution est attendue.';
  return { run: { run_id, cycle_id, participant_id, task_id, task_kind: kind, prompt }, seq: event!.seq };
}

async function writeEffect(runId: string, tool: string, args: Record<string, unknown>,
  receipt: Record<string, unknown>, status = 'completed') {
  await db.prepare('INSERT INTO agent_run_effects (effect_key, run_id, n, idx, tool, args, status, result, updated_at) VALUES (?1, ?2, 1, 0, ?3, ?4, ?5, ?6, 1990000001)')
    .bind(runId + ':' + tool, runId, tool, JSON.stringify(args), status, JSON.stringify(receipt)).run();
}

describe('CC8 S8 — preuve d effet métier D1', () => {
  it('answer sans store_answer n est jamais un succès même si le modèle écrit « terminé »', async () => {
    const f = await fixture('answer', 'clarify.answer', { ask_seq: 1812, answer: 'réponse' });
    expect(await storeCompletionVerified(db, f.run)).toBe(false);
    await writeEffect(f.run.run_id, 'store_answer', { ask_seq: 1812, answer: 'réponse' },
      { seq: f.seq, type: 'clarify.answer', status: 'applied' });
    expect(await storeCompletionVerified(db, f.run)).toBe(true);
    expect(await storeCompletionVerified(db, { ...f.run, prompt: 'Question #1813 du cycle absent adressée à votre participant.' })).toBe(false);
    expect(await storeCompletionVerified(db, { ...f.run, participant_id: 'vibe' })).toBe(false);
  });

  it('refuse mauvaise question, événement D1 absent et effet non terminé', async () => {
    const f = await fixture('answer', 'clarify.answer', { ask_seq: 1813, answer: 'autre' });
    await writeEffect(f.run.run_id, 'store_answer', { ask_seq: 1812 },
      { seq: f.seq, type: 'clarify.answer', status: 'applied' });
    expect(await storeCompletionVerified(db, f.run)).toBe(false);
    const missing = await fixture('answer', 'clarify.answer', { ask_seq: 1812 });
    await writeEffect(missing.run.run_id, 'store_answer', { ask_seq: 1812 },
      { seq: 999999999, type: 'clarify.answer', status: 'applied' });
    expect(await storeCompletionVerified(db, missing.run)).toBe(false);
  });

  for (const kind of ['review', 'test'] as const) {
    it(kind + ' exige l effet et la preuve du couple SHA exact', async () => {
      const f = await fixture(kind, 'evidence.add', { task: 'proof-task', head: HEAD, base: BASE,
        state: kind === 'review' ? 'AGREE' : 'PASS' });
      await writeEffect(f.run.run_id, 'store_verdict', { task: 'proof-task', head: HEAD, base: BASE, pr: 1,
        state: kind === 'review' ? 'AGREE' : 'PASS' }, { seq: f.seq, type: 'evidence.add', status: 'applied' });
      expect(await storeCompletionVerified(db, f.run)).toBe(true);
      expect(await storeCompletionVerified(db, { ...f.run,
        prompt: 'Couple exact à vérifier : head ' + BASE + ', base ' + HEAD + '.' })).toBe(false);
    });
  }

  it('design refuse effet échoué et accepte contribution réellement persistée', async () => {
    const f = await fixture('design', 'proposal.submit', { task: 'proof-task', content: 'p' });
    await writeEffect(f.run.run_id, 'store_contribute', { task: 'proof-task', content: 'p' },
      { seq: f.seq, type: 'proposal.submit', status: 'applied' }, 'failed');
    expect(await storeCompletionVerified(db, f.run)).toBe(false);
    const ok = await fixture('design', 'evidence.add', { task: 'proof-task', state: 'AMEND' });
    await writeEffect(ok.run.run_id, 'store_contribute', { task: 'proof-task', state: 'AMEND' },
      { seq: ok.seq, type: 'evidence.add', status: 'duplicate' });
    expect(await storeCompletionVerified(db, ok.run)).toBe(true);
  });

  it('runStep clôt immédiatement answer après store_answer persistant, sans tour modèle supplémentaire', async () => {
    const f = await fixture('answer', 'clarify.answer', { ask_seq: 1812, answer: 'preuve D1' });
    expect((await createRun(db, { runId: f.run.run_id, cycleId: f.run.cycle_id,
      participantId: f.run.participant_id, taskId: '', taskKind: 'answer', prompt: f.run.prompt,
      maxSteps: 3, maxTokens: 8_000, maxCostCents: 0, now: 1_990_000_000,
      deadlineAt: 1_990_001_000 })).created).toBe(true);
    const host: ToolHost = {
      spec: (_kind, name) => name === 'store_answer' ? { name, effect: 'write' } : null,
      list: () => ['store_answer'],
      execute: async () => ({ seq: f.seq, type: 'clarify.answer', status: 'applied' }),
    };
    let calls = 0;
    const deps: EngineDeps = {
      now: () => 1_990_000_001, workerId: 's8-effect-happy',
      model: { complete: async () => {
        calls += 1;
        return { output: { text: '', tool_calls: [{ id: 'reply-1', name: 'store_answer',
          args: { ask_seq: 1812, answer: 'preuve D1' } }] }, usage: { tokens: 25, cost_cents: 0 } };
      } },
      tools: host,
    };
    expect((await runStep(db, f.run.run_id, deps)).outcome).toBe('completed');
    expect((await runSummary(db, f.run.run_id))?.status).toBe('completed');
    expect(calls).toBe(1);
  });
});
