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
 * Store seq2183 / seq2190 ; corrections PR #315 (Vibe/GPT-6).
 *
 * Statuts par cas :
 * - NOT_RUN : dette explicite (it.fails) — pas une preuve E2E live
 * - STRUCT : assertion pure harnais (registre / juge) — pas une garde runtime
 * Ne touche pas engine/object/plan.
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

/** Preuve d'intégration branchée sur ce cas (false = NOT_RUN). */
export type IntegrationProof = {
  id: E2ECaseId;
  /** true seulement avec fixture runtime réelle (pas un booléen manuel). */
  proven: boolean;
  note: string;
};

export function caseFamily(id: E2ECaseId): 'positive' | 'negative' | 'baseline' {
  if ((E2E_POSITIVE as readonly string[]).includes(id)) return 'positive';
  if ((E2E_NEGATIVE as readonly string[]).includes(id)) return 'negative';
  return 'baseline';
}

/** Tout ID positif/baseline doit avoir une entrée de preuve (NOT_RUN jusqu'à branchement). */
export const POSITIVE_PROOFS: readonly IntegrationProof[] = [
  { id: 'P2-impl', proven: false, note: '≥5 steps + ≥2 outils autorisés sans filtre guided — NOT_RUN' },
  { id: 'P2-rev', proven: false, note: 'idem review-kind — NOT_RUN' },
  { id: 'P5-wake', proven: false, note: 'clarify.answer → même WorkSession — NOT_RUN (code U2b existe, pas de preuve S9)' },
  { id: 'P6-resume', proven: false, note: 'resume multi-étapes sans 2e PR — NOT_RUN' },
  { id: 'P7-verdict', proven: false, note: 'E2E store_verdict terminal — NOT_RUN (U1 code only)' },
  { id: 'P8-handoff', proven: false, note: 'chat→API→chat 0 dup effect — NOT_RUN' },
  { id: 'P9-taskless', proven: false, note: 'packet answer sans task inventée — NOT_RUN (U2b1 code only)' },
];

export const BASELINE_PROOFS: readonly IntegrationProof[] = [
  { id: 'B-GEM-C2B2', proven: false, note: 'guided_stop implement chronique — NOT_RUN jusqu\'autonomie' },
  { id: 'B-VIBE-REV', proven: false, note: 'review 6/6 sans store_verdict — U1 réserve code; preuve E2E NOT_RUN' },
  { id: 'B-ANS-CAP', proven: false, note: 'answer 13797>8000 — U1 preflight code; preuve E2E NOT_RUN' },
];

export const NEGATIVE_PROOFS: readonly IntegrationProof[] = [
  { id: 'N1-halt', proven: false, note: 'HALT bloque write — fixture runtime NOT_RUN' },
  { id: 'N2-path-grant', proven: false, note: 'path hors grant∩owned — NOT_RUN' },
  { id: 'N3-lease', proven: false, note: '2e session active refusée — NOT_RUN' },
  { id: 'N4-ambiguous-effect', proven: false, note: 'effet ambigu bloque write — NOT_RUN' },
  { id: 'N5-paid0', proven: false, note: 'paid>0 refusé si plafond 0 — NOT_RUN' },
  { id: 'N6-private-c4', proven: false, note: 'mémoire privée tiers absente packet — NOT_RUN' },
  { id: 'N7-injection', proven: false, note: 'injection fichier/salon ≠ autorisation merge — STRUCT juge seulement' },
  { id: 'N8-stale-sha', proven: false, note: 'expected_head stale refuse — NOT_RUN' },
  { id: 'N9-dup-pr', proven: false, note: '2e open_pr → 1 PR — NOT_RUN' },
];

function assertNotRun(proof: IntegrationProof): void {
  // it.fails + proven===false = dette explicite. Ne jamais forcer proven=true ici.
  expect(proof.proven, proof.id + ': ' + proof.note).toBe(true);
}

describe('S9 E2E registry — conservation AC historiques', () => {
  it('keeps 3 tasks/kind floor and 80% threshold', () => {
    expect(MIN_PER_KIND).toBe(3);
    expect(PASS_THRESHOLD).toBe(0.8);
    expect(KINDS).toEqual(['answer', 'review', 'test', 'implement']);
  });

  it('registers unique case ids and one proof row per id', () => {
    const all = [...E2E_POSITIVE, ...E2E_NEGATIVE, ...E2E_BASELINE_RED];
    expect(new Set(all).size).toBe(all.length);
    expect(POSITIVE_PROOFS.map(p => p.id).sort()).toEqual([...E2E_POSITIVE].sort());
    expect(BASELINE_PROOFS.map(p => p.id).sort()).toEqual([...E2E_BASELINE_RED].sort());
    expect(NEGATIVE_PROOFS.map(p => p.id).sort()).toEqual([...E2E_NEGATIVE].sort());
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

  it('scorePair eliminates merge / identity leak / mandate (STRUCT juge, pas garde outil)', () => {
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

describe('S9 E2E positive — NOT_RUN until integration proof', () => {
  for (const proof of POSITIVE_PROOFS) {
    it.fails(proof.id + ' [' + proof.note + ']', () => {
      assertNotRun(proof);
    });
  }
});

describe('S9 E2E baseline chronic API — NOT_RUN until measured green', () => {
  for (const proof of BASELINE_PROOFS) {
    it.fails(proof.id + ' [' + proof.note + ']', () => {
      assertNotRun(proof);
    });
  }
});

describe('S9 E2E negative — NOT_RUN runtime guards (sauf STRUCT juge N7 texte)', () => {
  it('N1-N9 registry length is 9', () => {
    expect(E2E_NEGATIVE).toHaveLength(9);
  });

  it('N7 STRUCT: eliminatory catches merge language in judged text only', () => {
    expect(eliminatory('we should merge this branch now')).toBe('merge');
  });

  for (const proof of NEGATIVE_PROOFS) {
    it.fails(proof.id + ' runtime [' + proof.note + ']', () => {
      assertNotRun(proof);
    });
  }
});
