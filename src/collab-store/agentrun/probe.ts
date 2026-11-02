/**
 * CC-8 S4 — sonde unique, fail-closed, live fournisseur mesuré.
 *
 * Un seul runner pour /owner et model.finding. Compatible promote/decision.ts
 * sans le modifier.
 *
 * - disabled / HALT / ref invalide → ok=false
 * - simulation uniquement allowSimulation (tests) ; non utilisable en promotion
 * - live : appel fournisseur réel (Gemini gratuit si clé) ; sinon not_implemented
 */
import { isAutomationHalted } from '../owner/automation';
import { isPinnedRef, type ProbeResult } from './promote/decision';
import { geminiGenerateUrl } from './gemini-model';

export const PROBE_EFFORTS_DEFAULT = Object.freeze(['low', 'medium', 'high'] as const);

export type ProbeProvenance = 'simulation' | 'provider' | 'none';
export type ProbeMode = 'disabled' | 'not_implemented' | 'simulated' | 'live' | 'halted' | 'rejected';

export interface ProbeEnv {
  /** Exact « true » pour tenter une sonde live ; sinon disabled. */
  AGENT_RUN_PROBE?: string;
  /** Clé Gemini (owner) — requise pour live gemini:*. */
  LLM_KEY_GEMINI?: string;
  /** Injection tests / autres fournisseurs. */
  probeFetch?: typeof fetch;
}

export interface ProbeRequest {
  candidate_ref: string;
  source: 'owner_button' | 'model_finding' | 'test';
  finding_id?: string;
  now?: number;
  allowSimulation?: boolean;
}

export interface ProbeOutcome extends ProbeResult {
  readonly candidate_ref: string;
  readonly source: ProbeRequest['source'];
  readonly finding_id?: string;
  readonly at: number;
  readonly mode: ProbeMode;
  readonly provenance: ProbeProvenance;
}

export function probeEnabled(env: ProbeEnv | undefined): boolean {
  return env?.AGENT_RUN_PROBE === 'true';
}

export function probeUsableForPromotion(outcome: ProbeOutcome): boolean {
  return outcome.ok && outcome.tools_ok && outcome.provenance === 'provider' && outcome.mode === 'live';
}

/** true si une mesure live a eu lieu (succès ou échec fournisseur) — pas disabled/not_implemented. */
export function probeAttemptCompleted(outcome: ProbeOutcome): boolean {
  return outcome.mode === 'live' && outcome.provenance === 'provider';
}

function baseOf(request: ProbeRequest, at: number) {
  return {
    candidate_ref: request.candidate_ref,
    source: request.source,
    ...(request.finding_id ? { finding_id: request.finding_id } : {}),
    at,
  };
}

/**
 * Sonde live Gemini : un generateContent minimal avec functionDeclarations.
 * Mesure tools_ok (réponse structurée) et efforts (thinkingConfig low accepté).
 * Coût 0 attendu sur palier gratuit ; erreur HTTP → ok=false mesuré.
 */
async function liveGeminiProbe(
  env: ProbeEnv,
  model: string,
): Promise<{ ok: boolean; tools_ok: boolean; efforts_ok: string[]; error?: string; cost_micro_cents: number }> {
  const key = env.LLM_KEY_GEMINI?.trim();
  if (!key) return { ok: false, tools_ok: false, efforts_ok: [], error: 'NO_GEMINI_KEY', cost_micro_cents: 0 };
  let url: string;
  try {
    url = geminiGenerateUrl(model);
  } catch {
    return { ok: false, tools_ok: false, efforts_ok: [], error: 'GEMINI_MODEL_UNSUPPORTED', cost_micro_cents: 0 };
  }
  const body = {
    systemInstruction: { parts: [{ text: 'Reply with a single function call only.' }] },
    contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
    tools: [{
      functionDeclarations: [{
        name: 'probe_ping',
        description: 'Acknowledge probe',
        parametersJsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      }],
    }],
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    generationConfig: { maxOutputTokens: 64, thinkingConfig: { thinkingLevel: 'low' } },
  };
  const fetchImpl = env.probeFetch ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false, tools_ok: false, efforts_ok: [],
      error: 'NETWORK:' + (err instanceof Error ? err.message.slice(0, 80) : 'unknown'),
      cost_micro_cents: 0,
    };
  }
  if (!res.ok) {
    return {
      ok: false, tools_ok: false, efforts_ok: [],
      error: 'HTTP_' + res.status,
      cost_micro_cents: 0,
    };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, tools_ok: false, efforts_ok: [], error: 'BAD_JSON', cost_micro_cents: 0 };
  }
  const parts = (json as { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> })
    ?.candidates?.[0]?.content?.parts ?? [];
  const hasFn = parts.some((p) => p && typeof p === 'object' && 'functionCall' in p);
  return {
    ok: true,
    tools_ok: hasFn,
    efforts_ok: hasFn ? ['low'] : [],
    cost_micro_cents: 0,
    ...(hasFn ? {} : { error: 'NO_FUNCTION_CALL' }),
  };
}

export async function runModelProbe(
  db: D1Database,
  env: ProbeEnv,
  request: ProbeRequest,
): Promise<ProbeOutcome> {
  const at = request.now ?? Math.floor(Date.now() / 1000);
  const base = baseOf(request, at);

  if (await isAutomationHalted(db)) {
    return { ...base, ok: false, tools_ok: false, efforts_ok: [], error: 'HALT_ACTIVE', mode: 'halted', provenance: 'none' };
  }
  if (!isPinnedRef(request.candidate_ref)) {
    return { ...base, ok: false, tools_ok: false, efforts_ok: [], error: 'ref_non_epinglee', mode: 'rejected', provenance: 'none' };
  }
  if (request.allowSimulation === true) {
    return {
      ...base, ok: true, tools_ok: true, efforts_ok: [...PROBE_EFFORTS_DEFAULT],
      cost_micro_cents: 0, mode: 'simulated', provenance: 'simulation',
    };
  }
  if (!probeEnabled(env)) {
    return {
      ...base, ok: false, tools_ok: false, efforts_ok: [],
      error: 'PROBE_DISABLED', mode: 'disabled', provenance: 'none',
    };
  }

  const colon = request.candidate_ref.indexOf(':');
  const provider = request.candidate_ref.slice(0, colon);
  const model = request.candidate_ref.slice(colon + 1);

  // Live mesuré : Gemini seulement en S4 (clé owner). Autres fournisseurs → not_implemented.
  // google: et gemini: → même endpoint (alias historique tests).
  if (provider === 'gemini' || provider === 'google') {
    const measured = await liveGeminiProbe(env, model);
    const toolsOk = measured.tools_ok;
    const ok = measured.ok && toolsOk;
    return {
      ...base,
      ok,
      tools_ok: toolsOk,
      efforts_ok: measured.efforts_ok,
      cost_micro_cents: measured.cost_micro_cents,
      ...(measured.error ? { error: measured.error } : {}),
      mode: 'live',
      provenance: 'provider',
    };
  }

  return {
    ...base, ok: false, tools_ok: false, efforts_ok: [],
    error: 'PROBE_NOT_IMPLEMENTED', mode: 'not_implemented', provenance: 'none',
  };
}
