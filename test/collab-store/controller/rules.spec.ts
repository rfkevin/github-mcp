import { describe, expect, it } from 'vitest';
import { nextActors, taskEvidence, parseDependencies, type ControllerSnapshot, type TaskFacts } from '../../../src/collab-store/controller';

// CC-5 L3 — règles pures du contrôleur : déterministes, fail-closed, D12 au head/base exacts.
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const HEAD2 = 'c'.repeat(40);

function task(overrides: Partial<TaskFacts> = {}): TaskFacts {
  return { task_id: 't1', status: 'accepted', owner: 'vibe', reviewer: 'grok', tester: 'claude', dependencies: [],
    submission: null, verdicts: [], ...overrides };
}

function snapshot(tasks: TaskFacts[], overrides: Partial<ControllerSnapshot> = {}): ControllerSnapshot {
  return { cycle_id: 'c', revision: 7, phase: 'P6', halted: false, auto_advance: 'none', outputs_satisfied: false, tasks, ...overrides };
}

const submitted = { head: HEAD, base: BASE, seq: 10 };

describe('CC-5 L3 — nextActors', () => {
  it('HALT : aucune décision, mode halted', () => {
    expect(nextActors(snapshot([task()], { halted: true }))).toEqual({ mode: 'halted', decisions: [] });
  });

  it('tâche ouverte sans soumission → réveil de l\'auteur', () => {
    const { decisions } = nextActors(snapshot([task()]));
    expect(decisions).toMatchObject([{ kind: 'wake', actor: 'vibe', action: 'implement', rule: 'no-submission' }]);
  });

  it('soumission sans verdict → relecteur et testeur réveillés', () => {
    const { decisions } = nextActors(snapshot([task({ submission: submitted })]));
    expect(decisions.map(d => [d.actor, d.action])).toEqual([['claude', 'test'], ['grok', 'review']]);
  });

  it('deux verdicts positifs au head/base exacts → merge_ready pour Kevin', () => {
    const { decisions } = nextActors(snapshot([task({ submission: submitted, verdicts: [
      { participant: 'grok', verdict: 'positive', head: HEAD, base: BASE, seq: 11 },
      { participant: 'claude', verdict: 'positive', head: HEAD, base: BASE, seq: 12 },
    ] })]));
    expect(decisions).toMatchObject([{ kind: 'merge_ready', actor: 'owner', subject: HEAD + '..' + BASE }]);
  });

  it('verdict positif sur un autre head → ne compte pas, renouvellement demandé', () => {
    const { decisions } = nextActors(snapshot([task({ submission: { head: HEAD2, base: BASE, seq: 20 }, verdicts: [
      { participant: 'grok', verdict: 'positive', head: HEAD, base: BASE, seq: 11 },
      { participant: 'claude', verdict: 'positive', head: HEAD, base: BASE, seq: 12 },
    ] })]));
    expect(decisions.every(d => d.kind === 'wake' && d.action === 'renew_verdict')).toBe(true);
    expect(decisions.some(d => d.kind === 'merge_ready')).toBe(false);
  });

  it('verdict sans SHA → jamais compté, redépôt demandé', () => {
    const { decisions } = nextActors(snapshot([task({ submission: submitted, verdicts: [
      { participant: 'grok', verdict: 'positive', head: null, base: null, seq: 11 },
      { participant: 'claude', verdict: 'positive', head: HEAD, base: BASE, seq: 12 },
    ] })]));
    expect(decisions).toMatchObject([{ actor: 'grok', action: 'renew_verdict', rule: 'verdict-without-sha' }]);
  });

  it('verdict négatif au head courant → auteur réveillé pour corriger', () => {
    const { decisions } = nextActors(snapshot([task({ submission: submitted, verdicts: [
      { participant: 'grok', verdict: 'negative', head: HEAD, base: BASE, seq: 11 },
    ] })]));
    expect(decisions).toMatchObject([{ actor: 'vibe', action: 'address_feedback' }]);
  });

  it('un tiers hors rôles ne peut pas débloquer une fusion', () => {
    const { decisions } = nextActors(snapshot([task({ submission: submitted, verdicts: [
      { participant: 'grok', verdict: 'positive', head: HEAD, base: BASE, seq: 11 },
      { participant: 'intrus', verdict: 'positive', head: HEAD, base: BASE, seq: 12 },
    ] })]));
    expect(decisions.some(d => d.kind === 'merge_ready')).toBe(false);
  });

  it('tâche bloquée : unblock seulement quand toutes les dépendances sont terminées', () => {
    const blocked = task({ task_id: 'l1', status: 'blocked', dependencies: ['l0'] });
    expect(nextActors(snapshot([blocked, task({ task_id: 'l0', status: 'in_progress' })])).decisions
      .some(d => d.kind === 'unblock')).toBe(false);
    expect(nextActors(snapshot([blocked, task({ task_id: 'l0', status: 'done' })])).decisions)
      .toMatchObject([{ kind: 'unblock', actor: 'coordinator', task_id: 'l1' }]);
  });

  it('avance de phase seulement avec policy et sorties satisfaites', () => {
    expect(nextActors(snapshot([], { phase: 'P1', auto_advance: 'p1', outputs_satisfied: true })).decisions)
      .toMatchObject([{ kind: 'advance_phase', subject: 'P1->P2' }]);
    expect(nextActors(snapshot([], { phase: 'P1', auto_advance: 'none', outputs_satisfied: true })).decisions).toEqual([]);
    expect(nextActors(snapshot([], { phase: 'P6', auto_advance: 'p6', outputs_satisfied: true })).decisions).toEqual([]);
  });

  it('déterministe : même instantané, mêmes décisions dans le même ordre', () => {
    const tasks = [task({ task_id: 'b', submission: submitted }), task({ task_id: 'a' })];
    expect(nextActors(snapshot(tasks))).toEqual(nextActors(snapshot([...tasks].reverse())));
  });
});

describe('CC-5 L3 — faits extraits des événements', () => {
  const roles = { owner: 'vibe', reviewer: 'grok', tester: 'claude' };
  const payload = (value: unknown) => JSON.stringify(value);

  it('soumission de l\'auteur : PR + head + base (formes libres des agents)', () => {
    const facts = taskEvidence('l0', roles, [{ seq: 5, participant: 'vibe', evidence_ref: 'https://github.com/o/r/pull/161',
      payload_json: payload({ task: 'l0', state: 'done', review: 'head ' + HEAD + ', base mcp/105856986/cc3-integration @ ' + BASE }) }]);
    expect(facts.submission).toEqual({ head: HEAD, base: BASE, seq: 5 });
  });

  it('verdicts : champs structurés prioritaires, état AGREE/AMEND reconnu, autres tâches ignorées', () => {
    const facts = taskEvidence('l0', roles, [
      { seq: 6, participant: 'grok', evidence_ref: '', payload_json: payload({ task: 'l0', state: 'AGREE', head: HEAD, base: BASE }) },
      { seq: 7, participant: 'claude', evidence_ref: '', payload_json: payload({ task: 'l0', state: 'AMEND — x', source: 'head ' + HEAD + ' base ' + BASE }) },
      { seq: 8, participant: 'grok', evidence_ref: '', payload_json: payload({ task: 'autre', state: 'AGREE' }) },
      { seq: 9, participant: 'claude', evidence_ref: '', payload_json: '{pas du json' },
    ]);
    expect(facts.verdicts).toEqual([
      { participant: 'grok', verdict: 'positive', head: HEAD, base: BASE, seq: 6 },
      { participant: 'claude', verdict: 'negative', head: HEAD, base: BASE, seq: 7 },
    ]);
  });

  it('forme structurée {task_id, pr:{url, head_sha, base_sha}} reconnue (format observé sur L1)', () => {
    const facts = taskEvidence('l1', roles, [{ seq: 4, participant: 'vibe', evidence_ref: '',
      payload_json: payload({ task_id: 'l1', verdict: 'ready_for_review',
        pr: { url: 'https://github.com/o/r/pull/163', head_sha: HEAD, base_sha: BASE } }) }]);
    expect(facts.submission).toEqual({ head: HEAD, base: BASE, seq: 4 });
  });

  it('forme {pr: <numéro>, head, base} reconnue (format observé seq 305) ; numéro invalide ignoré', () => {
    const event = (pr: unknown) => ({ seq: 3, participant: 'vibe', evidence_ref: '',
      payload_json: payload({ task: 'l1', pr, head: HEAD, base: BASE }) });
    expect(taskEvidence('l1', roles, [event(163)]).submission).toEqual({ head: HEAD, base: BASE, seq: 3 });
    expect(taskEvidence('l1', roles, [event(0)]).submission).toBeNull();
    expect(taskEvidence('l1', roles, [event(1.5)]).submission).toBeNull();
  });

  it('une soumission sans PR ou sans base n\'existe pas', () => {
    expect(taskEvidence('l0', roles, [{ seq: 1, participant: 'vibe', evidence_ref: '',
      payload_json: payload({ task: 'l0', review: 'head ' + HEAD + ' base ' + BASE }) }]).submission).toBeNull();
    expect(taskEvidence('l0', roles, [{ seq: 1, participant: 'vibe', evidence_ref: 'https://x/pull/1',
      payload_json: payload({ task: 'l0', review: 'head ' + HEAD }) }]).submission).toBeNull();
  });

  it('dépendances CC-STATE-1', () => {
    expect(parseDependencies('none')).toEqual([]);
    expect(parseDependencies(' l0, l1 ')).toEqual(['l0', 'l1']);
  });
});
