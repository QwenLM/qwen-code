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
import { sanitizeMimeForPlaceholder } from '../../services/compactionInputSlimming.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { safeJsonParse } from '../../utils/safeJsonParse.js';
import { setGenAiUsageProvenance } from '../../telemetry/gen-ai-usage.js';

const debugLogger = createDebugLogger('RESPONSES_CONVERTER');

const SUPPORTED_RESPONSE_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function isSupportedResponseImageMime(
  mimeType: string | undefined,
): mimeType is string {
  return (
    mimeType !== undefined && SUPPORTED_RESPONSE_IMAGE_MIME_TYPES.has(mimeType)
  );
}

function placeholderMimeType(mimeType: string | undefined): string {
  const sanitized = mimeType ? sanitizeMimeForPlaceholder(mimeType) : '';
  return sanitized || 'unknown mime type';
}

/**
 * Known OpenAI Responses API error codes that carry a well-defined HTTP
 * status. Mid-stream `error` / `response.failed` frames arrive after a 200 OK,
 * so unless the thrown error is stamped with a `.status`/`.code` it classifies
 * as `unknown` and misses every retry / rate-limit / model-fallback gate (see
 * utils/retryErrorClassification.ts and utils/rateLimit.ts) — the same failure
 * at connection time carries `.status` (responses-pipeline.ts) and is retried.
 */
const RESPONSES_ERROR_CODE_TO_STATUS: Record<string, number> = {
  server_error: 500,
  rate_limit_exceeded: 429,
};

interface ResponsesStreamError extends Error {
  status?: number;
  code?: string;
}

function makeResponsesStreamError(
  message: string,
  code?: string,
): ResponsesStreamError {
  const err: ResponsesStreamError = new Error(message);
  if (code) {
    err.code = code;
    const status = RESPONSES_ERROR_CODE_TO_STATUS[code];
    if (status !== undefined) err.status = status;
  }
  return err;
}

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

    case 'response.refusal.delta': {
      // A model refusal streams as refusal.delta frames rather than
      // output_text.delta. Surface it as ordinary text (mirroring
      // output_text.delta) so the user sees the refusal instead of geminiChat
      // throwing InvalidStreamError('...empty response text.') and retrying
      // the full prompt transientMaxRetries times.
      const data = event.data as { delta: string };
      return makeChunkResponse(model, state, [{ text: data.delta }]);
    }

    case 'response.refusal.done':
      // The full refusal already streamed via refusal.delta frames; the done
      // frame is terminal only, exactly as output_text.done is treated.
      return null;

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
        // `||` not `??`: initFunctionCall seeds buf.args to '', so a buffer
        // that received output_item.added but no function_call_arguments.delta
        // events (e.g. a non-compliant proxy that only sends output_item.done
        // with the complete arguments) must still fall through to fc.arguments
        // -- an empty string is not nullish and would otherwise short-circuit
        // this fallback, sending an empty-args tool call to the model.
        const rawArgs = buf?.args || fc.arguments;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(rawArgs) as Record<string, unknown>;
        } catch {
          // The accumulated delta buffer can be corrupt or truncated (a
          // non-compliant proxy) while the done item still carries the
          // complete authoritative `arguments` string — prefer that when it
          // differs, so a valid final payload isn't shadowed by a broken
          // buffer. Otherwise repair the string we have with the same
          // jsonrepair fallback every sibling wire applies (safeJsonParse,
          // streamingToolCallParser.getCompletedToolCalls, the Chat converter).
          const authoritative =
            fc.arguments && fc.arguments !== rawArgs ? fc.arguments : rawArgs;
          args = safeJsonParse(authoritative, {}) as Record<string, unknown>;
        }
        // Tool arguments are always JSON objects; a polluted buffer or proxy
        // payload can parse/repair to an array/null/primitive, which would
        // otherwise flow through the cast into functionCall.args and break the
        // Record-spreading consumers downstream (geminiChat, sessionService).
        // Collapse anything else to {}, matching the sibling's guard.
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          // A delta buffer that *parsed* cleanly to a non-object (array/null/
          // primitive) never entered the catch branch, so the done item's
          // authoritative `arguments` string was never consulted. Try it here
          // too — the same fallback the catch branch applies — so a complete
          // valid payload on this same event isn't discarded, dispatching the
          // tool with {} when correct args were available.
          const authoritative =
            fc.arguments && fc.arguments !== rawArgs
              ? safeJsonParse<unknown>(fc.arguments, undefined)
              : undefined;
          args =
            authoritative &&
            typeof authoritative === 'object' &&
            !Array.isArray(authoritative)
              ? (authoritative as Record<string, unknown>)
              : {};
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
        error?: { code?: string; message?: string };
      };
      const errMsg = envelope.error
        ? `${envelope.error.code}: ${envelope.error.message}`
        : 'Response failed';
      throw makeResponsesStreamError(
        `Responses API failed: ${errMsg}`,
        envelope.error?.code,
      );
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
      const data = event.data as { message?: string; code?: string };
      throw makeResponsesStreamError(
        `Responses API error: ${data.message ?? 'Unknown error'}`,
        data.code,
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
    // cachedContentTokenCount is always materialized (`?? 0`), so without
    // provenance the logging layer's absent-vs-zero fallback
    // (loggingContentGenerator.usageSpanMetadata) would report a provider
    // cache measurement on every turn even when none was sent. Mirror the
    // Chat converter: record whether cached_tokens was actually present.
    setGenAiUsageProvenance(resp.usageMetadata, {
      cachedInputTokensReported:
        typeof usage.input_tokens_details?.cached_tokens === 'number',
    });
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

    // Text and image parts within one turn accumulate here and are flushed
    // as a single 'message' item with a multi-part content array, rather
    // than one 'message' item per part -- the Responses API treats separate
    // message items as separate turns, so a {text, inlineData} pair (e.g.
    // "What is in this image?" + the image) would otherwise become two
    // consecutive user turns the model may not associate with each other.
    // Flushed before any function_call/function_call_output/reasoning item
    // so relative ordering within the turn is preserved.
    let pendingContentParts: ResponsesApiContentPart[] = [];
    // Media attached to tool results (functionResponse.parts) is staged here
    // and flushed as one follow-up user message after all tool outputs in this
    // turn, so tool-returned images aren't silently dropped. Mirrors the Chat
    // converter's split-tool-media follow-up.
    const pendingToolMediaParts: ResponsesApiContentPart[] = [];
    const flushPendingMessage = () => {
      if (pendingContentParts.length === 0) return;
      const content: string | ResponsesApiContentPart[] =
        pendingContentParts.length === 1 &&
        pendingContentParts[0]!.type === 'input_text'
          ? pendingContentParts[0]!.text
          : pendingContentParts;
      items.push({ type: 'message', role, content } as ResponsesApiMessageItem);
      pendingContentParts = [];
    };

    for (const part of parts) {
      if (typeof part === 'string') {
        pendingContentParts.push({ type: 'input_text', text: part });
        continue;
      }

      if ('thought' in part && part.thought) {
        flushPendingMessage();
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
        pendingContentParts.push({ type: 'input_text', text: part.text });
      }

      if ('functionCall' in part && part.functionCall) {
        flushPendingMessage();
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
        flushPendingMessage();
        const fr = part.functionResponse;
        const responseRecord = fr.response as
          | Record<string, unknown>
          | null
          | undefined;
        let output: string;
        if (typeof fr.response === 'string') {
          output = fr.response;
        } else if (typeof responseRecord?.['output'] === 'string') {
          // Unwrap the { output } envelope coreToolScheduler wraps tool
          // results in (and { error } for failures), matching the sibling
          // Chat Completions converter -- sending the raw JSON envelope
          // instead double-encodes and quote-escapes tool output that is
          // itself JSON, and costs extra tokens on every turn.
          output = responseRecord['output'] as string;
        } else if (typeof responseRecord?.['error'] === 'string') {
          output = responseRecord['error'] as string;
        } else {
          output = JSON.stringify(fr.response ?? {});
        }
        // A tool can return media (e.g. read_file on an image) in
        // functionResponse.parts alongside its textual output. The
        // function_call_output.output field is string-only, so surface the
        // media the way the sibling Chat converter does
        // (createToolMessage/splitToolMedia) instead of dropping it: append
        // any text entries (e.g. compaction-slimmer placeholders) to the
        // output, and stage image entries for a follow-up user message.
        for (const frPart of fr.parts ?? []) {
          if (
            'text' in frPart &&
            typeof (frPart as { text?: unknown }).text === 'string' &&
            (frPart as { text: string }).text.length > 0
          ) {
            const text = (frPart as { text: string }).text;
            output += (output ? '\n' : '') + text;
          } else if (frPart.inlineData) {
            const mimeType = frPart.inlineData.mimeType;
            if (isSupportedResponseImageMime(mimeType)) {
              pendingToolMediaParts.push({
                type: 'input_image',
                image_url: `data:${mimeType};base64,${frPart.inlineData.data}`,
              });
            } else {
              const placeholderMime = placeholderMimeType(mimeType);
              debugLogger.warn(
                `Dropping unsupported tool-result inline media type: ${placeholderMime}`,
              );
              pendingToolMediaParts.push({
                type: 'input_text',
                text: `[Unsupported tool-result media type: ${placeholderMime}]`,
              });
            }
          } else if (frPart.fileData) {
            const placeholderMime = placeholderMimeType(
              frPart.fileData.mimeType,
            );
            debugLogger.warn(
              `Dropping unsupported tool-result file reference: ${placeholderMime}`,
            );
            pendingToolMediaParts.push({
              type: 'input_text',
              text: `[Unsupported tool-result file reference: ${placeholderMime}]`,
            });
          }
        }
        items.push({
          type: 'function_call_output',
          call_id: fr.id || `call_${Date.now()}_${callIdCounter++}`,
          output,
        } as ResponsesApiFunctionCallOutputItem);
      }

      if ('inlineData' in part && part.inlineData && role === 'user') {
        const mimeType = part.inlineData.mimeType;
        if (isSupportedResponseImageMime(mimeType)) {
          pendingContentParts.push({
            type: 'input_image',
            image_url: `data:${mimeType};base64,${part.inlineData.data}`,
          });
        } else {
          // No input_file part type is wired up for this generator yet
          // (unlike the sibling Chat Completions converter, which sends
          // PDFs as a file part) -- rather than silently dropping the
          // attachment with zero diagnostic, tell the model it was there
          // but isn't supported so a "summarize my PDF" prompt gets an
          // explanation instead of "I don't see a document".
          pendingContentParts.push({
            type: 'input_text',
            text: `[Unsupported inline media type: ${placeholderMimeType(mimeType)}]`,
          });
        }
      }

      if ('fileData' in part && part.fileData && role === 'user') {
        pendingContentParts.push({
          type: 'input_text',
          text: `[Unsupported file reference: ${placeholderMimeType(part.fileData.mimeType)}]`,
        });
      }
    }
    flushPendingMessage();
    if (pendingToolMediaParts.length > 0) {
      // Emitted after all function_call_output items in this turn so tool
      // outputs stay grouped; the model still sees tool-returned images.
      items.push({
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '(attached media from previous tool call)',
          },
          ...pendingToolMediaParts,
        ],
      } as ResponsesApiMessageItem);
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
          // Prefer parametersJsonSchema (raw JSON Schema, e.g. MCP/extension
          // tools) and fall back to parameters, matching the Chat and
          // Anthropic sibling wires — @google/genai allows both fields at
          // once, and preferring `parameters` here would send a different,
          // potentially lossier schema than the siblings for identical config.
          (func.parametersJsonSchema ?? func.parameters) as
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
