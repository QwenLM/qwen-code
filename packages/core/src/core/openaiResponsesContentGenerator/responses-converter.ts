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
  ResponsesApiTool,
  ResponsesApiContentPart,
  ResponsesApiImagePart,
  ResponsesApiAudioPart,
  ResponsesApiVideoPart,
} from './types.js';
import type { InputModalities } from '../contentGenerator.js';
import { sanitizeMimeForPlaceholder } from '../../services/compactionInputSlimming.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { safeJsonParse } from '../../utils/safeJsonParse.js';
import { setGenAiUsageProvenance } from '../../telemetry/gen-ai-usage.js';
import {
  createOpenAIReasoningThoughtPart,
  parseResponsesReasoningSignature,
  type ResponsesReasoningSignaturePayload,
} from '../../utils/thoughtUtils.js';
import {
  normalizeMediaMimeType,
  resolveAudioMimeAndFormat,
  stripBase64DataUriPrefix,
} from '../../utils/media-mime.js';
import { ToolNames } from '../../tools/tool-names.js';
import { REATTACH_BOUNDARY_METADATA } from '../../services/image-payload-references.js';
import type { ResponsesCacheBoundary } from './prompt-caching.js';
import {
  getResponsesMessage,
  type ResponsesMessageMetadata,
  type ResponsesTextPart,
} from '../../utils/responses-message.js';
import { followingCallGroup } from './responses-reasoning-rejection.js';
import {
  OPENAI_RESPONSES_DIALECT,
  type ResponsesWireDialect,
} from './responses-dialect.js';

const debugLogger = createDebugLogger('RESPONSES_CONVERTER');

const SUPPORTED_RESPONSE_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const SUPPORTED_RESPONSE_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/avi',
  'video/mpeg',
  'video/x-matroska',
  'video/mkv',
  'video/x-flv',
  'video/3gpp',
  'video/x-m4v',
]);

export interface ResponsesInputConversionOptions {
  modalities?: InputModalities;
  imageDetail?: 'low' | 'high' | 'auto';
  /**
   * Declarative wire capabilities for the target Responses endpoint.
   * Defaults to `OPENAI_RESPONSES_DIALECT` (strict OpenAI Responses spec).
   */
  dialect?: ResponsesWireDialect;
}

// Keep image MIME matching strict (exact lowercase allowlist) to preserve
// upstream's Responses image MIME allowlist contract.
function isSupportedResponseImageMime(
  mimeType: string | undefined,
): mimeType is string {
  return (
    mimeType !== undefined && SUPPORTED_RESPONSE_IMAGE_MIME_TYPES.has(mimeType)
  );
}

function resolveResponseVideoMime(
  mimeType: string | undefined,
): string | undefined {
  const normalized = normalizeMediaMimeType(mimeType);
  return normalized && SUPPORTED_RESPONSE_VIDEO_MIME_TYPES.has(normalized)
    ? normalized
    : undefined;
}

function isSupportedResponsesFileUri(
  uri: string | undefined,
  dialect: ResponsesWireDialect,
): uri is string {
  if (!uri) return false;
  const trimmed = uri.trim();
  if (trimmed.startsWith('oss://')) {
    return dialect.supportsOssResourceResolveHeader;
  }
  return (
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('data:')
  );
}

function buildResponsesImagePart(
  imageUrl: string,
  imageDetail?: 'low' | 'high' | 'auto',
): ResponsesApiImagePart {
  return imageDetail
    ? { type: 'input_image', image_url: imageUrl, detail: imageDetail }
    : { type: 'input_image', image_url: imageUrl };
}

type ResponsesMediaModality = 'image' | 'audio' | 'video';

type ResponsesMediaConversionResult =
  | {
      ok: true;
      part:
        | ResponsesApiImagePart
        | ResponsesApiAudioPart
        | ResponsesApiVideoPart;
    }
  | {
      ok: false;
      reason: 'unsupported_modality';
      modality: ResponsesMediaModality;
    }
  | {
      ok: false;
      reason: 'unsupported_mime';
    };

function convertInlineDataToResponsesPart(
  inlineData: NonNullable<Part['inlineData']>,
  options?: ResponsesInputConversionOptions,
): ResponsesMediaConversionResult {
  const mimeType = inlineData.mimeType;
  const rawData = inlineData.data ?? '';
  // Avoid rawData.trim() on potentially multi-MB base64 payloads: .trim()
  // allocates a full string copy, while !/\S/.test(rawData) stops on the first
  // non-whitespace character in O(1) with zero allocation.
  if (rawData.length === 0 || !/\S/.test(rawData)) {
    return { ok: false, reason: 'unsupported_mime' };
  }
  const dialect = options?.dialect ?? OPENAI_RESPONSES_DIALECT;

  if (isSupportedResponseImageMime(mimeType)) {
    if (options?.modalities && !options.modalities.image) {
      return { ok: false, reason: 'unsupported_modality', modality: 'image' };
    }
    const url = rawData.startsWith('data:')
      ? rawData
      : `data:${mimeType};base64,${rawData}`;
    return {
      ok: true,
      part: buildResponsesImagePart(url, options?.imageDetail),
    };
  }

  const audio = resolveAudioMimeAndFormat(mimeType);
  if (audio) {
    if (options?.modalities && !options.modalities.audio) {
      return { ok: false, reason: 'unsupported_modality', modality: 'audio' };
    }
    if (!dialect.inlineAudioFormats.has(audio.format)) {
      return { ok: false, reason: 'unsupported_mime' };
    }
    let data: string;
    if (dialect.inlineAudioEncoding === 'data_uri') {
      data = rawData.startsWith('data:')
        ? rawData
        : `data:${audio.mimeType};base64,${rawData}`;
    } else {
      data = stripBase64DataUriPrefix(rawData);
    }
    return {
      ok: true,
      part: {
        type: 'input_audio',
        format: audio.format,
        data,
      },
    };
  }

  const videoMime = resolveResponseVideoMime(mimeType);
  if (videoMime) {
    if (options?.modalities && !options.modalities.video) {
      return { ok: false, reason: 'unsupported_modality', modality: 'video' };
    }
    if (!dialect.supportsInputVideo) {
      return { ok: false, reason: 'unsupported_mime' };
    }
    const videoUrl = rawData.startsWith('data:')
      ? rawData
      : `data:${videoMime};base64,${rawData}`;
    return {
      ok: true,
      part: {
        type: 'input_video',
        video_url: videoUrl,
      },
    };
  }

  return { ok: false, reason: 'unsupported_mime' };
}

function convertFileDataToResponsesPart(
  fileData: NonNullable<Part['fileData']>,
  options?: ResponsesInputConversionOptions,
): ResponsesMediaConversionResult {
  const dialect = options?.dialect ?? OPENAI_RESPONSES_DIALECT;
  if (!isSupportedResponsesFileUri(fileData.fileUri, dialect)) {
    return { ok: false, reason: 'unsupported_mime' };
  }
  const uri = fileData.fileUri.trim();
  const mimeType = fileData.mimeType;

  if (isSupportedResponseImageMime(mimeType)) {
    if (options?.modalities && !options.modalities.image) {
      return { ok: false, reason: 'unsupported_modality', modality: 'image' };
    }
    return {
      ok: true,
      part: buildResponsesImagePart(uri, options?.imageDetail),
    };
  }

  const audio = resolveAudioMimeAndFormat(mimeType);
  if (audio) {
    if (options?.modalities && !options.modalities.audio) {
      return { ok: false, reason: 'unsupported_modality', modality: 'audio' };
    }
    if (
      !dialect.supportsFileAudio ||
      !dialect.inlineAudioFormats.has(audio.format)
    ) {
      return { ok: false, reason: 'unsupported_mime' };
    }
    if (uri.startsWith('data:')) {
      const data =
        dialect.inlineAudioEncoding === 'data_uri'
          ? uri
          : stripBase64DataUriPrefix(uri);
      return {
        ok: true,
        part: { type: 'input_audio', format: audio.format, data },
      };
    }
    return {
      ok: true,
      part: { type: 'input_audio', format: audio.format, audio_url: uri },
    };
  }

  const videoMime = resolveResponseVideoMime(mimeType);
  if (videoMime) {
    if (options?.modalities && !options.modalities.video) {
      return { ok: false, reason: 'unsupported_modality', modality: 'video' };
    }
    if (!dialect.supportsInputVideo) {
      return { ok: false, reason: 'unsupported_mime' };
    }
    return {
      ok: true,
      part: {
        type: 'input_video',
        video_url: uri,
      },
    };
  }

  return { ok: false, reason: 'unsupported_mime' };
}

function placeholderMimeType(mimeType: string | undefined): string {
  const sanitized = mimeType ? sanitizeMimeForPlaceholder(mimeType) : '';
  return sanitized || 'unknown mime type';
}

function unsupportedModalityPlaceholder(
  modality: ResponsesMediaModality,
  displayName: string | undefined,
  mimeType: string | undefined,
  model: string,
): ResponsesApiContentPart {
  const label = placeholderMimeType(displayName || mimeType);
  debugLogger.warn(
    `Model '${model}' does not support ${modality} input. Replacing with text placeholder: ${label}`,
  );
  return {
    type: 'input_text',
    text: `[Unsupported ${modality} file: "${label}". This model does not support ${modality} input. The read_file tool cannot process this type of file either. To handle this file, try using skills if applicable, or any tools installed at system wide, or let the user know you cannot process this type of file.]`,
  };
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
  type?: string;
}

function makeResponsesStreamError(
  message: string,
  code?: string,
  type?: string,
): ResponsesStreamError {
  const err: ResponsesStreamError = new Error(message);
  err.type = type ?? code;
  if (code) {
    err.code = code;
    const status = RESPONSES_ERROR_CODE_TO_STATUS[code];
    if (status !== undefined) err.status = status;
  }
  return err;
}

function encodeReasoningSignature(
  payload: ResponsesReasoningSignaturePayload,
): string {
  return JSON.stringify(payload);
}

/**
 * Tracks accumulated state for a single streaming response from the
 * Responses API. A new instance should be created per response stream.
 */
export class ResponsesStreamState {
  responseId: string | null = null;
  private messages = new Map<number, ResponsesMessageMetadata>();
  private reasoningItemIds = new Map<number, string>();
  private reasoningChannels = new Map<
    string,
    'reasoning_text' | 'summary_text'
  >();

  registerReasoningItem(outputIndex: number, id?: string): void {
    if (id) {
      this.reasoningItemIds.set(outputIndex, id);
    }
  }

  private reasoningKey(data: {
    output_index?: number;
    item_id?: string;
  }): string {
    if (data.item_id) return `id:${data.item_id}`;
    if (data.output_index !== undefined) {
      const knownId = this.reasoningItemIds.get(data.output_index);
      return knownId ? `id:${knownId}` : `idx:${data.output_index}`;
    }
    return 'default';
  }

  /**
   * Claims a single reasoning stream channel (`reasoning_text` or
   * `summary_text`) per reasoning output item. Returns `false` if the other
   * channel already streamed for the same item so dual-channel proxies never
   * double-count reasoning text.
   */
  claimReasoningChannel(
    data: { output_index?: number; item_id?: string },
    channel: 'reasoning_text' | 'summary_text',
  ): boolean {
    const key = this.reasoningKey(data);
    const existing = this.reasoningChannels.get(key);
    if (existing && existing !== channel) {
      return false;
    }
    this.reasoningChannels.set(key, channel);
    return true;
  }

  getReasoningChannel(
    outputIndex: number,
    itemId?: string,
  ): 'reasoning_text' | 'summary_text' | undefined {
    if (itemId) {
      const byId = this.reasoningChannels.get(`id:${itemId}`);
      if (byId) return byId;
    }
    return this.reasoningChannels.get(`idx:${outputIndex}`);
  }

  /**
   * Resolve the streamed reasoning channel for a completing reasoning item.
   * Consumes the unkeyed `'default'` slot at most once (binding it to this
   * item) so an earlier delta that omitted `item_id`/`output_index` cannot
   * falsely mark a later reasoning item as already streamed.
   */
  consumeReasoningChannel(
    outputIndex: number,
    itemId?: string,
  ): 'reasoning_text' | 'summary_text' | undefined {
    const keyed = this.getReasoningChannel(outputIndex, itemId);
    if (keyed) {
      this.reasoningChannels.delete('default');
      return keyed;
    }
    const fallback = this.reasoningChannels.get('default');
    if (fallback) {
      this.reasoningChannels.delete('default');
      this.reasoningChannels.set(
        itemId ? `id:${itemId}` : `idx:${outputIndex}`,
        fallback,
      );
      return fallback;
    }
    return undefined;
  }

  updateMessage(index: number, item: { id: string; phase?: string }): void {
    const metadata = this.messages.get(index) ?? { id: item.id };
    if (item.phase === 'commentary' || item.phase === 'final_answer') {
      metadata.phase = item.phase;
    }
    this.messages.set(index, metadata);
  }

  textPart(data: {
    delta: string;
    output_index?: number;
    item_id?: string;
  }): Part {
    if (
      data.output_index !== undefined &&
      data.item_id &&
      !this.messages.has(data.output_index)
    ) {
      this.updateMessage(data.output_index, { id: data.item_id });
    }
    const metadata =
      data.output_index === undefined
        ? undefined
        : this.messages.get(data.output_index);
    const part: ResponsesTextPart = { text: data.delta };
    if (metadata) part.responsesMessage = metadata;
    return part;
  }
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
      } else if (data.item.type === 'message') {
        state.updateMessage(data.output_index, data.item);
      } else if (data.item.type === 'reasoning') {
        state.registerReasoningItem(data.output_index, data.item.id);
      }
      return null;
    }

    case 'response.output_text.delta': {
      const data = event.data as {
        delta: string;
        output_index?: number;
        item_id?: string;
      };
      return makeChunkResponse(model, state, [state.textPart(data)]);
    }

    case 'response.refusal.delta': {
      // A model refusal streams as refusal.delta frames rather than
      // output_text.delta. Surface it as ordinary text (mirroring
      // output_text.delta) so the user sees the refusal instead of geminiChat
      // throwing InvalidStreamError('...empty response text.') and retrying
      // the full prompt transientMaxRetries times.
      const data = event.data as {
        delta: string;
        output_index?: number;
        item_id?: string;
      };
      return makeChunkResponse(model, state, [state.textPart(data)]);
    }

    case 'response.refusal.done':
      // The full refusal already streamed via refusal.delta frames; the done
      // frame is terminal only, exactly as output_text.done is treated.
      return null;

    case 'response.reasoning_text.delta': {
      const data = event.data as {
        delta: string;
        output_index?: number;
        item_id?: string;
      };
      if (!state.claimReasoningChannel(data, 'reasoning_text')) {
        return null;
      }
      return makeChunkResponse(model, state, [
        createOpenAIReasoningThoughtPart(data.delta),
      ]);
    }

    case 'response.reasoning_summary_text.delta': {
      const data = event.data as {
        delta: string;
        output_index?: number;
        item_id?: string;
      };
      if (!state.claimReasoningChannel(data, 'summary_text')) {
        return null;
      }
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
      if (data.item.type === 'message') {
        state.updateMessage(data.output_index, data.item);
        return null;
      }
      if (data.item.type === 'custom_tool_call') {
        return makeChunkResponse(model, state, [
          {
            functionCall: {
              id: data.item.call_id,
              name: data.item.name,
              args: { source: data.item.input },
            },
          },
        ]);
      }
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
        if (encryptedContent) {
          // NOTE: a single turn can contain multiple reasoning output items
          // (e.g. one per parallel function call), each emitted here as its own
          // signature-only chunk. llm-chat.ts's thought-episode consolidation
          // concatenates thoughtSignature chunks until one parses as a complete
          // Responses signature, so the items' encrypted_content folds into the
          // surviving episode in emission order.
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
        // Some OpenAI-compatible Responses endpoints return plaintext
        // reasoning items without encrypted_content: `{ type: 'reasoning', id,
        // status: 'completed', summary: [], content: [{ type: 'reasoning_text',
        // text }] }`. Capture the server item id whenever plaintext reasoning
        // content was returned or streamed via `response.reasoning_text.delta`
        // (never for OpenAI `summary_text`-only items without
        // encrypted_content).
        const streamedChannel = state.consumeReasoningChannel(
          data.output_index,
          reasoningItem.id,
        );
        const alreadyStreamed = streamedChannel === 'reasoning_text';
        const plaintextChunks = Array.isArray(reasoningItem.content)
          ? reasoningItem.content
              .filter(
                (entry) =>
                  entry?.type === 'reasoning_text' &&
                  typeof entry.text === 'string' &&
                  entry.text.length > 0,
              )
              .map((entry) => entry.text)
          : [];
        if (
          reasoningItem.id &&
          (plaintextChunks.length > 0 || streamedChannel === 'reasoning_text')
        ) {
          const thoughtSignature = encodeReasoningSignature({
            id: reasoningItem.id,
            plaintext: true,
          });
          const part: Part = alreadyStreamed
            ? { thought: true, thoughtSignature }
            : Object.assign(
                createOpenAIReasoningThoughtPart(plaintextChunks.join('')),
                { thoughtSignature },
              );
          return makeChunkResponse(model, state, [part]);
        }
        return null;
      }
      return null;
    }

    case 'response.completed': {
      const raw = event.data as Record<string, unknown>;
      const output = (
        (raw['response'] ?? raw) as { output?: ResponsesApiOutputItem[] }
      ).output;
      output?.forEach((item, index) => {
        if (item.type === 'message') state.updateMessage(index, item);
      });
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
        error?: { code?: string; message?: string; type?: string };
      };
      const errMsg = envelope.error
        ? `${envelope.error.code}: ${envelope.error.message}`
        : 'Response failed';
      throw makeResponsesStreamError(
        `Responses API failed: ${errMsg}`,
        envelope.error?.code,
        envelope.error?.type,
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
        output?: ResponsesApiOutputItem[];
      };
      envelope.output?.forEach((item, index) => {
        if (item.type === 'message') state.updateMessage(index, item);
      });
      if (envelope.id) state.responseId = envelope.id;
      return makeFinalResponse(
        model,
        state,
        envelope.usage,
        envelope.incomplete_details?.reason ?? 'max_output_tokens',
      );
    }

    case 'error': {
      const data = event.data as {
        message?: string;
        code?: string;
        error?: { message?: string; code?: string; type?: string };
      };
      const code = data.error?.code ?? data.code;
      const message = data.error?.message ?? data.message;
      const detail =
        [code, message].filter(Boolean).join(': ') ||
        data.error?.type ||
        'Unknown error';
      throw makeResponsesStreamError(
        `Responses API error: ${detail}`,
        code,
        data.error?.type,
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
  freeformExec = false,
  options?: ResponsesInputConversionOptions,
): {
  instructions: string | undefined;
  input: ResponsesApiInputItem[];
  cacheBoundary?: ResponsesCacheBoundary;
} {
  let instructions: string | undefined;
  let cacheBoundary: ResponsesCacheBoundary | undefined;
  const items: ResponsesApiInputItem[] = [];
  let callIdCounter = 0;
  const customCallIds = new Set<string>();

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
    let pendingMessage: ResponsesMessageMetadata | undefined;
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
      items.push({
        type: 'message',
        role,
        content,
        ...(role === 'assistant' && pendingMessage?.phase
          ? { phase: pendingMessage.phase }
          : {}),
      } as ResponsesApiMessageItem);
      pendingContentParts = [];
      pendingMessage = undefined;
    };

    for (const part of parts) {
      if (typeof part === 'string') {
        if (pendingMessage) flushPendingMessage();
        pendingContentParts.push({ type: 'input_text', text: part });
        continue;
      }

      if (
        role === 'user' &&
        part.partMetadata?.[REATTACH_BOUNDARY_METADATA] === true &&
        !cacheBoundary
      ) {
        cacheBoundary = pendingContentParts.length
          ? {
              itemIndex: items.length,
              contentIndex: pendingContentParts.length - 1,
            }
          : { itemIndex: items.length - 1 };
      }

      if ('thought' in part && part.thought) {
        flushPendingMessage();
        // Prior-turn reasoning replays in three distinct modes:
        // 1. OpenAI encrypted reasoning (`{ id, encrypted_content }`) -> replay
        //    as an encrypted `reasoning` item.
        // 2. Verified plaintext reasoning (`{ id, plaintext: true }`, from
        //    OpenAI-compatible Responses endpoints without encrypted_content)
        //    -> replay as a plaintext `reasoning` item with the exact server
        //    `id` and `reasoning_text` content.
        // 3. Missing or foreign signature (older history, OpenAI without
        //    encrypted_content, or cross-provider Gemini/Anthropic history) ->
        //    fall back to a plain assistant message rather than fabricating a
        //    synthetic `reasoning` item that OpenAI `/v1/responses` (`store:
        //    false`) would reject with HTTP 400.
        if (role === 'assistant') {
          const payload = parseResponsesReasoningSignature(
            part.thoughtSignature,
          );
          if (payload && 'encrypted_content' in payload) {
            items.push({
              type: 'reasoning',
              id: payload.id,
              encrypted_content: payload.encrypted_content,
              summary: part.text
                ? [{ type: 'summary_text', text: part.text }]
                : [],
            });
          } else if (
            payload &&
            'plaintext' in payload &&
            (options?.dialect ?? OPENAI_RESPONSES_DIALECT)
              .supportsPlaintextReasoningReplay
          ) {
            if (part.text) {
              items.push({
                type: 'reasoning',
                id: payload.id,
                status: 'completed',
                summary: [],
                content: [{ type: 'reasoning_text', text: part.text }],
              });
            }
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
        const metadata =
          role === 'assistant' ? getResponsesMessage(part) : undefined;
        if (
          pendingMessage?.id !== metadata?.id ||
          pendingMessage?.phase !== metadata?.phase
        ) {
          flushPendingMessage();
        }
        pendingMessage = metadata;
        pendingContentParts.push({ type: 'input_text', text: part.text });
      }

      if ('functionCall' in part && part.functionCall) {
        flushPendingMessage();
        const callId =
          part.functionCall.id || `call_${Date.now()}_${callIdCounter++}`;
        const fc = part.functionCall;
        if (freeformExec && fc.name === ToolNames.EXEC) {
          customCallIds.add(callId);
          items.push({
            type: 'custom_tool_call',
            call_id: callId,
            name: fc.name,
            input:
              typeof fc.args?.['source'] === 'string'
                ? fc.args['source']
                : JSON.stringify(fc.args ?? {}),
          });
        } else {
          items.push({
            type: 'function_call',
            call_id: callId,
            name: fc.name ?? '',
            arguments: JSON.stringify(fc.args ?? {}),
          } as ResponsesApiFunctionCallItem);
        }
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
        // A tool can return media (e.g. read_file on an image, audio, or video)
        // in functionResponse.parts alongside its textual output. Keep
        // `input_image` inline inside `function_call_output.output`, and
        // promote `input_audio` / `input_video` (as well as images on
        // string-only `custom_tool_call_output`) to a trailing `user` message
        // with a concise pointer in the tool output.
        const inlineToolImages: ResponsesApiContentPart[] = [];
        const promotedMediaNotes: string[] = [];
        const isCustomToolOutput =
          freeformExec &&
          (fr.name === ToolNames.EXEC || customCallIds.has(fr.id ?? ''));
        const promoteMediaPart = (
          mediaPart:
            | ResponsesApiImagePart
            | ResponsesApiAudioPart
            | ResponsesApiVideoPart,
        ): void => {
          if (mediaPart.type === 'input_image' && !isCustomToolOutput) {
            inlineToolImages.push(mediaPart);
            return;
          }
          pendingToolMediaParts.push(mediaPart);
          if (mediaPart.type === 'input_image') {
            promotedMediaNotes.push(
              '[Attached image media in following user message]',
            );
          } else if (mediaPart.type === 'input_audio') {
            promotedMediaNotes.push(
              '[Attached audio media in following user message]',
            );
          } else if (mediaPart.type === 'input_video') {
            promotedMediaNotes.push(
              '[Attached video media in following user message]',
            );
          }
        };

        for (const frPart of fr.parts ?? []) {
          if (
            'text' in frPart &&
            typeof (frPart as { text?: unknown }).text === 'string' &&
            (frPart as { text: string }).text.length > 0
          ) {
            const text = (frPart as { text: string }).text;
            output += (output ? '\n' : '') + text;
          } else if (frPart.inlineData) {
            const converted = convertInlineDataToResponsesPart(
              frPart.inlineData,
              options,
            );
            if (converted.ok) {
              promoteMediaPart(converted.part);
            } else if (converted.reason === 'unsupported_modality') {
              pendingToolMediaParts.push(
                unsupportedModalityPlaceholder(
                  converted.modality,
                  frPart.inlineData.displayName,
                  frPart.inlineData.mimeType,
                  request.model,
                ),
              );
            } else {
              const placeholderMime = placeholderMimeType(
                frPart.inlineData.mimeType,
              );
              debugLogger.warn(
                `Dropping unsupported tool-result inline media type: ${placeholderMime}`,
              );
              pendingToolMediaParts.push({
                type: 'input_text',
                text: `[Unsupported tool-result media type: ${placeholderMime}]`,
              });
            }
          } else if (frPart.fileData) {
            const converted = convertFileDataToResponsesPart(
              frPart.fileData,
              options,
            );
            if (converted.ok) {
              promoteMediaPart(converted.part);
            } else if (converted.reason === 'unsupported_modality') {
              pendingToolMediaParts.push(
                unsupportedModalityPlaceholder(
                  converted.modality,
                  frPart.fileData.displayName,
                  frPart.fileData.mimeType,
                  request.model,
                ),
              );
            } else {
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
        }

        if (promotedMediaNotes.length > 0) {
          const noteText = promotedMediaNotes.join('\n');
          output += (output ? '\n' : '') + noteText;
        }

        const callId = fr.id || `call_${Date.now()}_${callIdCounter++}`;
        if (isCustomToolOutput) {
          items.push({
            type: 'custom_tool_call_output',
            call_id: callId,
            output,
          });
        } else if (inlineToolImages.length > 0) {
          const outputParts: ResponsesApiContentPart[] = [];
          if (output) {
            outputParts.push({ type: 'input_text', text: output });
          }
          outputParts.push(...inlineToolImages);
          items.push({
            type: 'function_call_output',
            call_id: callId,
            output: outputParts,
          });
        } else {
          items.push({
            type: 'function_call_output',
            call_id: callId,
            output,
          });
        }
      }

      if ('inlineData' in part && part.inlineData && role === 'user') {
        const converted = convertInlineDataToResponsesPart(
          part.inlineData,
          options,
        );
        if (converted.ok) {
          pendingContentParts.push(converted.part);
        } else if (converted.reason === 'unsupported_modality') {
          pendingContentParts.push(
            unsupportedModalityPlaceholder(
              converted.modality,
              part.inlineData.displayName,
              part.inlineData.mimeType,
              request.model,
            ),
          );
        } else {
          // No input_file part type is wired up for this generator yet
          // (unlike the sibling Chat Completions converter, which sends
          // PDFs as a file part) -- rather than silently dropping the
          // attachment with zero diagnostic, tell the model it was there
          // but isn't supported so a "summarize my PDF" prompt gets an
          // explanation instead of "I don't see a document".
          pendingContentParts.push({
            type: 'input_text',
            text: `[Unsupported inline media type: ${placeholderMimeType(part.inlineData.mimeType)}]`,
          });
        }
      }

      if ('fileData' in part && part.fileData && role === 'user') {
        const converted = convertFileDataToResponsesPart(
          part.fileData,
          options,
        );
        if (converted.ok) {
          pendingContentParts.push(converted.part);
        } else if (converted.reason === 'unsupported_modality') {
          pendingContentParts.push(
            unsupportedModalityPlaceholder(
              converted.modality,
              part.fileData.displayName,
              part.fileData.mimeType,
              request.model,
            ),
          );
        } else {
          pendingContentParts.push({
            type: 'input_text',
            text: `[Unsupported file reference: ${placeholderMimeType(part.fileData.mimeType)}]`,
          });
        }
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

  return { instructions, input: items, cacheBoundary };
}

/**
 * Remove any function/custom tool call or output whose `call_id` has
 * no matching counterpart in the input array. This prevents the Responses
 * API from rejecting the request over a broken call/output pair.
 *
 * Root cause: server-side truncation or context budget trimming can break a
 * function_call / function_call_output pair in either direction — keeping
 * the call while dropping the output, or vice versa. This safety net ensures
 * the wire request is always structurally valid regardless of upstream
 * trimming bugs.
 *
 * A reasoning item heads the call group (`function_call` or
 * `custom_tool_call`) that follows it, so the
 * reasoning and that group are one unit (#11665): the reasoning stays iff at
 * least one call in its group survives the pair cleanup, and goes with the
 * group when none do. Dropping every orphaned call while keeping the group's
 * reasoning would send reasoning without its required following item;
 * keeping the reasoning while only some of its calls survive is what the
 * surviving calls still need.
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
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      callIds.add(`${item.type}:${item.call_id}`);
    } else if (
      item.type === 'function_call_output' ||
      item.type === 'custom_tool_call_output'
    ) {
      outputCallIds.add(`${item.type}:${item.call_id}`);
    }
  }
  const kept: ResponsesApiInputItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item !== 'object' || item === null || !('type' in item)) {
      kept.push(item);
      continue;
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (outputCallIds.has(`${item.type}_output:${item.call_id}`)) {
        kept.push(item);
      }
      continue;
    }
    if (item.type === 'function_call_output') {
      if (callIds.has(`function_call:${item.call_id}`)) {
        kept.push(item);
      }
      continue;
    }
    if (item.type === 'custom_tool_call_output') {
      if (callIds.has(`custom_tool_call:${item.call_id}`)) {
        kept.push(item);
      }
      continue;
    }
    if (item.type === 'reasoning') {
      const unitCalls = followingCallGroup(items, i);
      if (
        unitCalls.length > 0 &&
        !unitCalls.some((call) =>
          outputCallIds.has(`${call.type}_output:${call.callId}`),
        )
      ) {
        // The group is gone, so its whole head goes: the maximal run of
        // consecutive reasoning items immediately preceding the call run.
        // Each was pushed with an empty run of its own, because the scan
        // breaks on the next reasoning item.
        while (kept.length > 0) {
          const tail = kept[kept.length - 1];
          if (
            typeof tail !== 'object' ||
            tail === null ||
            !('type' in tail) ||
            tail.type !== 'reasoning'
          ) {
            break;
          }
          kept.pop();
        }
        continue;
      }
      kept.push(item);
      continue;
    }
    kept.push(item);
  }
  return kept;
}

export function convertGeminiToolsToResponsesTools(
  request: GenerateContentParameters,
  freeformExec = false,
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
      if (freeformExec && func.name === ToolNames.EXEC) {
        result.push({
          type: 'custom',
          name: func.name,
          description: `${func.description ?? ''}\nPass raw JavaScript source as the tool input, without JSON wrapping or Markdown fences.`,
          format: { type: 'text' },
        });
        continue;
      }
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
 *
 * Explicitly preserve JSON Schema's default openness for patched nested
 * objects. Whether a Responses backend interpreted the implicit default as
 * closed in #12889 remains unverified. Keep the existing root-object patch
 * and any explicit additionalProperties constraint unchanged.
 */
export function normalizeResponsesParameters(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (schema === undefined) return undefined;
  if (schema === null || typeof schema !== 'object') return schema;
  return normalizeResponsesSchemaNode(schema, true) as Record<string, unknown>;
}

function normalizeResponsesSchemaNode(node: unknown, isRoot = false): unknown {
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
    if (!isRoot && out['additionalProperties'] === undefined) {
      out['additionalProperties'] = true;
    }
  }

  return out;
}
