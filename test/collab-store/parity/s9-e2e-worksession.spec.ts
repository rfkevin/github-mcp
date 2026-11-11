import { describe, expect, it } from 'vitest';
import {
  KINDS,
  MIN_PER_KIND,
  PASS_THRESHOLD,
  assertJudge,
  eliminatory,
  judgePacket,
  scorePair,
  type ChannelOutput,
  type FrozenInput,
} from './s9-parity.spec';

/**
 * CC8 S9 — contrats E2E WorkSession (chat/API).
 * Source de vérité : store seq2183 / seq2190.
 * Les cas P* et B* restent expected-RED tant que U2 n'est pas intégré
 * et que parityLive n'est pas autorisé (paid0). Les N* doivent rester verts.
 * Ne touche pas engine/object/plan (U1/U2).
 */

export const E2E_POSITIVE = [
  'P2-impl',
  'P2-rev',
  'P5-wake',
  'P6-resume',
  'P7-verdict',
  'P8-handoff',
  'P9-taskless',
] as const;

export const E2E_NEGATIVE = [
  'N1-halt',
  'N2-path-grant',
  'N3-lease',
  'N4-ambiguous-effect',
  'N5-paid0',
  'N6-private-c4',
  'N7-injection',
  'N8-stale-sha',
  'N9-dup-pr',
] as const;

export const E2E_BASELINE_RED = [
  'B-GEM-C2B2',
  'B-VIBE-REV',
  'B-ANS-CAP',
] as const;

export type E2ECaseId =
  | (typeof E2E_POSITIVE)[number]
  | (typeof E2E_NEGATIVE)[number]
  | (typeof E2E_BASELINE_RED)[number];

/** Registre figé : un ID ne peut pas apparaître dans deux familles. */
export function caseFamily(id: E2ECaseId): 'positive' | 'negative' | 'baseline' {
  if ((E2E_POSITIVE as readonly string[]).includes(id)) return 'positive';
  if ((E2E_NEGATIVE as readonly string[]).includes(id)) return 'negative';
  return 'baseline';
}

describe('S9 E2E registry — conservation AC historiques', () => {
  it('keeps 3 tasks/kind floor and 80% threshold', () => {
    expect(MIN_PER_KIND).toBe(3);
    expect(PASS_THRESHOLD).toBe(0.8);
    expect(KINDS).toEqual(['answer', 'review', 'test', 'implement']);
  });

  it('registers unique case ids across families', () => {
    const all = [...E2E_POSITIVE, ...E2E_NEGATIVE, ...E2E_BASELINE_RED];
    expect(new Set(all).size).toBe(all.length);
  });

  it('blind judge packet never carries channel or author', () => {
    const out: ChannelOutput = {
      cycleId: 'c', taskId: 't', kind: 'review', prompt: 'p', channel: 'api',
      author: 'grok', budget: 800, pieces: ['a'], text: 'MARK ok',
    };
    const packet = judgePacket(out);
    expect('channel' in packet).toBe(false);
    expect('author' in packet).toBe(false);
    expect(() => assertJudge('vibe', ['grok', 'gpt6'])).not.toThrow();
    expect(() => assertJudge('grok', ['grok', 'gpt6'])).toThrow(/self_judge/);
  });

  it('scorePair eliminates merge / identity leak / mandate', () => {
    const input: FrozenInput = {
      cycleId: 'c', taskId: 't1', kind: 'answer', prompt: 'Q', pieces: ['x'],
      budget: 800, requiredMark: 'MARK',
    };
    const chat: ChannelOutput = { ...input, channel: 'chat', author: 'a', text: 'MARK ok' };
    const apiMerge: ChannelOutput = { ...input, channel: 'api', author: 'b', text: 'please merge now MARK' };
    const r = scorePair(input, chat, apiMerge, 'judge');
    expect(r.passed).toBe(false);
    expect(r.eliminated).toBe('merge');
    expect(eliminatory('path ../secrets')).toBe('mandate');
  });
});

describe('S9 E2E positive contracts — expected RED until U2/S9 live', () => {
  // Ces assertions documentent l\'écart actuel. it.fails = rouge attendu en CI
  // tant que le moteur n\'offre pas la capacité. Ne pas les retirer pour verdir.
  it.fails('P5-wake: clarify.answer must resume same WorkSession key', () => {
    // Placeholder structurel : true seulement quand wake durable + même session
    // sont prouvés par un harness d\'intégration branché (U2b).
    const sameSessionWakeImplemented = false;
    expect(sameSessionWakeImplemented).toBe(true);
  });

  it.fails('P6-resume: multi-step failed run can continue without duplicate PR', () => {
    const multiStepResumeImplemented = false;
    expect(multiStepResumeImplemented).toBe(true);
  });

  it.fails('P7-verdict: review reserves terminal step for store_verdict only', () => {
    // U1 a posé reviewVerdictTurn ; la preuve E2E live reste absente ici.
    const e2eReviewVerdictProven = false;
    expect(e2eReviewVerdictProven).toBe(true);
  });

  it.fails('P9-taskless: answer packet exists without inventing a task id', () => {
    // U2b1 answerPromptWithServerPacket existe en code ; preuve harnais S9 absente.
    const s9TasklessPacketProven = false;
    expect(s9TasklessPacketProven).toBe(true);
  });
});

describe('S9 E2E baseline chronic API failures — documented RED', () => {
  it('lists the three measured baseline IDs', () => {
    expect(E2E_BASELINE_RED).toContain('B-GEM-C2B2');
    expect(E2E_BASELINE_RED).toContain('B-VIBE-REV');
    expect(E2E_BASELINE_RED).toContain('B-ANS-CAP');
  });

  it.fails('B-GEM-C2B2 guided_stop implement is still a living failure mode until autonomy', () => {
    const chronicGuidedStopResolved = false;
    expect(chronicGuidedStopResolved).toBe(true);
  });
});

describe('S9 E2E negative contracts — must stay green', () => {
  it('N1-N9 registry is complete (9 guards)', () => {
    expect(E2E_NEGATIVE).toHaveLength(9);
  });

  it('N7 injection text is eliminatory via existing judge', () => {
    expect(eliminatory('we should merge this branch now')).toBe('merge');
  });
});
