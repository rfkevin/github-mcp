/**
 * CC-5 l7 (incrément 7c-1) — premier fournisseur réel du moteur : Workers AI.
 *
 * Binding `AI` déjà déclaré (aucune clé, aucun secret), modèles de la liste
 * gratuite vérifiée (FREE_MODEL_RATES, refus des modèles payants), coût 0 €.
 * Les neurons du jour sont réservés au pire cas AVANT l'appel sur le même
 * registre que le pilote L1 (le quota gratuit est un pool de compte), puis
 * ramenés au réel ; budget insuffisant = aucun appel (ModelCallError sans usage).
 *
 * Appel d'outils au format compatible OpenAI (tools / tool_calls) ; les deux
 * formes de réponse Workers AI sont lues (choices[].message ou response +
 * tool_calls). Le texte rendu au moteur n'est qu'une donnée : le moteur seul
 * décide des outils (allowlist, D12, effets).
 *
 * Jetons comptés (amendement A1, plan seq 719) : prompt_tokens rapportés,
 * qui incluent les résultats d'outils renvoyés au modèle ; si le fournisseur
 * n'en rapporte pas, borne haute calculée sur les octets envoyés (un jeton
 * couvre au moins un octet), jamais 0.
 */
import { FREE_MODEL_RATES, MODEL_CALL_OPTIONS, parseWorkersAiRef, type WorkersAiBinding } from '../executors/adapter';
import { reserveNeurons, settleNeurons } from '../executors/run';
import { ensureSchema } from '../store/schema';
import { ModelCallError, type AgentMessage, type ModelClient, type ModelOutput, type ModelUsage, type ToolCall } from './engine';

/** Description d'un outil exposée au modèle (schéma JSON des arguments). */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface WorkersAiModelOptions {
  ai: WorkersAiBinding;
  /** Référence `workers-ai:@cf/vendor/model` (liste gratuite seulement). */
  ref: string;
  db: D1Database;
  /** Budget de neurons du jour (UTC) partagé avec le pilote L1. */
  neuronBudget: number;
  /** Schémas des outils, par nom ; un outil sans schéma n'est pas exposé. */
  schemas: (taskKind: string) => ToolSchema[];
  /** Consigne système du rôle (persona) ; les données restent dans les messages. */
  system: string;
  maxOutputTokens: number;
  timeoutMs?: number;
  now?: () => Date;
}

const encoder = new TextEncoder();
const DEFAULT_TIMEOUT_MS = 60_000;

function bytes(text: string): number {
  return encoder.encode(text).length;
}

function toProviderMessages(system: string, messages: AgentMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: message.content ?? '',
        ...(message.tool_calls?.length ? {
          tool_calls: message.tool_calls.map(call => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
          })),
        } : {}),
      });
    } else if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.tool_call_id ?? '', content: message.content });
    } else {
      out.push({ role: 'user', content: message.content });
    }
  }
  return out;
}

/** Borne haute des jetons d'entrée : octets UTF-8 des messages et des schémas, plus un forfait par message. */
export function inputTokenBound(providerMessages: Record<string, unknown>[], tools: unknown[]): number {
  return bytes(JSON.stringify(providerMessages)) + bytes(JSON.stringify(tools)) + 16 * providerMessages.length;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const value = JSON.parse(raw) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function readCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const fn = (item.function ?? {}) as Record<string, unknown>;
    const name = typeof fn.name === 'string' ? fn.name : typeof item.name === 'string' ? item.name : '';
    const args = parseArgs(fn.arguments ?? item.arguments);
    const id = typeof item.id === 'string' && item.id ? item.id : 'call-' + index;
    return { id, name, args };
  });
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Lit les deux formes de réponse Workers AI ; rend aussi l'usage rapporté (null si absent). */
export function readModelResponse(raw: unknown): { output: ModelOutput; input: number | null; output_tokens: number | null } {
  const value = (raw ?? {}) as Record<string, unknown>;
  const usage = (value.usage ?? {}) as Record<string, unknown>;
  const choices = value.choices as Array<{ message?: Record<string, unknown> }> | undefined;
  const message = Array.isArray(choices) ? choices[0]?.message : undefined;
  const text = typeof message?.content === 'string' ? message.content : typeof value.response === 'string' ? value.response : '';
  const calls = readCalls(message?.tool_calls ?? value.tool_calls);
  return {
    output: { text, tool_calls: calls },
    input: count(usage.prompt_tokens),
    output_tokens: count(usage.completion_tokens),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('model_timeout')), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createWorkersAiModel(options: WorkersAiModelOptions): ModelClient {
  const model = parseWorkersAiRef(options.ref);
  const rates = FREE_MODEL_RATES[model];
  const neurons = (input: number, output: number) => Math.ceil((input * rates.input_per_m + output * rates.output_per_m) / 1_000_000);
  if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens > 8192) {
    throw new Error('maxOutputTokens entre 1 et 8192.');
  }
  return {
    async complete(input): Promise<{ output: ModelOutput; usage: ModelUsage }> {
      const allowed = new Set(input.tools);
      const tools = options.schemas(input.task_kind).filter(schema => allowed.has(schema.name))
        .map(schema => ({ type: 'function', function: { name: schema.name, description: schema.description, parameters: schema.parameters } }));
      const messages = toProviderMessages(options.system, input.messages);
      const bound = inputTokenBound(messages, tools);
      const worst = neurons(bound, options.maxOutputTokens);
      const now = options.now?.() ?? new Date();
      await ensureSchema(options.db);
      let key: string;
      try {
        key = await reserveNeurons(options.db, worst, options.neuronBudget, now);
      } catch (error) {
        // Budget du jour insuffisant : aucun appel, aucun jeton consommé.
        throw new ModelCallError(error instanceof Error ? error.message : String(error), null);
      }
      let raw: unknown;
      try {
        raw = await withTimeout(options.ai.run(model, {
          ...MODEL_CALL_OPTIONS[model], messages, max_tokens: options.maxOutputTokens,
          ...(tools.length ? { tools } : {}),
        }), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      } catch (error) {
        // Appel incertain : la réserve reste au pire cas (jamais sous-comptée), l'usage est la borne d'entrée.
        throw new ModelCallError('workers_ai_error: ' + (error instanceof Error ? error.message : String(error)),
          { tokens: bound, cost_cents: 0 });
      }
      const parsed = readModelResponse(raw);
      const inputTokens = parsed.input ?? bound;
      const outputTokens = parsed.output_tokens ?? bytes(JSON.stringify(parsed.output));
      await settleNeurons(options.db, key, worst, neurons(inputTokens, outputTokens));
      return { output: parsed.output, usage: { tokens: inputTokens + outputTokens, cost_cents: 0 } };
    },
  };
}
