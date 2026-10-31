/**
 * CC-7 L8 — adaptateur Gemini du canal API : protocole generateContent (pas
 * chat/completions) avec appel de fonctions. Consigne système en
 * systemInstruction, tours user / model, outils en functionDeclarations
 * (parametersJsonSchema : schéma JSON complet), appels functionCall,
 * résultats functionResponse (nom de l'outil retrouvé depuis l'appel d'origine),
 * en-tête x-goog-api-key. Gardes de coût et d'idempotence : noyau commun
 * paid-protocol.ts (chemin gratuit ou payant décidé par provider-models.ts).
 *
 * Signatures de pensée (Gemini 3.x) : le moteur ne conserve que {id, name, args}
 * d'un appel ; la valeur documentée par Google pour un historique sans signature
 * (« skip_thought_signature_validator ») accompagne donc le premier appel de chaque
 * tour model rejoué. Raisonnement au niveau `minimal` (désactivation complète non
 * prise en charge sur Flash / Flash-Lite, précédent CC-4 executors/gemini.ts).
 */
import { GEMINI_API_BASE, geminiThinkingLevel } from '../executors/gemini';
import type { AgentMessage, ModelOutput, ToolCall } from './engine';
import type { PaidProtocol } from './paid-protocol';
import { bytes, type ToolSchema } from './workers-ai-model';

/** Valeur documentée pour un appel de fonction rejoué sans sa signature d'origine. */
export const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator';

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Endpoint constant serveur d'un modèle Gemini (jamais une URL fournie par le modèle). */
export function geminiGenerateUrl(model: string): string {
  if (!MODEL_RE.test(model)) throw new Error('GEMINI_MODEL_UNSUPPORTED : référence de modèle Gemini invalide : ' + model + '.');
  return GEMINI_API_BASE + '/' + encodeURIComponent(model) + ':generateContent';
}

type GeminiPart = Record<string, unknown>;
export interface GeminiContents { systemInstruction: { parts: GeminiPart[] }; contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> }

/**
 * Journal du moteur → generateContent : un tour assistant devient un tour model
 * (texte + functionCall), les résultats d'outils consécutifs sont regroupés dans
 * UN tour user de functionResponse (le protocole attend autant de réponses que d'appels).
 */
export function toGeminiContents(system: string, messages: AgentMessage[]): GeminiContents {
  const names = new Map<string, string>();
  const contents: GeminiContents['contents'] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const [index, call] of (message.tool_calls ?? []).entries()) {
        names.set(call.id, call.name);
        parts.push({ functionCall: { id: call.id, name: call.name, args: call.args ?? {} },
          ...(index === 0 ? { thoughtSignature: GEMINI_SKIP_SIGNATURE } : {}) });
      }
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
    } else if (message.role === 'tool') {
      const id = message.tool_call_id ?? '';
      const part = { functionResponse: { id, name: names.get(id) ?? 'tool', response: { content: message.content } } };
      const last = contents[contents.length - 1];
      if (last && last.role === 'user' && last.parts.every(p => 'functionResponse' in p)) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
    } else {
      contents.push({ role: 'user', parts: [{ text: message.content }] });
    }
  }
  return { systemInstruction: { parts: [{ text: system }] }, contents };
}

function geminiTools(schemas: (taskKind: string) => ToolSchema[], taskKind: string, allowed: Set<string>) {
  const declarations = schemas(taskKind).filter(schema => allowed.has(schema.name))
    .map(schema => ({ name: schema.name, description: schema.description, parametersJsonSchema: schema.parameters }));
  return declarations.length ? [{ functionDeclarations: declarations }] : [];
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Réponse generateContent → sortie moteur ; les jetons de pensée sont facturés comme sortie. */
export function readGeminiResponse(raw: unknown): { output: ModelOutput; input: number | null; output_tokens: number | null } {
  const value = (raw ?? {}) as Record<string, unknown>;
  const candidates = Array.isArray(value.candidates) ? value.candidates as Array<Record<string, unknown>> : [];
  const content = (candidates[0]?.content ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(content.parts) ? content.parts as Array<Record<string, unknown>> : [];
  let text = '';
  const tool_calls: ToolCall[] = [];
  for (const part of parts) {
    if (part.thought === true) continue;
    if (typeof part.text === 'string') text += part.text;
    const call = part.functionCall as Record<string, unknown> | undefined;
    if (call && typeof call === 'object') {
      const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args as Record<string, unknown> : {};
      tool_calls.push({ id: typeof call.id === 'string' && call.id ? call.id : 'gem_' + tool_calls.length,
        name: typeof call.name === 'string' ? call.name : '', args });
    }
  }
  const usage = (value.usageMetadata ?? {}) as Record<string, unknown>;
  const candidatesTokens = count(usage.candidatesTokenCount);
  const thoughts = count(usage.thoughtsTokenCount) ?? 0;
  return {
    output: { text, tool_calls },
    input: count(usage.promptTokenCount),
    output_tokens: candidatesTokens === null ? null : candidatesTokens + thoughts,
  };
}

/** Protocole generateContent : en-tête x-goog-api-key, corps systemInstruction / contents / tools / generationConfig. */
export const GEMINI_PROTOCOL: PaidProtocol = {
  headers(secret: string) {
    return { 'x-goog-api-key': secret };
  },
  prepare(input) {
    const tools = geminiTools(input.schemas, input.taskKind, new Set(input.tools));
    const converted = toGeminiContents(input.system, input.messages);
    return {
      body: {
        systemInstruction: converted.systemInstruction, contents: converted.contents,
        ...(tools.length ? { tools } : {}),
        // CC-7 L9b + F2 : niveau décidé par le serveur. Toute valeur fournie (y compris « minimal »)
        // est ramenée au plancher accepté par CE modèle (G0 : 3.8 / 4-argon sans minimal).
        generationConfig: { maxOutputTokens: input.maxOutputTokens,
          thinkingConfig: { thinkingLevel: normalizeGeminiThinkingLevel(input.model, input.requestOptions?.thinkingLevel) } },
      },
      bound: bytes(JSON.stringify(converted.contents)) + bytes(input.system) + bytes(JSON.stringify(tools))
        + 16 * converted.contents.length,
    };
  },
  parse: readGeminiResponse,
};
