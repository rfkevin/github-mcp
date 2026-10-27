/**
 * CC-7 L2 (PR 2.3, plan CC-PLAN-7 v0.2 S2) — adaptateur Anthropic du canal
 * API : protocole Messages DISTINCT du socle OpenAI (pas de chat/completions)
 * — consigne système top-level, blocs de contenu text / tool_use /
 * tool_result, outils en input_schema, en-têtes x-api-key + anthropic-version
 * (pas de Bearer). Les gardes de coût et d'idempotence vivent dans le noyau
 * commun paid-protocol.ts (enveloppe PAR PARTICIPANT, registre daté
 * deny-by-default, réservation/règlement au pire cas, rejeu fail-closed) ;
 * seul le protocole est porté ici. Secret LLM_KEY_ANTHROPIC (posé par Kevin
 * seul sur le Worker) : absent = EXECUTOR_UNAVAILABLE avant toute
 * réservation, aucun quota touché ; aucun appel avant le GO de Kevin + secret.
 */
import type { ApiModelRate } from '../executors/model-rates';
import type { AgentMessage, ModelClient, ModelOutput, ToolCall } from './engine';
import { createPaidProtocolModel, parsePaidProviderRef, type PaidModelCore, type PaidProtocol } from './paid-protocol';
import { bytes, type ToolSchema } from './workers-ai-model';

/** Endpoint constant serveur de l'API Messages (jamais une URL du modèle). */
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** Version du protocole Messages exigée par l'endpoint, constante serveur. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

export interface AnthropicModelOptions extends PaidModelCore {
  /** Environnement serveur : secret LLM_KEY_ANTHROPIC (posé par Kevin seul sur le Worker). */
  env: { LLM_KEY_ANTHROPIC?: string };
  /** CC-7 L9b : réflexion adaptative et niveau (thinking, output_config.effort), décidés par le serveur. */
  requestOptions?: Readonly<Record<string, unknown>>;
}

/** Référence Anthropic du registre daté : deny-by-default, aucun repli inter-familles. */
export function parseAnthropicRef(ref: string): { model: string; rate: ApiModelRate } {
  return parsePaidProviderRef(ref, 'anthropic');
}

/** Journal du moteur converti au protocole Messages : system top-level, blocs de contenu par tour. */
export interface AnthropicMessages {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }>;
}

/**
 * Conversion du journal du moteur vers le protocole Messages : la consigne
 * système reste top-level (jamais dans les messages), un tour utilisateur en
 * bloc text, un tour assistant en blocs text + tool_use, un résultat d'outil
 * en bloc tool_result porté par un tour utilisateur (contrainte du protocole).
 */
export function toAnthropicMessages(system: string, messages: AgentMessage[]): AnthropicMessages {
  const out: AnthropicMessages['messages'] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const content: unknown[] = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
    } else if (message.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: message.content }] });
    } else {
      out.push({ role: 'user', content: [{ type: 'text', text: message.content }] });
    }
  }
  return { system, messages: out };
}

/** Outils allowlistés au format du protocole Messages : input_schema, sans wrapper function. */
function anthropicTools(schemas: (taskKind: string) => ToolSchema[], taskKind: string, allowed: Set<string>) {
  return schemas(taskKind).filter(schema => allowed.has(schema.name))
    .map(schema => ({ name: schema.name, description: schema.description, input_schema: schema.parameters }));
}

/** Borne haute des jetons d'entrée du protocole Messages : octets des tours, de la consigne et des schémas, plus un forfait par message. */
function anthropicInputBound(converted: AnthropicMessages, tools: unknown[]): number {
  return bytes(JSON.stringify(converted.messages)) + bytes(converted.system)
    + bytes(JSON.stringify(tools)) + 16 * converted.messages.length;
}

/** Arguments d'un bloc tool_use : un objet JSON, tout le reste vaut objet vide. */
function blockArgs(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

/** Usage rapporté : entier sûr positif, tout le reste vaut null (borne octets côté noyau). */
function reported(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Lecture d'une réponse Messages : blocs text concaténés, blocs tool_use en tool_calls, usage input_tokens/output_tokens. */
export function readAnthropicResponse(raw: unknown): { output: ModelOutput; input: number | null; output_tokens: number | null } {
  const value = (raw ?? {}) as Record<string, unknown>;
  const usage = (value.usage ?? {}) as Record<string, unknown>;
  const blocks = Array.isArray(value.content) ? value.content : [];
  let text = '';
  const tool_calls: ToolCall[] = [];
  for (const block of blocks) {
    const item = (block ?? {}) as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') {
      text += item.text;
    } else if (item.type === 'tool_use') {
      const id = typeof item.id === 'string' && item.id ? item.id : 'toolu_' + tool_calls.length;
      tool_calls.push({ id, name: typeof item.name === 'string' ? item.name : '', args: blockArgs(item.input) });
    }
  }
  return {
    output: { text, tool_calls },
    input: reported(usage.input_tokens),
    output_tokens: reported(usage.output_tokens),
  };
}

/** Protocole Messages : en-têtes x-api-key + anthropic-version, corps system/messages/max_tokens/tools. */
const ANTHROPIC_PROTOCOL: PaidProtocol = {
  headers(secret: string) {
    return { 'x-api-key': secret, 'anthropic-version': ANTHROPIC_API_VERSION };
  },
  prepare(input) {
    const tools = anthropicTools(input.schemas, input.taskKind, new Set(input.tools));
    const converted = toAnthropicMessages(input.system, input.messages);
    return {
      body: {
        model: input.model, system: converted.system, messages: converted.messages,
        max_tokens: input.maxOutputTokens, ...(input.requestOptions ?? {}), ...(tools.length ? { tools } : {}),
      },
      bound: anthropicInputBound(converted, tools),
    };
  },
  parse: readAnthropicResponse,
};

/** Modèle Anthropic : même contrat ModelClient que les autres adaptateurs, coût borné par l'enveloppe par participant. */
export function createAnthropicModel(options: AnthropicModelOptions): ModelClient {
  return createPaidProtocolModel({ ...options, secret: options.env.LLM_KEY_ANTHROPIC,
    url: ANTHROPIC_MESSAGES_URL, provider: 'anthropic', protocol: ANTHROPIC_PROTOCOL });
}
