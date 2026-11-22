import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createReadToolHost,
  createRun,
  runStep,
} from '../../../src/collab-store/agentrun';
import type { ToolCall } from '../../../src/collab-store/agentrun/engine';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { answerPublicationReminder, answerRecoveryInstruction } from '../../../src/collab-store/agentrun/history-policy';
import { insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

// CC8 S9 v2 — une fin purement textuelle d'une mission `answer` n'est PAS une publication.
// D1 réel + hôte store réel + modèle scripté (même amorçage que l7c2) : reprise UNIQUE
// orientée store_answer, échec explicite au second échec, aucune publication automatique.

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_970_000_000;
let n = 0;
const uniq = (label: string) => '0000-0ansrec-' + label + '-' + (++n) + '-' + Date.now().toString(36);

interface Scenario { cycle: string; askSeq: number }

/** Cycle ouvert, tâche, question réelle adressée à p-resp (chemin l7c2 éprouvé). */
async function seedAnswerScenario(label: string): Promise<Scenario> {
  await ensureSchema(db);
  const cycle = uniq(label);
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: 'l7', cycle, owner: 'p-own-' + n, reviewer: 'p-rev-' + n, tester: 'p-tst-' + n });
  await insertEventRow(db, { cycle, type: 'clarify.ask', participant: 'p-ask', role: '',
    payload: { question: 'Quel SHA ?', to: 'p-resp' }, key: cycle + ':ask:1', expectedRev: 1 });
  const askSeq = (await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1')
    .bind(cycle + ':ask:1').first<{ seq: number }>())!.seq;
  return { cycle, askSeq };
}

/** Mission `answer` réelle : le prompt du planificateur lie la mission au clarify.ask exact. */
async function newAnswerRun(scenario: Scenario, maxSteps = -1) {
  const runId = 'ansrec-run-' + (++n) + '-' + Date.now().toString(36);
  const prompt = `Question #${scenario.askSeq} du cycle ${scenario.cycle}.`;
  const created = await createRun(db, { runId, cycleId: scenario.cycle, participantId: 'p-resp', taskId: 'l7',
    taskKind: 'answer', prompt, maxSteps, maxTokens: 1_000_000, maxCostCents: 0, deadlineAt: T + 86_400, now: T });
  expect(created.created).toBe(true);
  return runId;
}

function scripted(outputs: Array<{ text: string; tool_calls: ToolCall[] }>) {
  const seen: Array<{ messages: Array<{ role: string; content: string }>; tools: string[] }> = [];
  let i = 0;
  const client = { async complete(input: { messages: Array<{ role: string; content: string }>; tools: string[] }) {
    seen.push({ messages: input.messages, tools: input.tools });
    return { output: outputs[i++] ?? { text: 'fin', tool_calls: [] as ToolCall[] }, usage: { tokens: 10, cost_cents: 0 } };
  } };
  return { client, seen };
}

async function drive(runId: string, deps: Parameters<typeof runStep>[2], max = 8) {
  const outcomes: string[] = [];
  for (let i = 0; i < max; i++) {
    const { outcome } = await runStep(db, runId, deps);
    outcomes.push(outcome);
    if (outcome !== 'stepped') break;
  }
  return outcomes;
}

const rowOf = async (runId: string) => (await db.prepare('SELECT status, stop_reason, steps_done FROM agent_runs WHERE run_id = ?1')
  .bind(runId).first<{ status: string; stop_reason: string; steps_done: number }>())!;

async function answersOf(cycle: string) {
  return (await db.prepare("SELECT seq, participant_id, role, payload_json FROM events WHERE cycle_id = ?1 AND type = 'clarify.answer' ORDER BY seq")
    .bind(cycle).all<{ seq: number; participant_id: string; role: string; payload_json: string }>()).results;
}

const storeHost = () => createReadToolHost({ db, repository: null, github: null, storeWrites: true });
const readOnlyHost = () => createReadToolHost({ db, repository: null, github: null });

describe('CC8 S9 v2 — instruction de reprise pure (history-policy)', () => {
  const PROMPT = 'Question #3124 du cycle c.';

  it('cible store_answer seul, avec ask_seq, uniquement pour answer en tour de reprise', () => {
    const text = answerRecoveryInstruction('answer', PROMPT, ['store_context', 'store_answer'], true);
    expect(text).toContain('store_answer({ask_seq:3124');
    expect(text).toContain('UNIQUE tour correctif');
    expect(answerRecoveryInstruction('answer', PROMPT, ['store_context'], true)).toBeNull();
    expect(answerRecoveryInstruction('review', PROMPT, ['store_answer'], true)).toBeNull();
    expect(answerRecoveryInstruction('answer', PROMPT, ['store_answer'], false)).toBeNull();
  });

  it('sans question analysable : instruction générique, ask_seq numérique jamais fabriqué', () => {
    const text = answerRecoveryInstruction('answer', 'prompt sans entête', ['store_answer'], true);
    expect(text).toContain('store_answer');
    expect(text).not.toMatch(/ask_seq:\d/);
    expect(answerPublicationReminder('answer', 'prompt sans entête', ['store_answer'])).toBeNull();
  });

  it('rappel initial inchangé (comportement établi)', () => {
    expect(answerPublicationReminder('answer', PROMPT, ['store_answer'])).toContain('store_answer({ask_seq:3124');
    expect(answerPublicationReminder('review', PROMPT, ['store_verdict'])).toBeNull();
  });
});

describe('CC8 S9 v2 — reprise answer dans le moteur (D1 réel)', () => {
  it('fin textuelle unique : run maintenu, UN tour correctif store_answer seul, publication vérifiée D1', async () => {
    const s = await seedAnswerScenario('one-shot');
    const runId = await newAnswerRun(s);
    const model = scripted([
      { text: 'analyse sans outil', tool_calls: [] },
      { text: '', tool_calls: [{ id: 'a', name: 'store_answer', args: { ask_seq: s.askSeq, answer: 'Le SHA est bc58d886.' } }] },
    ]);
    const outcomes = await drive(runId, { model: model.client, tools: storeHost(), now: () => T, workerId: 'ansrec-1' });
    expect(outcomes).toEqual(['stepped', 'completed']);
    const run = await rowOf(runId);
    expect(run.status).toBe('completed');
    expect(model.seen).toHaveLength(2);
    // L'unique tour correctif n'offre QUE store_answer, avec le rappel ask_seq.
    expect(model.seen[1].tools).toEqual(['store_answer']);
    expect(model.seen[1].messages.at(-1)!.content).toContain('UNIQUE tour correctif');
    expect(model.seen[1].messages.at(-1)!.content).toContain('ask_seq:' + s.askSeq);
    const answers = await answersOf(s.cycle);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ participant_id: 'p-resp', role: 'api-agent' });
    expect(JSON.parse(answers[0].payload_json)).toEqual({ ask_seq: s.askSeq, answer: 'Le SHA est bc58d886.' });
  });

  it('seconde fin textuelle : échec explicite, une seule relance, aucune boucle', async () => {
    const s = await seedAnswerScenario('double-fail');
    const runId = await newAnswerRun(s);
    const model = scripted([
      { text: 'toujours rien', tool_calls: [] },
      { text: 'encore rien', tool_calls: [] },
    ]);
    const outcomes = await drive(runId, { model: model.client, tools: storeHost(), now: () => T, workerId: 'ansrec-2' });
    const run = await rowOf(runId);
    expect(run.status).toBe('failed');
    expect(run.stop_reason).toBe('incomplete_final:store_effect_missing');
    expect(outcomes).toEqual(['stepped', 'failed']);
    expect(model.seen).toHaveLength(2); // pas de troisième appel modèle
    expect(await answersOf(s.cycle)).toHaveLength(0);
  });

  it('tentative refusée au tour correctif : aucune seconde relance (ledger D1)', async () => {
    const s = await seedAnswerScenario('refused');
    const runId = await newAnswerRun(s);
    const model = scripted([
      { text: 'analyse sans outil', tool_calls: [] },
      { text: '', tool_calls: [{ id: 'a', name: 'store_answer', args: { ask_seq: s.askSeq + 5, answer: 'mauvaise question' } }] },
      { text: '(texte seul)', tool_calls: [] },
    ]);
    const outcomes = await drive(runId, { model: model.client, tools: storeHost(), now: () => T, workerId: 'ansrec-3' });
    const run = await rowOf(runId);
    expect(run.status).toBe('failed');
    expect(run.stop_reason).toBe('incomplete_final:store_effect_missing');
    expect(outcomes).toEqual(['stepped', 'stepped', 'failed']);
    expect(model.seen).toHaveLength(3); // reprise unique consommée, puis échec définitif
    // Journal append-only : une clarify.answer sur un ask_seq erroné peut être enregistrée
    // (pas de FK) ; la vraie propriété est qu'AUCUNE réponse valide ne cible la vraie question.
    const misdirected = await answersOf(s.cycle);
    expect(misdirected.every(a => JSON.parse(a.payload_json).ask_seq !== s.askSeq)).toBe(true);
  });

  it('sans store_answer disponible : échec immédiat inchangé (fail-closed)', async () => {
    const s = await seedAnswerScenario('no-tool');
    const runId = await newAnswerRun(s);
    const model = scripted([{ text: 'texte seul', tool_calls: [] }]);
    const outcomes = await drive(runId, { model: model.client, tools: readOnlyHost(), now: () => T, workerId: 'ansrec-4' });
    const run = await rowOf(runId);
    expect(run.status).toBe('failed');
    expect(run.stop_reason).toBe('incomplete_final:store_effect_missing');
    expect(outcomes).toEqual(['failed']);
    expect(model.seen).toHaveLength(1);
  });

  it('mission au dernier tour autorisé : pas de relance, échec immédiat', async () => {
    const s = await seedAnswerScenario('last-turn');
    const runId = await newAnswerRun(s, 1);
    const model = scripted([{ text: 'texte seul', tool_calls: [] }]);
    const outcomes = await drive(runId, { model: model.client, tools: storeHost(), now: () => T, workerId: 'ansrec-5' });
    const run = await rowOf(runId);
    expect(run.status).toBe('failed');
    expect(outcomes).toEqual(['failed']);
    expect(model.seen).toHaveLength(1);
  });

  it('review inchangé : une fin textuelle reste terminale, sans tour correctif answer', async () => {
    const s = await seedAnswerScenario('review-unchanged');
    const runId = 'ansrec-run-' + (++n) + '-' + Date.now().toString(36);
    const created = await createRun(db, { runId, cycleId: s.cycle, participantId: 'p-resp', taskId: 'l7',
      taskKind: 'review', prompt: 'Revue.', maxSteps: -1, maxTokens: 1_000_000, maxCostCents: 0, deadlineAt: T + 86_400, now: T });
    expect(created.created).toBe(true);
    const model = scripted([{ text: 'revue en texte', tool_calls: [] }]);
    const outcomes = await drive(runId, { model: model.client, tools: storeHost(), now: () => T, workerId: 'ansrec-6' });
    const run = await rowOf(runId);
    expect(run.status).toBe('failed');
    expect(outcomes).toEqual(['failed']);
    expect(model.seen).toHaveLength(1);
  });
});


describe('CC8 S9 v2 — non-régression : une mission answer normale à plusieurs étapes n\'est pas mise en reprise', () => {
  it('lectures puis réponse : aucune instruction de reprise, outils de lecture encore offerts, run complété', async () => {
    const s = await seedAnswerScenario('multi-step');
    const runId = await newAnswerRun(s);
    const model = scripted([
      { text: '', tool_calls: [{ id: 'r', name: 'store_context', args: {} }] },
      { text: '', tool_calls: [{ id: 'a', name: 'store_answer', args: { ask_seq: s.askSeq, answer: 'Le SHA est bc58d886.' } }] },
    ]);
    const outcomes = await drive(runId, { model: model.client, tools: storeHost(), now: () => T + 10, workerId: 'multi' });
    expect(outcomes.at(-1)).toBe('completed');
    expect(model.seen).toHaveLength(2);
    // Étape 2 (n = 1) : le tour précédent avait un appel d'outil, ce n'est donc PAS un tour correctif.
    const second = model.seen[1];
    expect(JSON.stringify(second.messages)).not.toContain('Reprise PUBLICATION');
    expect(second.tools).toEqual(expect.arrayContaining(['store_context', 'store_delta', 'store_answer']));
    expect(second.tools.length).toBeGreaterThan(1);
    expect(await answersOf(s.cycle)).toHaveLength(1);
  });
});
