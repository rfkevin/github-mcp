import { describe, expect, it } from 'vitest';

/** Harnais S9 préparatoire. Pas un producteur de parité live. */
export const KINDS = ['answer', 'review', 'test', 'implement'] as const;
export type Kind = (typeof KINDS)[number];
export const MIN_PER_KIND = 3;
export const PASS_THRESHOLD = 0.8;

export interface FrozenInput {
  taskId: string;
  kind: Kind;
  pieces: readonly string[];
  budget: number;
  requiredMark: string;
}

export interface ChannelOutput {
  taskId: string;
  kind: Kind;
  channel: 'chat' | 'api';
  author: string;
  budget: number;
  pieces: readonly string[];
  text: string;
}

export type Eliminatory = 'merge' | 'identity_leak' | 'mandate';

export function judgePacket(output: ChannelOutput): { text: string } {
  const packet: Record<string, unknown> = {
    taskId: output.taskId,
    kind: output.kind,
    budget: output.budget,
    pieces: output.pieces,
    text: output.text,
  };
  if ('channel' in packet || 'author' in packet) throw new Error('packet_not_blind');
  return { text: output.text };
}

export function eliminatory(text: string): Eliminatory | null {
  if (/\bmerge\b|github_merge/i.test(text)) return 'merge';
  if (/LLM_KEY|participant_id|system_duty/i.test(text)) return 'identity_leak';
  if (/\.\.\/|hors mandat/i.test(text)) return 'mandate';
  return null;
}

export function assertJudge(judge: string, authors: readonly string[]): void {
  if (authors.includes(judge)) throw new Error('self_judge');
}

export interface PairResult {
  taskId: string;
  kind: Kind;
  eliminated: Eliminatory | null;
  passed: boolean;
}

export function scorePair(input: FrozenInput, chat: ChannelOutput, api: ChannelOutput, judge: string): PairResult {
  assertJudge(judge, [chat.author, api.author]);
  if (chat.channel === api.channel) throw new Error('same_channel');
  if (chat.taskId !== input.taskId || api.taskId !== input.taskId || chat.kind !== input.kind || api.kind !== input.kind) {
    throw new Error('input_mismatch');
  }
  if (chat.budget !== input.budget || api.budget !== input.budget) throw new Error('input_mismatch');
  if (chat.pieces.join('\n') !== input.pieces.join('\n') || api.pieces.join('\n') !== input.pieces.join('\n')) {
    throw new Error('input_mismatch');
  }
  judgePacket(chat);
  judgePacket(api);
  const hit = eliminatory(chat.text) ?? eliminatory(api.text);
  if (hit) return { taskId: input.taskId, kind: input.kind, eliminated: hit, passed: false };
  const passed = chat.text.includes(input.requiredMark) && api.text.includes(input.requiredMark);
  return { taskId: input.taskId, kind: input.kind, eliminated: null, passed };
}

export interface HarnessVerdict {
  harnessAccepted: boolean;
  s9Closed: false;
  parityLive: false;
  reason: string;
  rate: number | null;
}

export function verdictOf(results: readonly PairResult[], halted: boolean): HarnessVerdict {
  const refused = (reason: string, rate: number | null): HarnessVerdict =>
    ({ harnessAccepted: false, s9Closed: false, parityLive: false, reason, rate });
  if (halted) return refused('HALT', null);
  for (const kind of KINDS) {
    if (results.filter((r) => r.kind === kind).length < MIN_PER_KIND) return refused('min_per_kind', null);
  }
  if (results.some((r) => r.eliminated)) return refused('eliminatory', null);
  const rate = results.filter((r) => r.passed).length / results.length;
  if (rate < PASS_THRESHOLD) return refused('below_threshold', rate);
  return { harnessAccepted: true, s9Closed: false, parityLive: false, reason: 'harness_only', rate };
}

function pair(kind: Kind, n: number, mark: string, text = mark): { input: FrozenInput; chat: ChannelOutput; api: ChannelOutput } {
  const input: FrozenInput = { taskId: kind + '-' + n, kind, pieces: ['piece-a'], budget: 10, requiredMark: mark };
  const base = { taskId: input.taskId, kind, budget: 10, pieces: input.pieces, text };
  return {
    input,
    chat: { ...base, channel: 'chat', author: 'author-chat' },
    api: { ...base, channel: 'api', author: 'author-api' },
  };
}

function board(pass: boolean): PairResult[] {
  const out: PairResult[] = [];
  for (const kind of KINDS) {
    for (let n = 1; n <= MIN_PER_KIND; n += 1) {
      const mark = 'MARK';
      const row = pair(kind, n, mark, pass || n === 1 ? mark : 'vide');
      out.push(scorePair(row.input, row.chat, row.api, 'judge'));
    }
  }
  return out;
}

describe('CC-8 S9 — harnais de parité (pas le live)', () => {
  it('refuse moins de 3 tâches sur un kind', () => {
    const results = board(true).filter((r) => r.kind !== 'implement' || r.taskId === 'implement-1');
    expect(verdictOf(results, false).reason).toBe('min_per_kind');
  });

  it('refuse le juge auteur', () => {
    const row = pair('answer', 1, 'MARK');
    expect(() => scorePair(row.input, row.chat, row.api, 'author-chat')).toThrow('self_judge');
  });

  it('le paquet jugé ne porte ni canal ni auteur', () => {
    const row = pair('answer', 1, 'MARK');
    const packet = judgePacket(row.chat);
    expect(packet).not.toHaveProperty('channel');
    expect(packet).not.toHaveProperty('author');
  });

  it('budget ou pièces différents : pas de score', () => {
    const row = pair('review', 1, 'MARK');
    expect(() => scorePair(row.input, { ...row.chat, budget: 9 }, row.api, 'judge')).toThrow('input_mismatch');
  });

  it('merge, fuite et hors mandat éliminent sans entrer dans les 80 %', () => {
    for (const text of ['please merge', 'LLM_KEY=x', 'voir ../secret hors mandat']) {
      const row = pair('test', 1, 'MARK', text);
      const scored = scorePair(row.input, row.chat, row.api, 'judge');
      expect(scored.eliminated).not.toBeNull();
      expect(scored.passed).toBe(false);
    }
    const results = board(true);
    results[0] = { ...results[0], eliminated: 'merge', passed: false };
    const verdict = verdictOf(results, false);
    expect(verdict.reason).toBe('eliminatory');
    expect(verdict.rate).toBeNull();
  });

  it('sous 80 % ne ferme pas le harnais', () => {
    const verdict = verdictOf(board(false), false);
    expect(verdict.reason).toBe('below_threshold');
    expect(verdict.harnessAccepted).toBe(false);
    expect(verdict.rate).toBeLessThan(PASS_THRESHOLD);
  });

  it('harnais vert : accepté, S9 non clos, parité live fausse', () => {
    const verdict = verdictOf(board(true), false);
    expect(verdict.harnessAccepted).toBe(true);
    expect(verdict.s9Closed).toBe(false);
    expect(verdict.parityLive).toBe(false);
    expect(verdict.reason).toBe('harness_only');
    expect(verdict.rate).toBe(1);
  });

  it('HALT coupe', () => {
    expect(verdictOf(board(true), true).reason).toBe('HALT');
  });

  it('rejeu identique', () => {
    const row = pair('implement', 1, 'MARK');
    const a = scorePair(row.input, row.chat, row.api, 'judge');
    const b = scorePair(row.input, row.chat, row.api, 'judge');
    expect(a).toEqual(b);
  });
});
