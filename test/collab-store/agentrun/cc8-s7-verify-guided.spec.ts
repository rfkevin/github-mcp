import { describe, expect, it } from 'vitest';
import { createRun, runStep, ToolRefused, type AgentMessage, type ModelOutput, type ToolCall, type ToolHost }
  from '../../../src/collab-store/agentrun';
import { buildVerifyContext, formatVerifyContext, VERIFY_CONTEXT_MAX, verifyInstruction, verifyPair } from '../../../src/collab-store/agentrun/verify-guided';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { db, T } from './s7-guided-harness';

// CC8 S7 — vérification guidée : runs review/test avec contexte serveur (PR, CI, diff borné), compaction, outils libres.
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER = 'f'.repeat(40);
const prompt = (head = HEAD, base = BASE) => 'Tâche t0 du cycle c : une soumission attend votre test.\nCouple exact à vérifier : head ' + head + ', base ' + base + '.';
const READS = ['github_diff', 'github_check_runs', 'github_pull_request', 'github_read_file'];
const TOOLS = [...READS, 'store_verdict'];
const DIFF = { base: BASE, head: HEAD, status: 'ahead', total_commits: 2, files: [
  { filename: 'docs/x.md', status: 'modified', additions: 1, deletions: 0, patch: '+doc' },
  { filename: 'test/a.spec.ts', status: 'added', additions: 10, deletions: 0, patch: '+test' },
  { filename: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, patch: '+const a = 1;' },
] };
const CHECKS = [{ name: 'ci', status: 'completed', conclusion: 'success', head_sha: HEAD }, { name: 'old', conclusion: 'failure', head_sha: OTHER }];
const PR = { number: 285, state: 'open', draft: false, merged: false, head: { sha: HEAD }, base: { sha: BASE } };

function host(answers: Record<string, Array<unknown | (() => never)>>) {
  const calls: ToolCall[] = [];
  const contexts: unknown[] = [];
  const tools: ToolHost = {
    list: () => TOOLS,
    spec: (_kind, name) => TOOLS.includes(name) ? { name, effect: READS.includes(name) ? 'read' : 'write' } : null,
    async execute(call: ToolCall, ctx) {
      calls.push(call);
      contexts.push(ctx);
      const next = (answers[call.name] ?? []).shift();
      if (typeof next === 'function') return (next as () => never)();
      if (next === undefined) throw new ToolRefused('unexpected ' + call.name);
      return next;
    },
  };
  return { tools, calls, contexts, count: (name: string) => calls.filter(c => c.name === name).length };
}

function model(outputs: ModelOutput[]) {
  const seen: Array<{ messages: AgentMessage[]; tools: string[] }> = [];
  return { seen, client: { async complete(input: { messages: AgentMessage[]; tools: string[] }) {
    seen.push({ messages: input.messages, tools: input.tools });
    return { output: outputs[seen.length - 1] ?? { text: 'fin', tool_calls: [] }, usage: { tokens: 1_000, cost_cents: 0 } };
  } } };
}

const verdict: ModelOutput = { text: '', tool_calls: [{ id: 'v', name: 'store_verdict',
  args: { task: 't0', pr: 285, head: HEAD, base: BASE, state: 'PASS', review: 'ok' } }] };

async function verifyRun(kind: 'test' | 'review' | 'implement', text = prompt()) {
  await ensureSchema(db);
  const runId = 'cc8-verify-' + kind + '-' + crypto.randomUUID();
  const cycleId = 'cc8-verify-' + crypto.randomUUID();
  await createRun(db, { runId, cycleId, participantId: 'vibe', taskId: 't0', taskKind: kind, prompt: text,
    maxSteps: 6, maxTokens: 48_000, maxCostCents: 0, deadlineAt: T + 900, now: T });
  await db.prepare('INSERT INTO cycles (cycle_id) VALUES (?1) ON CONFLICT(cycle_id) DO NOTHING').bind(cycleId).run();
  await db.prepare([
    'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
    "VALUES (?1, 1, 'evidence.add', 'claude', '', 'owner', ?2, 0, ?3, '')",
  ].join(' ')).bind(cycleId, JSON.stringify({ task: 't0', state: 'SUBMITTED', head: HEAD, base: BASE, pr: 285 }), 'sub:' + runId).run();
  return runId;
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

const injected = (seen: { messages: AgentMessage[] }) => seen.messages.at(-1)!;

describe('Vérification guidée — contexte (pur)', () => {
  it('couple lu dans la consigne du planificateur ; absent → null', () => {
    expect(verifyPair(prompt())).toEqual({ head: HEAD, base: BASE });
    expect(verifyPair('Objet de la décision : renew.')).toBeNull();
  });

  it('PR, CI au head seulement, fichiers, extraits source d’abord, erreurs signalées', () => {
    const text = formatVerifyContext({ head: HEAD, base: BASE, pr: 285, prRead: PR, checks: CHECKS, diff: DIFF, errors: ['github_x (panne)'] });
    expect(text).toContain('PR #285 : open ; head de la PR = head du couple');
    expect(text).toContain('CI au head : ci=success.');
    expect(text).not.toContain('old=failure');
    expect(text).toContain('Diff : 3 fichier(s), +16 / -2, 2 commit(s).');
    expect(text.indexOf('### src/a.ts')).toBeLessThan(text.indexOf('### test/a.spec.ts'));
    expect(text.indexOf('### test/a.spec.ts')).toBeLessThan(text.indexOf('### docs/x.md'));
    expect(text).toContain('Lecture serveur impossible : github_x (panne)');
    const moved = formatVerifyContext({ head: HEAD, base: BASE, pr: 285, prRead: { ...PR, head: { sha: OTHER } }, checks: [], diff: null, errors: [] });
    expect(moved).toContain('≠ head du couple (' + OTHER + ')');
    expect(moved).toContain('CI au head : aucun contrôle publié.');
  });

  it('diff maximal (50 fichiers × 2 000 caractères) : contexte borné, omission signalée', () => {
    const files = Array.from({ length: 50 }, (_, i) => ({ filename: 'src/f' + i + '.ts', status: 'modified', additions: 1, deletions: 1, patch: 'x'.repeat(2_000) }));
    const text = formatVerifyContext({ head: HEAD, base: BASE, pr: 1, prRead: null, checks: [], diff: { files }, errors: [] });
    expect(text.length).toBeLessThanOrEqual(VERIFY_CONTEXT_MAX);
    expect(text).toContain('[… autres extraits omis : budget du contexte atteint]');
  });

  it('couverture (relecture GPT-6, V1) : complet seulement si toute la sortie de github_diff est dans le contexte', () => {
    const base = { head: HEAD, base: BASE, pr: 285, prRead: PR, checks: CHECKS, errors: [] };
    expect(buildVerifyContext({ ...base, diff: DIFF }).complete).toBe(true);
    expect(buildVerifyContext({ ...base, diff: null }).complete).toBe(false);
    const many = Array.from({ length: 41 }, (_, i) => ({ filename: 'src/f' + i + '.ts', status: 'modified', additions: 1, deletions: 0, patch: '+' }));
    expect(buildVerifyContext({ ...base, diff: { files: many } }).complete).toBe(false);
    const big = Array.from({ length: 10 }, (_, i) => ({ filename: 'src/f' + i + '.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x'.repeat(2_000) }));
    expect(buildVerifyContext({ ...base, diff: { files: big } }).complete).toBe(false);
    expect(verifyInstruction('test', 285, false)).toContain('avant un verdict PASS, lisez vous-même le diff avec github_diff');
    expect(verifyInstruction('review', 285, true)).toContain('sa lecture vaut preuve');
  });
});

describe('Vérification guidée — moteur (D1)', () => {
  it('test : le serveur lit diff, CI et PR UNE fois, injecte le contexte à chaque étape, outils libres ; verdict en un appel', async () => {
    const runId = await verifyRun('test');
    const m = model([verdict]);
    const h = host({ github_diff: [DIFF], github_check_runs: [CHECKS], github_pull_request: [PR], store_verdict: [{ status: 'applied' }] });
    const outcomes = await drive(runId, { model: m.client, tools: h.tools, now: () => T + 10, workerId: 'w1', guidedVerify: true });
    expect(outcomes.at(-1)).toBe('completed');
    expect(m.seen).toHaveLength(2);
    for (const seen of m.seen) {
      expect(injected(seen).role).toBe('user');
      expect(injected(seen).content).toContain('CONTEXTE DE VÉRIFICATION PRÉPARÉ PAR LE SERVEUR');
      expect(injected(seen).content).toContain('### src/a.ts');
      expect(injected(seen).content).toContain('store_verdict (task, pr 285, head et base exacts ci-dessus, state PASS ou FAIL');
      expect(seen.tools).toEqual(TOOLS); // liberté : tous les outils restent offerts
    }
    // Lectures serveur une seule fois (contexte relu dans D1 ensuite) ; arguments au couple exact.
    expect(h.count('github_diff')).toBe(1);
    expect(h.count('github_check_runs')).toBe(1);
    expect(h.count('github_pull_request')).toBe(1);
    expect(h.calls.find(c => c.name === 'github_diff')!.args).toEqual({ head: HEAD, base: BASE });
    expect(h.calls.find(c => c.name === 'github_pull_request')!.args).toEqual({ number: 285 });
    // Lectures serveur marquées prefetch (journal distinct, relecture GPT-6 V1) ; l'appel du modèle ne l'est jamais.
    expect(h.contexts.slice(0, 3)).toEqual([0, 1, 2].map(() => ({ run_id: runId, prefetch: true })));
    expect(h.contexts[3]).not.toHaveProperty('prefetch');
    expect(h.count('store_verdict')).toBe(1);
  });

  it('relecture : consigne AGREE / CHANGES_REQUESTED ; lecture en panne signalée, le run continue', async () => {
    const runId = await verifyRun('review');
    const m = model([]);
    const h = host({ github_diff: [() => { throw new Error('github_down'); }], github_check_runs: [CHECKS], github_pull_request: [PR] });
    await drive(runId, { model: m.client, tools: h.tools, now: () => T + 10, workerId: 'w1', guidedVerify: true });
    const text = injected(m.seen[0]).content;
    expect(text).toContain('state AGREE ou CHANGES_REQUESTED');
    expect(text).toContain('Lecture serveur impossible : github_diff (github_down)');
    expect(text).toContain('CI au head : ci=success.');
  });

  it('compaction : à la 3e étape, un gros résultat de lecture de la 1re étape n’est plus renvoyé au modèle', async () => {
    const runId = await verifyRun('test');
    const big = 'CONTENU-VOLUMINEUX-' + 'z'.repeat(6_000);
    const read = (id: string, path: string): ModelOutput => ({ text: '', tool_calls: [{ id, name: 'github_read_file', args: { path, ref: HEAD } }] });
    const m = model([read('r1', 'src/a.ts'), read('r2', 'src/b.ts'), verdict]);
    const h = host({ github_diff: [DIFF], github_check_runs: [CHECKS], github_pull_request: [PR],
      github_read_file: [{ path: 'src/a.ts', content: big }, { path: 'src/b.ts', content: 'petit' }], store_verdict: [{ status: 'applied' }] });
    await drive(runId, { model: m.client, tools: h.tools, now: () => T + 10, workerId: 'w1', guidedVerify: true, compactHistory: true });
    expect(JSON.stringify(m.seen[1].messages)).toContain('CONTENU-VOLUMINEUX'); // étape 2 : dernière étape intacte
    expect(JSON.stringify(m.seen[2].messages)).not.toContain('CONTENU-VOLUMINEUX'); // étape 3 : étape 1 compactée
    expect(injected(m.seen[2]).content).toContain('CONTEXTE DE VÉRIFICATION'); // le contexte serveur reste présent
  });

  it('hors périmètre : sans couple exact, sans activation ou pour implement → aucune lecture serveur, consigne inchangée', async () => {
    for (const [kind, text, enabled] of [['test', 'Objet de la décision : renew.', true], ['test', prompt(), false],
      ['implement', prompt(), true]] as Array<['test' | 'implement', string, boolean]>) {
      const runId = await verifyRun(kind, text);
      const m = model([{ text: 'fin', tool_calls: [] }]);
      const h = host({});
      await runStep(db, runId, { model: m.client, tools: h.tools, now: () => T + 10, workerId: 'w1', guidedVerify: enabled });
      expect(h.calls).toHaveLength(0);
      expect(JSON.stringify(m.seen[0].messages)).not.toContain('CONTEXTE DE VÉRIFICATION');
    }
  });
});
