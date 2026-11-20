/** Immutable pricing facts at call time. Nominal split is not a provider invoice. */
import { API_RATE_SNAPSHOT_DATE, apiModelRate } from '../executors/model-rates';
import { PAID_MODEL_RATES } from './paid-model';

export type PriceBasis = 'free' | 'api_rate' | 'workers_neurons' | 'unknown';
export interface CallPriceSnapshot {
  basis: PriceBasis;
  accounted_cost_cents: number | null;
  input_rate_cents_per_m: number | null;
  output_rate_cents_per_m: number | null;
  rate_as_of: string | null;
  rate_source: string | null;
}
export function snapshotCallPrice(ref: string, cents: number | null): CallPriceSnapshot {
  const accounted_cost_cents = typeof cents === 'number' && Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
  const empty = { accounted_cost_cents, input_rate_cents_per_m: null, output_rate_cents_per_m: null,
    rate_as_of: null, rate_source: null };
  if (accounted_cost_cents === null) return { ...empty, basis: 'unknown' };
  if (accounted_cost_cents === 0) return { ...empty, basis: 'free', input_rate_cents_per_m: 0, output_rate_cents_per_m: 0 };
  const api = apiModelRate(ref);
  if (api) return { basis: 'api_rate', accounted_cost_cents,
    input_rate_cents_per_m: api.input_per_m, output_rate_cents_per_m: api.output_per_m,
    rate_as_of: api.as_of ?? API_RATE_SNAPSHOT_DATE, rate_source: api.source_url };
  if (ref.startsWith('workers-ai:')) {
    const worker = PAID_MODEL_RATES[ref.slice('workers-ai:'.length)];
    if (worker) return { basis: 'workers_neurons', accounted_cost_cents,
      // Workers AI paid: 11/10000 US cents per neuron, before neuron rounding.
      input_rate_cents_per_m: worker.input_per_m * 11 / 10_000,
      output_rate_cents_per_m: worker.output_per_m * 11 / 10_000,
      rate_as_of: '2026-10-24', rate_source: 'workers-ai-neurons' };
  }
  return { ...empty, basis: 'unknown' };
}
/** Nominal cost in USD, calculated only from measured tokens and snapshot rates. */
export function nominalUsd(tokens: number | null, centsPerMillion: number | null): number | null {
  if (tokens === null || centsPerMillion === null || !Number.isSafeInteger(tokens) || tokens < 0
    || !Number.isFinite(centsPerMillion) || centsPerMillion < 0) return null;
  return Number((tokens * centsPerMillion / 100_000_000).toFixed(8));
}
