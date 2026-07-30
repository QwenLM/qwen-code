/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { GenerateContentResponse, FinishReason } from '@google/genai';
import type {
  GenerateContentParameters,
  Part,
  Content,
  Candidate,
} from '@google/genai';
import type {
  ResponsesSSEEvent,
  ResponsesApiOutputItem,
  ResponsesApiOutputFunctionCall,
  ResponsesApiOutputReasoningSummary,
  ResponsesApiUsage,
  ResponsesApiInputItem,
  ResponsesApiMessageItem,
  ResponsesApiFunctionCallItem,
  ResponsesApiFunctionCallOutputItem,
  ResponsesApiReasoningItem,
  ResponsesApiTool,
  ResponsesApiContentPart,
} from './types.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('RESPONSES_CONVERTER');

/**
 * Opaque payload stashed in `part.thoughtSignature` for a Responses API
 * reasoning item, so it round-trips through this app's own Content[] history
 * (and therefore through compaction, session persistence, and history
 * consolidation in geminiChat.ts) without ever appearing as visible text.
 */
interface ReasoningSignaturePayload {
  id: string;
  encrypted_content: string;
}

function encodeReasoningSignature(payload: ReasoningSignaturePayload): string {
  return JSON.stringify(payload);
}

function decodeReasoningSignature(
  signature: string | undefined,
): ReasoningSignaturePayload | undefined {
  if (!signature) return undefined;
  try {
    const parsed = JSON.parse(signature) as Partial<ReasoningSignaturePayload>;
    if (
      typeof parsed.id === 'string' &&
      typeof parsed.encrypted_content === 'string'
    ) {
      return { id: parsed.id, encrypted_content: parsed.encrypted_content };
    }
  } catch {
    // Not our JSON shape — treat as absent rather than guess.
  }
  return undefined;
}

/**
 * Tracks accumulated state for a single streaming response from the
 * Responses API. A new instance should be created per response stream.
 */
export class ResponsesStreamState {
  responseId: string | null = null;
  private funcCallArgs: Map<
    number,
    { id: string; name: string; args: string }
  > = new Map();

  getFunctionCallBuffer(
    outputIndex: number,
  ): { id: string; name: string; args: string } | undefined {
    return this.funcCallArgs.get(outputIndex);
  }

  initFunctionCall(
    outputIndex: number,
    _id: string,
    callId: string,
    name: string,
  ): void {
    this.funcCallArgs.set(outputIndex, { id: callId, name, args: '' });
  }

  appendFunctionCallArgs(outputIndex: number, delta: string): void {
    const buf = this.funcCallArgs.get(outputIndex);
    if (buf) buf.args += delta;
  }

  reset(): void {
    this.responseId = null;
    this.funcCallArgs.clear();
  }
}

/**
 * Converts Responses API SSE events into GenerateContentResponse objects
 * matching the shape produced by the Chat Completions converter, so the
 * downstream Turn / GeminiClient pipeline works unchanged.
 */
export function convertResponsesEventToGemini(
  event: ResponsesSSEEvent,
  model: string,
  state: ResponsesStreamState,
): GenerateContentResponse | null {
  switch (event.event) {
    case 'response.created': {
      const raw = event.data as Record<string, unknown>;
      const envelope = (raw['response'] ?? raw) as { id?: string };
      if (envelope.id) {
        state.responseId = envelope.id;
      }
      return null;
    }

    case 'response.in_progress':
      return null;

    case 'response.output_item.added': {
      const data = event.data as {
        output_index: number;
        item: ResponsesApiOutputItem;
      };
      if (data.item.type === 'function_call') {
        const fc = data.item as ResponsesApiOutputFunctionCall;
        state.initFunctionCall(data.output_index, fc.id, fc.call_id, fc.name);
      }
      return null;
    }

    case 'response.output_text.delta': {
      const data = event.data as { delta: string };
      return makeChunkResponse(model, state, [{ text: data.delta }]);
    }

    case 'response.reasoning_summary_text.delta': {
      const data = event.data as { delta: string };
      return makeChunkResponse(model, state, [
        { text: data.delta, thought: true },
      ]);
    }

    case 'response.function_call_arguments.delta': {
      const data = event.data as { output_index: number; delta: string };
      state.appendFunctionCallArgs(data.output_index, data.delta);
      return null;
    }

    case 'response.output_item.done': {
      const data = event.data as {
        output_index: number;
        item: ResponsesApiOutputItem;
      };
      if (data.item.type === 'function_call') {
        const fc = data.item as ResponsesApiOutputFunctionCall;
        const buf = state.getFunctionCallBuffer(data.output_index);
        // Prefer the locally accumulated delta buffer (matches the id/name
        // captured at output_item.added), but fall back to the done item's
        // own fields — the spec guarantees `arguments` is the complete final
        // JSON string here — so a missed/reordered output_item.added on a
        // non-compliant proxy doesn't silently drop the whole tool call.
        const id = buf?.id ?? fc.call_id;
        const name = buf?.name ?? fc.name;
        const rawArgs = buf?.args ?? fc.arguments;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(rawArgs) as Record<string, unknown>;
        } catch {
          args = {};
        }
        return makeChunkResponse(model, state, [
          {
            functionCall: {
              id,
              name,
              args,
            },
          },
        ]);
      }
      if (data.item.type === 'reasoning') {
        const reasoningItem = data.item as ResponsesApiOutputReasoningSummary;
        const encryptedContent = reasoningItem.encrypted_content;
        // No encrypted_content means this turn's reasoning can't be replayed
        // (e.g. `include` wasn't honored for this model). Drop the signature
        // rather than emit one we can't reconstruct later — the thought text
        // itself already streamed via reasoning_summary_text.delta above.
        if (!encryptedContent) return null;
        // NOTE: a single turn can contain multiple reasoning output items
        // (e.g. one per parallel function call), each emitted here as its own
        // signature-only chunk. geminiChat.ts's history consolidation only
        // keeps the *first* thoughtSignature it sees per turn when merging
        // thought chunks, so only the first item's encrypted_content survives
        // into history — a pre-existing limitation of that shared
        // consolidation logic, not specific to this generator.
        return makeChunkResponse(model, state, [
          {
            thought: true,
            thoughtSignature: encodeReasoningSignature({
              id: reasoningItem.id,
              encrypted_content: encryptedContent,
            }),
          },
        ]);
      }
      return null;
    }

    case 'response.completed': {
      const raw = event.data as Record<string, unknown>;
      const envelope = (raw['response'] ?? raw) as {
        id?: string;
        usage?: ResponsesApiUsage;
      };
      if (envelope.id) state.responseId = envelope.id;
      return makeFinalResponse(model, state, envelope.usage, 'stop');
    }

    case 'response.failed': {
      const raw = event.data as Record<string, unknown>;
      const envelope = (raw['response'] ?? raw) as {
        error?: { code: string; message: string };
      };
      const errMsg = envelope.error
        ? `${envelope.error.code}: ${envelope.error.message}`
        : 'Response failed';
      throw new Error(`Responses API failed: ${errMsg}`);
    }

    case 'response.incomplete': {
      // The envelope carries the same Response shape as response.completed
      // (usage, incomplete_details.reason) — extract it instead of discarding
      // token accounting and misreporting every incomplete reason as MAX_TOKENS.
      const raw = event.data as Record<string, unknown>;
      const envelope = (raw['response'] ?? raw) as {
        id?: string;
        usage?: ResponsesApiUsage;
        incomplete_details?: { reason?: string };
      };
      if (envelope.id) state.responseId = envelope.id;
      return makeFinalResponse(
        model,
        state,
        envelope.usage,
        envelope.incomplete_details?.reason ?? 'max_output_tokens',
      );
    }

    case 'error': {
      const data = event.data as { message?: string };
      throw new Error(
        `Responses API error: ${data.message ?? 'Unknown error'}`,
      );
    }

    default:
      return null;
  }
}

function makeChunkResponse(
  model: string,
  state: ResponsesStreamState,
  parts: Part[],
  finishReason?: string,
): GenerateContentResponse {
  const candidate: Candidate = {
    content: { parts, role: 'model' as const },
    index: 0,
    safetyRatings: [],
  };
  if (finishReason) {
    candidate.finishReason = mapFinishReason(finishReason);
  }

  const resp = new GenerateContentResponse();
  resp.candidates = [candidate];
  resp.responseId = state.responseId ?? undefined;
  resp.modelVersion = model;
  resp.createTime = Date.now().toString();
  resp.promptFeedback = { safetyRatings: [] };
  return resp;
}

function makeFinalResponse(
  model: string,
  state: ResponsesStreamState,
  usage: ResponsesApiUsage | undefined,
  finishReason: string,
): GenerateContentResponse {
  const resp = makeChunkResponse(model, state, [], finishReason);

  if (usage) {
    resp.usageMetadata = {
      promptTokenCount: usage.input_tokens,
      candidatesTokenCount: usage.output_tokens,
      totalTokenCount: usage.total_tokens,
      thoughtsTokenCount: usage.output_tokens_details?.reasoning_tokens ?? 0,
      cachedContentTokenCount: usage.input_tokens_details?.cached_tokens ?? 0,
    };
  }

  return resp;
}

function mapFinishReason(reason: string): FinishReason {
  const mapping: Record<string, FinishReason> = {
    stop: FinishReason.STOP,
    length: FinishReason.MAX_TOKENS,
    content_filter: FinishReason.SAFETY,
    max_output_tokens: FinishReason.MAX_TOKENS,
  };
  return mapping[reason] ?? FinishReason.STOP;
}

// ── Input conversion: Gemini Content[] → Responses API input items ─────

export function convertGeminiContentsToResponsesInput(
  request: GenerateContentParameters,
): { instructions: string | undefined; input: ResponsesApiInputItem[] } {
  let instructions: string | undefined;
  const items: ResponsesApiInputItem[] = [];
  let callIdCounter = 0;

  if (request.config?.systemInstruction) {
    const si = request.config.systemInstruction;
    if (typeof si === 'string') {
      instructions = si;
    } else if (
      typeof si === 'object' &&
      'parts' in si &&
      Array.isArray(si.parts)
    ) {
      instructions = si.parts
        .map((p: Part) => (typeof p === 'string' ? p : (p.text ?? '')))
        .join('\n');
    }
  }

  const contents = request.contents;
  if (!contents) return { instructions, input: items };

  const contentArray: Content[] = Array.isArray(contents)
    ? (contents as Content[])
    : typeof contents === 'string'
      ? [{ role: 'user', parts: [{ text: contents }] }]
      : [contents as Content];

  for (const content of contentArray) {
    if (typeof content === 'string') {
      items.push({
        type: 'message',
        role: 'user',
        content,
      } as ResponsesApiMessageItem);
      continue;
    }

    const role = content.role === 'model' ? 'assistant' : 'user';
    const parts = content.parts ?? [];

    for (const part of parts) {
      if (typeof part === 'string') {
        items.push({
          type: 'message',
          role,
          content: part,
        } as ResponsesApiMessageItem);
        continue;
      }

      if ('thought' in part && part.thought) {
        // Prior-turn reasoning can only be replayed as a real 'reasoning'
        // item if we captured its id + encrypted_content via thoughtSignature
        // when it first streamed in. If it's missing (older history, a model
        // that didn't return encrypted_content, or cross-provider history),
        // fall back to a plain assistant message rather than guessing at a
        // 'reasoning' item reconstruction the API would reject — this still
        // loses the unreplayable encrypted payload, but preserves the
        // human-readable summary instead of discarding it outright.
        if (role === 'assistant') {
          const payload = decodeReasoningSignature(part.thoughtSignature);
          if (payload) {
            items.push({
              type: 'reasoning',
              id: payload.id,
              encrypted_content: payload.encrypted_content,
              summary: part.text
                ? [{ type: 'summary_text', text: part.text }]
                : [],
            } as ResponsesApiReasoningItem);
          } else if (part.text) {
            debugLogger.warn(
              'Dropping unreplayable reasoning signature; preserving summary text as a plain message',
            );
            items.push({
              type: 'message',
              role: 'assistant',
              content: part.text,
            } as ResponsesApiMessageItem);
          }
        }
        continue;
      }

      if ('text' in part && part.text) {
        items.push({
          type: 'message',
          role,
          content: part.text,
        } as ResponsesApiMessageItem);
      }

      if ('functionCall' in part && part.functionCall) {
        const callId =
          part.functionCall.id || `call_${Date.now()}_${callIdCounter++}`;
        items.push({
          type: 'function_call',
          call_id: callId,
          name: part.functionCall.name ?? '',
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        } as ResponsesApiFunctionCallItem);
      }

      if ('functionResponse' in part && part.functionResponse) {
        const fr = part.functionResponse;
        let output: string;
        if (typeof fr.response === 'string') {
          output = fr.response;
        } else {
          output = JSON.stringify(fr.response ?? {});
        }
        items.push({
          type: 'function_call_output',
          call_id: fr.id || `call_${Date.now()}_${callIdCounter++}`,
          output,
        } as ResponsesApiFunctionCallOutputItem);
      }

      if ('inlineData' in part && part.inlineData && role === 'user') {
        const mimeType = part.inlineData.mimeType ?? 'image/png';
        if (mimeType.startsWith('image/')) {
          const contentParts: ResponsesApiContentPart[] = [
            {
              type: 'input_image',
              image_url: `data:${mimeType};base64,${part.inlineData.data}`,
            },
          ];
          items.push({
            type: 'message',
            role: 'user',
            content: contentParts,
          } as ResponsesApiMessageItem);
        }
      }
    }
  }

  return { instructions, input: items };
}

/**
 * Remove any `function_call`/`function_call_output` item whose `call_id` has
 * no matching counterpart in the input array. This prevents the Responses
 * API from rejecting the request over a broken call/output pair.
 *
 * Root cause: server-side truncation or context budget trimming can break a
 * function_call / function_call_output pair in either direction — keeping
 * the call while dropping the output, or vice versa. This safety net ensures
 * the wire request is always structurally valid regardless of upstream
 * trimming bugs.
 */
export function cleanOrphanedFunctionCalls(
  items: ResponsesApiInputItem[],
): ResponsesApiInputItem[] {
  const callIds = new Set<string>();
  const outputCallIds = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('type' in item)) {
      continue;
    }
    if (item.type === 'function_call' && 'call_id' in item) {
      callIds.add((item as ResponsesApiFunctionCallItem).call_id);
    } else if (item.type === 'function_call_output' && 'call_id' in item) {
      outputCallIds.add((item as ResponsesApiFunctionCallOutputItem).call_id);
    }
  }
  return items.filter((item) => {
    if (typeof item !== 'object' || item === null || !('type' in item)) {
      return true;
    }
    if (item.type === 'function_call' && 'call_id' in item) {
      return outputCallIds.has((item as ResponsesApiFunctionCallItem).call_id);
    }
    if (item.type === 'function_call_output' && 'call_id' in item) {
      return callIds.has((item as ResponsesApiFunctionCallOutputItem).call_id);
    }
    return true;
  });
}

export function convertGeminiToolsToResponsesTools(
  request: GenerateContentParameters,
): ResponsesApiTool[] | undefined {
  const tools = request.config?.tools;
  if (!tools || !Array.isArray(tools)) return undefined;

  const result: ResponsesApiTool[] = [];
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue;
    const funcDecls =
      'functionDeclarations' in tool ? tool.functionDeclarations : undefined;
    if (!Array.isArray(funcDecls)) continue;

    for (const func of funcDecls) {
      if (!func.name) continue;
      result.push({
        type: 'function',
        name: func.name,
        description: func.description,
        parameters: normalizeResponsesParameters(
          (func.parameters ?? func.parametersJsonSchema) as
            | Record<string, unknown>
            | undefined,
        ),
      });
    }
  }

  return result.length > 0 ? result : undefined;
}

/**
 * Normalize a function-tool `parameters` JSON Schema for the OpenAI /responses
 * wire. When routed through Azure/litellm, strict function-schema validation
 * rejects `{"type":"object"}` without a `properties` key:
 *
 *   Invalid schema for function '<name>': In context=(), object schema
 *   missing properties.
 *
 * MCP servers legally declare zero-arg tools as `{"type":"object"}`. This
 * helper patches such schemas (including nested object schemas) to include
 * `properties: {}` so Azure accepts them. Well-formed schemas pass through
 * unchanged.
 */
export function normalizeResponsesParameters(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (schema === undefined) return undefined;
  if (schema === null || typeof schema !== 'object') return schema;
  return normalizeResponsesSchemaNode(schema) as Record<string, unknown>;
}

function normalizeResponsesSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => normalizeResponsesSchemaNode(item));
  }
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {
    ...(node as Record<string, unknown>),
  };

  if (out['properties'] && typeof out['properties'] === 'object') {
    const props = out['properties'] as Record<string, unknown>;
    const nextProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      nextProps[k] = normalizeResponsesSchemaNode(v);
    }
    out['properties'] = nextProps;
  }
  if (out['items']) {
    out['items'] = normalizeResponsesSchemaNode(out['items']);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const v = out[key];
    if (Array.isArray(v)) {
      out[key] = v.map((item) => normalizeResponsesSchemaNode(item));
    }
  }

  if (out['type'] === 'object' && out['properties'] === undefined) {
    out['properties'] = {};
  }

  return out;
}
