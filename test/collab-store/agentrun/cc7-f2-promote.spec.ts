import { describe, expect, it } from 'vitest';
import {
  CANARY_MIN_CALLS,
  canaryReadyForAuto,
  decidePromotion,
  priceNotHigher,
  promoteAutoEnabled,
  type CanaryResult,
  type PromoteInput,
  type PromoteRate,
} from '../../../src/collab-store/agentrun/promote';
import { GEMINI_PROTOCOL } from '../../../src/collab-store/agentrun/gemini-model';
import { geminiThinkingLevel } from '../../../src/collab-store/executors/gemini';

// CC-7 F2 — promotion épinglée, prix, sonde, canary P3 C2 ; garde thinkingLevel (réserve G0).
const rate = (input_per_m: number, output_per_m: number, other_per_m?: number): PromoteRate =>
  ({ input_per_m, output_per_m, ...(other_per_m !== undefined ? { other_per_m } : {}) });

const fullCanary = (over: Partial<CanaryResult> = {}): CanaryResult => ({
  calls: 20,
  failures: 0,
  cost_ratio: 0.95,
  identity_leak: false,
  critical_error: false,
  calls_by_kind: { answer: 5, review: 5, test: 5, implement: 5 },
  ...over,
});

function base(over: Partial<PromoteInput> = {}): PromoteInput {
  return {
    current_ref: 'gemini:gemini-3.6-flash',
    candidate_ref: 'gemini:gemini-3.8-flash',
    same_family: true,
    current_rate: rate(75, 375),
    candidate_rate: rate(75, 375),
    candidate_still_free: true,
    current_is_free: true,
    probe: { ok: true, tools_ok: true, efforts_ok: ['low', 'medium', 'high'] },
    canary: fullCanary(),
    auto_policy_enabled: true,
    paid_ceiling_ok: true,
    ...over,
  };
}

describe('CC-7 F2 — prix et décision', () => {
  it('priceNotHigher refuse une hausse entrée ou sortie', () => {
    expect(priceNotHigher(rate(10, 20), rate(10, 20))).toBe(true);
    expect(priceNotHigher(rate(10, 20), rate(11, 20))).toBe(false);
    expect(priceNotHigher(rate(10, 20), rate(10, 21))).toBe(false);
    expect(priceNotHigher(rate(10, 20, 0), rate(10, 20, 1))).toBe(false);
  });

  it('auto_apply seulement si politique, sonde, canary P3 C2 et prix OK', () => {
    expect(decidePromotion(base()).verdict).toBe('auto_apply');
    expect(canaryReadyForAuto(fullCanary())).toBe(true);
    expect(CANARY_MIN_CALLS).toBe(20);
  });

  it('sans politique auto → propose', () => {
    expect(decidePromotion(base({ auto_policy_enabled: false })).verdict).toBe('propose');
  });

  it('canary absent → propose, jamais auto', () => {
    expect(decidePromotion(base({ canary: null })).verdict).toBe('propose');
  });

  it('canary 1 appel ou type manquant → propose (pas auto)', () => {
    expect(decidePromotion(base({
      canary: fullCanary({ calls: 1, calls_by_kind: { answer: 1 } }),
    })).verdict).toBe('propose');
    expect(decidePromotion(base({
      canary: fullCanary({ calls: 20, calls_by_kind: { answer: 10, review: 10 } }),
    })).verdict).toBe('propose');
  });

  it('efforts_ok vide → reject', () => {
    expect(decidePromotion(base({
      probe: { ok: true, tools_ok: true, efforts_ok: [] },
    })).verdict).toBe('reject');
  });

  it('sonde en échec → reject', () => {
    expect(decidePromotion(base({
      probe: { ok: false, tools_ok: false, efforts_ok: [], error: 'timeout' },
    })).verdict).toBe('reject');
  });

  it('famille différente ou tarif inconnu → reject', () => {
    expect(decidePromotion(base({ same_family: false })).verdict).toBe('reject');
    expect(decidePromotion(base({ candidate_rate: null })).verdict).toBe('reject');
  });

  it('gratuit devenu payant → propose (gel/repli), pas auto', () => {
    const d = decidePromotion(base({
      current_is_free: true,
      candidate_still_free: false,
      candidate_rate: rate(150, 750),
    }));
    expect(d.verdict).toBe('propose');
    expect(d.reasons).toContain('gratuit_devenu_payant_gel_ou_repli');
  });

  it('prix supérieur (déjà payant) → propose', () => {
    expect(decidePromotion(base({
      current_is_free: false,
      candidate_still_free: false,
      candidate_rate: rate(100, 375),
      current_rate: rate(75, 375),
    })).verdict).toBe('propose');
  });

  it('canary taux échec > 5 % ou critique → reject', () => {
    expect(decidePromotion(base({
      canary: fullCanary({ failures: 2 }),
    })).verdict).toBe('reject');
    expect(decidePromotion(base({
      canary: fullCanary({ identity_leak: true }),
    })).verdict).toBe('reject');
  });

  it('payant sans plafond → reject (modèle déjà payant)', () => {
    // current déjà payant : pas la branche gratuit→payant (celle-là propose gel/repli).
    expect(decidePromotion(base({
      current_is_free: false,
      candidate_still_free: false,
      paid_ceiling_ok: false,
      candidate_rate: rate(50, 100),
      current_rate: rate(75, 375),
    })).verdict).toBe('reject');
  });

  it('promoteAutoEnabled strict true', () => {
    expect(promoteAutoEnabled({})).toBe(false);
    expect(promoteAutoEnabled({ AGENT_RUN_PROMOTE_AUTO: 'true' })).toBe(true);
    expect(promoteAutoEnabled({ AGENT_RUN_PROMOTE_AUTO: 'TRUE' })).toBe(false);
  });
});

describe('CC-7 F2 — garde thinkingLevel Gemini (réserve G0)', () => {
  it('requestOptions.thinkingLevel minimal est ramené au plancher du modèle', () => {
    const level = (model: string, requestOptions?: Record<string, unknown>) => {
      const { body } = GEMINI_PROTOCOL.prepare({
        model, system: 'S', messages: [{ role: 'user', content: 'q' }],
        tools: [], taskKind: 'answer', schemas: () => [], maxOutputTokens: 64,
        ...(requestOptions ? { requestOptions } : {}),
      });
      return (body.generationConfig as { thinkingConfig: { thinkingLevel: string } }).thinkingConfig.thinkingLevel;
    };
    // 3.8 refuse minimal → low même si l'appelant impose minimal.
    expect(level('gemini-3.8-flash', { thinkingLevel: 'minimal' })).toBe('low');
    expect(level('gemini-3.8-flash', { thinkingLevel: 'high' })).toBe('high');
    // 3.5 conserve minimal.
    expect(level('gemini-3.5-flash-lite', { thinkingLevel: 'minimal' })).toBe('minimal');
    expect(geminiThinkingLevel('gemini-3.8-flash', 'low')).toBe('low');
  });
});
