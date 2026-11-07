import { describe, expect, it } from 'vitest';
import { createRun } from '../../../src/collab-store/agentrun';
import { compareModels, type BenchRun } from '../../../src/collab-store/agentrun/bench-compare';
import { assessDossier, buildDossier, DOSSIER_MAX_CHARS } from '../../../src/collab-store/agentrun/task-dossier';
import type { ToolCall } from '../../../src/collab-store/agentrun/engine';
import { grants } from '../../../src/collab-store/agentrun/github-write/authorization';
import { assertionSignal, functionalTestCause, literalOnly, missionOf, stripComments, summarizeCommittedTests }
  from '../../../src/collab-store/agentrun/mission-quality';
import { publishRunProof } from '../../../src/collab-store/agentrun/run-proof';
import { guidedPrecheck, PRECHECK_HINTS, planGuidedS7 } from '../../../src/collab-store/agentrun/s7-guided';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { OWNER_PROOF, uniqueIds } from '../coordinator-helpers';
import historical from './fixtures/cc8-s7-bench/historical-runs.json';
import { BASE, BRANCH, C1, commitAs, db, drive, host, newRun, PASSED, PATH, SCOPE, scripted, T } from './s7-guided-harness';

// CC8 S7 durcissement — lot C (#283) R3 : qualité fonctionnelle par mission, au-delà de la CI verte.
const uniq = uniqueIds('hc');
const IMPORT = "import { describe, expect, it } from 'vitest';\nimport { planGuidedS7 } from '../../../src/collab-store/agentrun/s7-guided';\n";
const REAL = IMPORT + "describe('s7', () => { it('plan', () => { expect(planGuidedS7([], 'a-api-b', 't', 0).kind).toBe('server'); }); });\n";
const DEMO = "import { describe, expect, it } from 'vitest';\nimport { planGuidedS7 } from '../../../src/collab-store/agentrun/s7-guided';\n"
  + "describe('demo', () => { it('circuit', () => { expect(true).toBe(true); }); });\n";
const FUNCTIONAL = { kind: 'functional', acceptance: ['Le plan renvoie une étape serveur sans mandat.'] } as const;
const call = (path: string, content: string): ToolCall => ({ id: 'c', name: 'github_commit_files',
  args: { message: 'm', files: [{ path, content }] } });
const GRANT = { cycle: 'c', task: 't', participant: 'vibe', branch: BRANCH, paths: [PATH] };
const policy = (...items: object[]) => ({ tasks: JSON.stringify(items) });
/** Réponses GitHub d'un parcours vert : un seul commit, CI verte, PR ouverte. */
const greenQueues = () => ({ github_write_scope: [SCOPE], github_create_branch: [{ branch: BRANCH, sha: BASE }],
  github_commit_files: [{ branch: BRANCH, commit_sha: C1 }], github_run_checks: [{ targetSha: C1, runId: 9 }],
  github_check_result: [PASSED(C1)], github_open_pr: [{ branch: BRANCH, number: 300, head_sha: C1, draft: false }] });

describe('Lot C R3 — signal statique d’assertions', () => {
  it.each([
    ['expect(true).toBe(true)', true], ['expect(1).toBe(1)', true], ['expect(1 + 1).toBe(2)', true], ["expect('a').toBe('a')", true],
    ['expect([1, 2]).toEqual([1, 2])', true], ['expect(null).toBeNull()', true], ['expect(x).toBe(x)', true], ['expect(a.b).toEqual(a.b)', true],
    ['expect(plan([]).kind).toBe(\'server\')', false], ['expect(fn(1)).toBe(fn(1))', false], ['expect(result).toBe(1)', false],
    ['expect(await run()).not.toBeNull()', false], ['expect(x).toBe(y)', false],
  ])('%s — tautologique : %s', (line, tautological) => {
    const signal = assertionSignal(line + ';');
    expect(signal.expects).toBe(1);
    expect(signal.tautological).toBe(tautological ? 1 : 0);
    expect(signal.meaningful).toBe(tautological ? 0 : 1);
  });

  it('les commentaires et chaînes ne simulent ni assertion réelle ni import', () => {
    const cheat = "// expect(real()).toBe(1)\n/* import x from '../src/a' */\nit('x', () => { expect(true).toBe(true); });\n";
    expect(assertionSignal(cheat)).toMatchObject({ expects: 1, tautological: 1, meaningful: 0, imports_project: false });
    expect(stripComments("const u = 'http://x'; // c\nx")).toBe("const u = 'http://x'; \nx");
    expect(literalOnly('a + 1')).toBe(false);
    expect(literalOnly('"a" + 1')).toBe(true);
    expect(literalOnly('')).toBe(false);
  });

  it('import du dépôt et tests désactivés', () => {
    expect(assertionSignal(REAL)).toMatchObject({ imports_project: true, disabled: false, meaningful: 1 });
    expect(assertionSignal("import { a } from 'vitest';\nit.skip('x', () => { expect(f()).toBe(1); });")).toMatchObject({ disabled: true, imports_project: false });
    expect(assertionSignal("import { a } from '@/m';\nxit('x', () => {});")).toMatchObject({ disabled: true, imports_project: true });
    expect(assertionSignal("import { a } from 'src/m';\nit.skipIf(true)('x', () => {});").disabled).toBe(false);
  });

  it('causes typées d’une mission fonctionnelle, tests seulement, premier défaut rendu', () => {
    expect(functionalTestCause([{ path: PATH, content: REAL }])).toBeNull();
    expect(functionalTestCause([{ path: PATH, content: DEMO }])).toBe('test_tautological');
    expect(functionalTestCause([{ path: PATH, content: "import { it, expect } from 'vitest';\nit('x', () => { expect(f()).toBe(1); });" }])).toBe('test_no_project_import');
    expect(functionalTestCause([{ path: PATH, content: REAL + "it.todo('plus tard');\n" }])).toBe('test_disabled');
    // Un fichier source (même vide de test) ou une doc n'est pas examiné ici.
    expect(functionalTestCause([{ path: 'src/a.ts', content: 'export const a = 1;' }, { path: 'docs/a.md', content: '# a' }])).toBeNull();
    for (const cause of ['test_disabled', 'test_no_project_import', 'test_tautological']) expect(PRECHECK_HINTS[cause]).toMatch(/mission fonctionnelle/);
  });
});

  it('C1 : une assertion citée dans une chaîne ou template ne constitue pas un vrai test', () => {
    const fake = IMPORT + [
      'const x = "expect(fakeResult()).toBe(42)";',
      'const y = ' + String.fromCharCode(96) + 'expect(fake2()).toEqual(42)' + String.fromCharCode(96) + ';',
      "it('demo', () => { expect(true).toBe(true); });",
    ].join('\n');
    expect(assertionSignal(fake)).toMatchObject({ expects: 1, tautological: 1, meaningful: 0, imports_project: true });
    expect(functionalTestCause([{ path: PATH, content: fake }])).toBe('test_tautological');
    expect(assertionSignal(REAL)).toMatchObject({ expects: 1, meaningful: 1, imports_project: true });
  });

  it('C1 : les imports ou skip seulement cités ne sont pas du code', () => {
    const fake = "const imported = \"import x from '../src/a'\";\n"
      + "const skipped = \"it.skip('a', () => {})\";\n"
      + "it('a', () => { expect(fn()).toBe(1); });";
    expect(assertionSignal(fake)).toMatchObject({ imports_project: false, disabled: false, meaningful: 1 });
    expect(functionalTestCause([{ path: PATH, content: fake }])).toBe('test_no_project_import');
  });

  it('C1 : un expect sans matcher ne constitue pas une assertion fonctionnelle', () => {
    const fake = IMPORT + "it('a', () => { expect(fn()); expect(true).toBe(true); });";
    expect(assertionSignal(fake)).toMatchObject({ expects: 2, meaningful: 0, tautological: 2 });
  });

describe('Lot C R3 — prévalidation par mission', () => {
  it('pilote (ou mission absente) : le test de démonstration reste accepté, comme avant', () => {
    expect(guidedPrecheck(call(PATH, DEMO), [PATH])).toBeNull();
    expect(guidedPrecheck(call(PATH, DEMO), [PATH], missionOf({}))).toBeNull();
    expect(guidedPrecheck(call(PATH, DEMO), [PATH], missionOf({ mission: 'pilot' }))).toBeNull();
  });

  it('fonctionnelle : démonstration refusée, vrai test accepté, règles de base d’abord', () => {
    expect(guidedPrecheck(call(PATH, DEMO), [PATH], FUNCTIONAL)).toBe('test_tautological');
    expect(guidedPrecheck(call(PATH, REAL), [PATH], FUNCTIONAL)).toBeNull();
    expect(guidedPrecheck(call(PATH, "import { it, expect } from 'jest';\nit('x', () => { expect(true).toBe(true); });"), [PATH], FUNCTIONAL)).toBe('test_runner_incompatible');
    expect(guidedPrecheck(call('src/a.ts', 'export const a = 1;'), ['src/a.ts'], FUNCTIONAL)).toBeNull();
  });

  it('la consigne de contenu porte les critères d’acceptation d’une mission fonctionnelle seulement', () => {
    const entries = [{ tool: 'github_write_scope', value: SCOPE as Record<string, unknown>, failed: false },
      { tool: 'github_create_branch', value: { branch: BRANCH, sha: BASE }, failed: false }];
    const pilot = planGuidedS7(entries, BRANCH, 't', 2, missionOf(undefined));
    const functional = planGuidedS7(entries, BRANCH, 't', 2, missionOf({ mission: 'functional', acceptance: FUNCTIONAL.acceptance.slice() }));
    expect(pilot.kind === 'model' && pilot.instruction).not.toMatch(/MISSION FONCTIONNELLE/);
    expect(functional.kind === 'model' && functional.instruction).toMatch(/MISSION FONCTIONNELLE[\s\S]*1\. Le plan renvoie une étape serveur/);
    expect(functional.kind === 'model' && functional.fill.mission?.kind).toBe('functional');
  });
});

describe('Lot C R3 — moteur (D1)', () => {
  it('mission fonctionnelle : démonstration refusée AVANT tout effet GitHub, puis vrai test accepté', async () => {
    const { runId, grants } = await newRun('hc-functional');
    const h = host(greenQueues());
    const functional = [{ ...grants[0], mission: 'functional' as const, acceptance: ['Le plan est observable.'] }];
    const model = scripted([commitAs('github_commit_files', DEMO), commitAs('github_commit_files', REAL)]);
    const outcomes = await drive(runId, { model: model.client, tools: h.tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: functional, guidedS7: true });
    expect(outcomes.at(-1)).toBe('completed');
    expect(h.writes()).toEqual(['github_write_scope', 'github_create_branch', 'github_commit_files', 'github_run_checks', 'github_check_result', 'github_open_pr']);
    const { results } = await db.prepare("SELECT status, result FROM agent_run_effects WHERE run_id = ?1 AND tool = 'guided_precheck'")
      .bind(runId).all<{ status: string; result: string }>();
    expect(results.map(r => [r.status, JSON.parse(r.result)])).toEqual([['failed', { error: 'guided_precheck', cause: 'test_tautological' }]]);
    // La reformulation voit le critère d'acceptation et la cause du refus.
    const last = model.seen.at(-1)!.messages.at(-1)!.content;
    expect(last).toMatch(/Le plan est observable/);
    expect(last).toMatch(/test_tautological/);
  });

  it('même mission déclarée pilote : le test de démonstration passe au premier essai', async () => {
    const { runId, grants } = await newRun('hc-pilot');
    const h = host(greenQueues());
    const outcomes = await drive(runId, { model: scripted([commitAs('github_commit_files', DEMO)]).client, tools: h.tools, now: () => T + 100,
      workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
    expect(outcomes.at(-1)).toBe('completed');
    expect(h.writes().filter(name => name === 'github_commit_files')).toHaveLength(1);
  });
});

describe('Lot C R3 — mandat du propriétaire', () => {
  it('mandat historique inchangé ; fonctionnel exige 1 à 5 critères ; pilote n’en porte pas', () => {
    expect(grants(policy(GRANT))).toEqual([GRANT]);
    expect(grants(policy({ ...GRANT, mission: 'pilot' }))).toHaveLength(1);
    expect(grants(policy({ ...GRANT, mission: 'functional', acceptance: ['a', 'b'] }))[0]).toMatchObject({ mission: 'functional', acceptance: ['a', 'b'] });
    const invalid = [{ ...GRANT, mission: 'functional' }, { ...GRANT, mission: 'functional', acceptance: [] }, { ...GRANT, mission: 'functional', acceptance: ['  '] },
      { ...GRANT, mission: 'functional', acceptance: ['x'.repeat(301)] }, { ...GRANT, mission: 'functional', acceptance: Array(6).fill('x') },
      { ...GRANT, mission: 'functional', acceptance: [1] }, { ...GRANT, mission: 'pilot', acceptance: ['x'] }, { ...GRANT, mission: 'produit' },
      { ...GRANT, extra: true }, { ...GRANT, acceptance: ['x'] }];
    for (const bad of invalid) expect(() => grants(policy(bad)), JSON.stringify(bad)).toThrow('api_write_policy_invalid');
  });
});

describe('Lot C R3 — preuve serveur selon la mission', () => {
  const OPEN = { number: 300, state: 'open', merged: false, head: { sha: C1 }, base: { sha: 'e'.repeat(40) } };

  /** Run guidé jusqu'à completed/final avec le contenu commité donné, puis preuve sous le mandat donné. */
  async function proven(content: string, mission: Record<string, unknown>) {
    const tag = uniq('w');
    const [author, reviewer, tester] = ['ca', 'cr', 'ct'].map(p => p + '-' + tag);
    for (const pid of [author, reviewer, tester]) await registerParticipant(db, { participant_id: pid, display_label: pid, proof: OWNER_PROOF, op: uniq('reg') });
    const cycle = uniq('cyc');
    await insertCycleRow(db, cycle, 'P6');
    await insertPhaseDefinition(db, cycle, 'P6', []);
    await insertTaskRow(db, { taskId: 't0', cycle, owner: author, reviewer, tester });
    const runId = 'cc8-hc-' + crypto.randomUUID();
    await createRun(db, { runId, cycleId: cycle, participantId: author, taskId: 't0', taskKind: 'implement', prompt: 'Lot C.',
      maxSteps: 12, maxTokens: 48_000, maxCostCents: 0, deadlineAt: T + 2_700, now: T });
    const base = { cycle, participant: author, task: 't0', branch: BRANCH };
    const granted = [{ ...base, ...mission }];
    const h = host(greenQueues());
    // Sans mission fonctionnelle côté moteur : le contenu atteint GitHub ; la mission ne juge ici que la preuve.
    const outcomes = await drive(runId, { model: scripted([commitAs('github_commit_files', content)]).client, tools: h.tools, now: () => T + 100,
      workerId: 'w1', githubCompletionGrants: [base], guidedS7: true });
    expect(outcomes.at(-1)).toBe('completed');
    const out = await publishRunProof(db, runId, { tools: host({ github_pull_request: [OPEN] }).tools, githubCompletionGrants: granted, now: () => T + 200 });
    const { results } = await db.prepare("SELECT payload_json FROM events WHERE cycle_id = ?1 AND type = 'run.proof'").bind(cycle).all<{ payload_json: string }>();
    return { out, events: results.map(r => JSON.parse(r.payload_json) as Record<string, unknown>) };
  }

  it('pilote étiqueté : un test de démonstration est accepté comme preuve technique, scope inchangé', async () => {
    const { out, events } = await proven(DEMO, {});
    expect(out.status).toBe('published');
    expect(events[0]).toMatchObject({ scope: 'pilot_e2e_pass', verified_success: true });
    expect(events[0]).not.toHaveProperty('quality');
  });

  it('fonctionnelle : une réussite uniquement cosmétique est refusée, sans aucune preuve écrite', async () => {
    const { out, events } = await proven(DEMO, { mission: 'functional', acceptance: ['Le plan est observable.'] });
    expect(out).toEqual({ status: 'refused', reason: 'functional_assertions_missing' });
    expect(events).toHaveLength(0);
  });

  it('fonctionnelle : une vraie assertion donne une preuve qui exige la revue et résume le signal', async () => {
    const { out, events } = await proven(REAL, { mission: 'functional', acceptance: ['Le plan est observable.'] });
    expect(out.status).toBe('published');
    expect(events[0]).toMatchObject({ scope: 'e2e_pass_review_required', mission: 'functional', quality: { test_files: 1, meaningful: 1, tautological: 0 } });
  });

  it('résumé des tests commités : dernier contenu par fichier, refusés et remplacements ignorés', () => {
    const effect = (tool: string, status: string, content: string, result: string | null = JSON.stringify({ commit_sha: C1 })) =>
      ({ tool, status, args: JSON.stringify({ files: [{ path: PATH, content }] }), result });
    expect(summarizeCommittedTests([effect('github_commit_files', 'completed', DEMO), effect('github_commit_files', 'completed', REAL)]))
      .toEqual({ test_files: 1, meaningful: 1, tautological: 0 });
    expect(summarizeCommittedTests([effect('github_commit_files', 'completed', REAL), effect('github_commit_files', 'completed', DEMO)]))
      .toEqual({ test_files: 1, meaningful: 0, tautological: 1 });
    expect(summarizeCommittedTests([effect('github_commit_files', 'failed', REAL), effect('github_replace_text', 'completed', REAL),
      effect('github_commit_files', 'completed', REAL, 'pas du json'), { tool: 'github_commit_files', status: 'completed', args: '{', result: '{}' }]))
      .toEqual({ test_files: 0, meaningful: 0, tautological: 0 });
  });
});

describe('Lot C R6 — dossier de tâche autonome', () => {
  const FULL = 'Merci de donner un avis argumenté sur les six règles de durcissement : '.padEnd(200, 'règle ');
  it('un URL seul n’est pas un dossier : consigne anti-faux-accès ; un texte complet l’est', () => {
    const link = assessDossier('https://github.com/rfkevin/github-mcp/issues/280');
    expect(link).toMatchObject({ kind: 'reference_only', urls: ['https://github.com/rfkevin/github-mcp/issues/280'], text_chars: 0 });
    expect(link.notice).toMatch(/aucun accès externe/);
    expect(assessDossier('Peux-tu regarder ?')).toMatchObject({ kind: 'insufficient' });
    expect(assessDossier(FULL)).toMatchObject({ kind: 'self_contained', notice: null });
    expect(assessDossier(FULL + ' https://x.test/a')).toMatchObject({ kind: 'self_contained', urls: ['https://x.test/a'] });
  });

  it('dossier borné : faits vérifiés séparés du contenu non fiable, consigne en dernier', () => {
    const built = buildDossier({ question: 'https://x.test/a', verified: ['PR #286 : head eb5eef45'] });
    expect(built.text.indexOf('RÉFÉRENCES VÉRIFIÉES')).toBeLessThan(built.text.indexOf('CONTENU NON FIABLE'));
    expect(built.text.indexOf('CONTENU NON FIABLE')).toBeLessThan(built.text.indexOf('CONSIGNE :'));
    expect(built.text).toContain('- PR #286 : head eb5eef45');
    const huge = buildDossier({ question: FULL.repeat(100) });
    expect(huge.text.length).toBeLessThanOrEqual(DOSSIER_MAX_CHARS);
    expect(huge.truncated).toBe(true);
    expect(buildDossier({ question: FULL }).text).toContain('(aucune)');
  });
});

describe('Lot C R6 — comparaison équitable', () => {
  const run = (id: string, model: string, outcome: BenchRun['outcome'], task = 'T'): BenchRun => ({ run_id: id, task, model_served: model, fallback_used: false,
    scenario_sha: 'a'.repeat(64), functional_pass: outcome === 'completed',
    outcome, first_commit: null, ci_corrections: null, tool_errors: null, pr_opened: null, tokens: null, duration_s: null, cost_cents: 0, sha: null });
  const many = (model: string, outcomes: BenchRun['outcome'][]) => outcomes.map((o, i) => run(model + i, model, o));

  it('les relevés historiques (un essai par modèle, modèle servi inconnu) ne concluent rien', () => {
    const file = historical as { runs: BenchRun[] };
    expect(file.runs).toHaveLength(2);
    expect(file.runs.every(r => r.model_served === null && r.cost_cents === 0)).toBe(true);
    expect(compareModels(file.runs, 's7-guided-pilot')).toMatchObject({ conclusive: false, reason: expect.stringMatching(/un seul modèle/) });
  });

  it('C3 : trois copies du même run ne sont pas trois essais indépendants', () => {
    const a = run('same-A', 'modelA', 'completed');
    const b = run('same-B', 'modelB', 'failed');
    expect(compareModels([a, a, a, b, b, b], 'T')).toMatchObject({
      conclusive: false, reason: expect.stringMatching(/dupliqué/),
    });
  });

  it('C3 : protocole divergent ou résultat fonctionnel non établi empêche une conclusion', () => {
    const a = many('m1', ['completed', 'completed', 'failed']);
    const b = many('m2', ['failed', 'failed', 'completed']).map(r => ({ ...r, scenario_sha: 'b'.repeat(64) }));
    expect(compareModels([...a, ...b], 'T')).toMatchObject({
      conclusive: false, reason: expect.stringMatching(/appariés/),
    });
    expect(compareModels([...a, ...b.map(r => ({ ...r, scenario_sha: null }))], 'T').conclusive).toBe(false);
    expect(compareModels([...a, ...b.map(r => ({ ...r, scenario_sha: 'a'.repeat(64), functional_pass: null }))], 'T'))
      .toMatchObject({ conclusive: false, reason: expect.stringMatching(/fonctionnel/) });
  });

  it('pas de conclusion sous trois runs par modèle ni à égalité ; sinon conclusion sourcée', () => {
    expect(compareModels([run('a', 'm1', 'completed'), run('b', 'm2', 'failed')], 'T')).toMatchObject({ conclusive: false, reason: expect.stringMatching(/moins de 3 runs pour : m1, m2/) });
    expect(compareModels([...many('m1', ['completed', 'failed', 'completed']), ...many('m2', ['completed', 'failed', 'completed'])], 'T'))
      .toMatchObject({ conclusive: false, reason: 'taux de réussite égaux' });
    const verdict = compareModels([...many('m1', ['completed', 'completed', 'failed']), ...many('m2', ['failed', 'failed', 'completed']), run('autre', 'm1', 'completed', 'AUTRE')], 'T');
    expect(verdict).toMatchObject({ conclusive: true, best: 'm1', basis: ['m10', 'm11', 'm12', 'm20', 'm21', 'm22'] });
  });
});