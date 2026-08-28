/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GenerateContentParameters,
  Part,
  Content,
  Tool,
  ToolListUnion,
  CallableTool,
  FunctionResponse,
  ContentListUnion,
  ContentUnion,
  PartUnion,
  Candidate,
} from '@google/genai';
import { GenerateContentResponse, FinishReason } from '@google/genai';
import type OpenAI from 'openai';
import { safeJsonParse } from '../../utils/safeJsonParse.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { createOpenAIReasoningThoughtPart } from '../../utils/thoughtUtils.js';
import {
  estimateTextTokens,
  estimateTextTokenUnits,
  TOKEN_ESTIMATE_UNITS_PER_TOKEN,
} from '../../utils/request-tokenizer/textTokenizer.js';
import type { RequestContext, StreamingTextDeltaState } from './types.js';
import { parseTaggedThinkingText } from './taggedThinkingParser.js';
import {
  convertSchema,
  relaxSchemaForFunctionCalling,
  type SchemaComplianceMode,
} from '../../utils/schemaConverter.js';
import {
  setToolCallPreparations,
  type ToolCallPreparation,
} from '../tool-call-preparation.js';
import { InvalidStreamError } from '../invalid-stream-error.js';
import { normalizeMcpToolName } from '../../utils/tool-name-utils.js';
import { setGenAiUsageProvenance } from '../../telemetry/gen-ai-usage.js';

const debugLogger = createDebugLogger('CONVERTER');
const SPLIT_TOOL_MEDIA_TEXT = '(attached media from previous tool call)';

/**
 * Extended usage type that supports both OpenAI standard format and alternative formats
 * Some models return cached_tokens at the top level instead of in prompt_tokens_details
 */
interface ExtendedCompletionUsage extends OpenAI.CompletionUsage {
  cached_tokens?: number;
}

export interface ExtendedChatCompletionAssistantMessageParam
  extends OpenAI.Chat.ChatCompletionAssistantMessageParam {
  reasoning_content?: string | null;
}

type ExtendedChatCompletionMessageParam =
  | OpenAI.Chat.ChatCompletionMessageParam
  | ExtendedChatCompletionAssistantMessageParam;

export interface ExtendedCompletionMessage
  extends OpenAI.Chat.ChatCompletionMessage {
  reasoning_content?: string | null;
  reasoning?: string | null;
}

export interface ExtendedCompletionChunkDelta
  extends OpenAI.Chat.ChatCompletionChunk.Choice.Delta {
  reasoning_content?: string | null;
  reasoning?: string | null;
}

// Threshold for treating an exact-repeat chunk as a cumulative marker rather
// than legitimate repeated content. Cumulative providers replay the entire
// accumulated buffer (typically hundreds of bytes) on each re-send, while
// legitimate repeats in real output (duplicated import lines, repeated short
// boilerplate like "</div>\n</div>", repeated emoji sequences) are usually
// well under this threshold. 64 sits comfortably above realistic legit-repeat
// lengths while remaining far below any practical cumulative-buffer replay,
// so it preserves catch-rate without silently suppressing legitimate chunks.
const CUMULATIVE_DELTA_EXACT_REPEAT_MIN_LENGTH = 64;

// Once this many bytes have been emitted without entering cumulative mode the
// stream is almost certainly a standard incremental provider. Stop growing
// emittedText beyond this point to bound per-stream memory and CPU. The true
// emitted total is preserved separately in `state.emittedLength` so a late
// transition into cumulative mode still slices the correct suffix.
const CUMULATIVE_DETECTION_WINDOW_BYTES = 1024;

/**
 * Some OpenAI-compatible providers (e.g. DashScope) send the entire
 * accumulated content in each `delta.content` field instead of incremental
 * suffixes. Normalize that shape to incremental suffixes before the Gemini
 * stream layer appends it to the live transcript.
 *
 * State invariants and lifecycle:
 * - `state` is per-stream and per-channel — the content and reasoning
 *   channels are tracked independently to avoid cross-contamination. State
 *   MUST NOT be shared or reused across requests; stale state will silently
 *   corrupt text output.
 * - In cumulative mode `state.emittedText` retains the full accumulated text
 *   for the request lifetime (worst case: ~final response size, e.g. ~100KB
 *   for a long answer). This is single-request scoped and bounded by request
 *   completion. A future optimization could retain only the last N bytes once
 *   cumulative mode is firmly established, but is not required today.
 * - In non-cumulative mode `state.emittedText` is capped at
 *   CUMULATIVE_DETECTION_WINDOW_BYTES; `state.emittedLength` tracks the true
 *   user-visible total separately so a late transition into cumulative mode
 *   still produces the correct suffix.
 * - The "exit cumulative" path is a verbatim-emit path with no overlap
 *   reconciliation: the diverged chunk is assumed to be fully fresh content.
 *   Cumulative providers that emit a half-overlapping chunk on exit (not
 *   observed on DashScope-class providers) would produce visible duplication
 *   on the overlap.
 */
function normalizeStreamingTextDelta(
  rawDelta: string,
  state: StreamingTextDeltaState,
): string {
  // Per-call regime signal for the guard zone: true only when this delta is
  // emitted verbatim by one of the tag-hold guards below (prefix overlap or
  // exact repeat against the baseline while a pre-demotion opening-shaped
  // candidate is held). A delta on that path is a cumulative re-send of the
  // held block's bytes until proven otherwise, while the identical shape on
  // any other path is genuinely fresh content — content comparison alone
  // cannot tell them apart (issue #9348 R11-2).
  state.tagHoldVerbatimEmission = false;
  if (rawDelta.length === 0) {
    return '';
  }

  if (state.emittedText.length === 0) {
    state.emittedText = rawDelta;
    state.emittedLength = rawDelta.length;
    return rawDelta;
  }

  if (state.cumulativeMode) {
    if (rawDelta.startsWith(state.emittedText)) {
      if (
        state.tagHoldActive &&
        OPENING_THINKING_TAG_WORD_PATTERN.test(rawDelta)
      ) {
        // A prefix-overlapping chunk arriving while the converter holds a
        // pre-demotion opening-tag candidate may be genuine incremental
        // content whose leading bytes coincidentally repeat the baseline —
        // e.g. a nested '<thinking>' arriving as its own delta is
        // undecidable from a cumulative re-send of the held bytes by
        // prefix comparison alone. Slicing the overlap would silently
        // consume the nested opener before the guard zone ever sees it,
        // corrupting a real thinking block chunking-dependently, so emit
        // the chunk verbatim instead. A true cumulative rewind then
        // degrades to duplicated content inside the hidden thought
        // channel, which the depth-counting scanner absorbs, rather than
        // failing a legitimate turn (issue #9348 R8-1).
        state.tagHoldVerbatimEmission = true;
        state.emittedText = rawDelta;
        state.emittedLength = rawDelta.length;
        return rawDelta;
      }
      const suffix = rawDelta.slice(state.emittedText.length);
      state.emittedText = rawDelta;
      state.emittedLength = rawDelta.length;
      return suffix;
    }

    if (state.emittedText.startsWith(rawDelta)) {
      debugLogger.debug(
        `normalizeStreamingTextDelta: cumulative rewind suppression (emitted=${state.emittedText.length}b, chunk=${rawDelta.length}b)`,
      );
      return '';
    }

    debugLogger.debug(
      'normalizeStreamingTextDelta: exiting cumulative mode (chunk does not match prior accumulated text)',
    );
    state.cumulativeMode = false;
    // Reset baseline to current chunk so future prefix checks use fresh state.
    // Note: this is a verbatim-emit path with no overlap reconciliation — the
    // diverged chunk is assumed to be fully fresh content. If a cumulative
    // provider were to emit a half-overlapping chunk on exit (rare; not
    // observed on DashScope-class providers) the overlap would be visible.
    state.emittedText = rawDelta;
    state.emittedLength += rawDelta.length;
    return rawDelta;
  }

  if (
    rawDelta.length > state.emittedText.length &&
    rawDelta.startsWith(state.emittedText)
  ) {
    if (
      state.tagHoldActive &&
      OPENING_THINKING_TAG_WORD_PATTERN.test(rawDelta)
    ) {
      // Held-candidate twin of the cumulative-mode guard above: the overlap
      // being sliced is the still-held candidate's bytes, which were never
      // emitted to the user, so a chunk re-starting with them while
      // carrying a full opening tag word is undecidable between a
      // cumulative re-send and genuine new content (a nested opener).
      // Emit it verbatim; the guard zone recombines it with the held
      // candidate and the depth-counting scanner absorbs any duplication
      // a true rewind introduces (issue #9348 R8-1).
      //
      // emittedLength is ASSIGNED, not accumulated (matching the
      // cumulative-mode twin above): emittedText is replaced with the full
      // chunk, so the cap can never apply to it, and the overlap bytes (the
      // held candidate) were already counted when first normalized.
      // Accumulating them again would inflate emittedLength beyond the
      // chunk length once the snapshot reaches the detection window, making
      // baselineFrozenAtCap fire on the next cumulative transition and
      // over-slice or re-emit the whole cumulative text (issue #9348 R11-3).
      state.tagHoldVerbatimEmission = true;
      state.emittedText = rawDelta;
      state.emittedLength = rawDelta.length;
      return rawDelta;
    }
    const baselineLen = state.emittedText.length;
    // The baseline may have been frozen at CUMULATIVE_DETECTION_WINDOW_BYTES
    // during a long incremental phase. If the cap actually kicked in and the
    // real emitted total exceeds the (frozen) baseline, slice the suffix from
    // the real total so an incremental-then-cumulative hybrid stream doesn't
    // re-emit bytes the user already saw between the cap and the true total.
    // Outside that hybrid-after-cap case, use the baseline so the historical
    // short-repeat-then-extend behaviour is preserved (the baseline is kept
    // unmodified across short exact repeats specifically to support that
    // case).
    const baselineFrozenAtCap =
      baselineLen >= CUMULATIVE_DETECTION_WINDOW_BYTES &&
      state.emittedLength > baselineLen;
    const sliceFrom = baselineFrozenAtCap ? state.emittedLength : baselineLen;
    if (rawDelta.length > sliceFrom) {
      const suffix = rawDelta.slice(sliceFrom);
      state.emittedText = rawDelta;
      state.emittedLength = rawDelta.length;
      state.cumulativeMode = true;
      debugLogger.debug(
        `normalizeStreamingTextDelta: entered cumulative mode (prefix overlap, baseline=${baselineLen}b sliceFrom=${sliceFrom}b -> curr=${rawDelta.length}b)`,
      );
      return suffix;
    }
    // rawDelta startsWith baseline but isn't strictly longer than sliceFrom.
    // Only reachable in the baselineFrozenAtCap branch when the cumulative
    // chunk is shorter than the real emitted total (a cumulative-rewind-like
    // shape during the transition). Treat as a no-op: don't enter cumulative
    // mode here, fall through to the rewind/passthrough branches below.
  }

  if (rawDelta === state.emittedText) {
    if (
      state.tagHoldActive &&
      OPENING_THINKING_TAG_WORD_PATTERN.test(rawDelta)
    ) {
      // Tag-hold twin of the prefix-overlap guards above: pre-demotion the
      // held candidate's bytes ARE the baseline, so a delta byte-equal to
      // the baseline is undecidable between the held snapshot's cumulative
      // re-send and a genuine nested re-spell of the candidate (a nested
      // block restarting with the candidate's bytes, arriving as its own
      // delta). Suppressing it here as an ordinary exact repeat would lose
      // the genuine nested opener before the guard zone ever sees it — the
      // block never balances and the turn fails closed mid-stream,
      // chunking-dependently against the single-chunk twin. Emit it
      // verbatim with the regime signal and let the guard zone carry the
      // decision: its equality entrance appends an opening-word equal
      // re-send regardless of regime, the same pinned R8-1 horn the
      // sub-64-byte short exact repeat below already rides (issue #9348).
      state.tagHoldVerbatimEmission = true;
      state.emittedLength += rawDelta.length;
      return rawDelta;
    }
    if (rawDelta.length >= CUMULATIVE_DELTA_EXACT_REPEAT_MIN_LENGTH) {
      state.cumulativeMode = true;
      debugLogger.debug(
        `normalizeStreamingTextDelta: entered cumulative mode (exact repeat, ${rawDelta.length}b)`,
      );
      return '';
    }
    // Short exact repeat: don't mutate emittedText so it remains a valid
    // prefix baseline for the next prefix-overlap check. The chunk is still
    // emitted verbatim, so bump emittedLength to track user-visible bytes.
    state.emittedLength += rawDelta.length;
    return rawDelta;
  }

  if (state.emittedText.length < CUMULATIVE_DETECTION_WINDOW_BYTES) {
    state.emittedText += rawDelta;
  }
  state.emittedLength += rawDelta.length;
  return rawDelta;
}

/**
 * Tool call accumulator for streaming responses
 */
export interface ToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
}

type OpenAIContentPartVideoUrl = {
  type: 'video_url';
  video_url: {
    url: string;
  };
};

type OpenAIContentPartFile = {
  type: 'file';
  file: {
    filename: string;
    file_data: string;
  };
};

type OpenAIContentPart =
  | OpenAI.Chat.ChatCompletionContentPartText
  | OpenAI.Chat.ChatCompletionContentPartImage
  | OpenAI.Chat.ChatCompletionContentPartInputAudio
  | OpenAIContentPartVideoUrl
  | OpenAIContentPartFile;

/**
 * Convert Gemini tool parameters to OpenAI JSON Schema format.
 */
export function convertLlmToolParametersToOpenAI(
  parameters: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!parameters || typeof parameters !== 'object') {
    return parameters;
  }

  const converted = JSON.parse(JSON.stringify(parameters));

  const convertTypes = (obj: unknown): unknown => {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(convertTypes);
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // A property can legitimately be NAMED after a JSON-Schema keyword —
      // `{ properties: { maximum: { type: 'INTEGER' } } }` declares a tool
      // parameter called "maximum". Recursing on any object value first keeps
      // such subschemas converted; the keyword branches below then only ever
      // see primitives, which is all they were meant to coerce.
      if (typeof value === 'object' && value !== null) {
        result[key] = convertTypes(value);
      } else if (key === 'type' && typeof value === 'string') {
        // Convert Gemini types to OpenAI JSON Schema types
        const lowerValue = value.toLowerCase();
        if (lowerValue === 'integer') {
          result[key] = 'integer';
        } else if (lowerValue === 'number') {
          result[key] = 'number';
        } else {
          result[key] = lowerValue;
        }
      } else if (
        key === 'minimum' ||
        key === 'maximum' ||
        key === 'multipleOf'
      ) {
        // Ensure numeric constraints are actual numbers, not strings
        if (typeof value === 'string' && !isNaN(Number(value))) {
          result[key] = Number(value);
        } else {
          result[key] = value;
        }
      } else if (
        key === 'minLength' ||
        key === 'maxLength' ||
        key === 'minItems' ||
        key === 'maxItems'
      ) {
        // Ensure length constraints are integers, not strings
        const numberValue = typeof value === 'string' ? Number(value) : NaN;
        if (
          typeof value === 'string' &&
          value.trim() !== '' &&
          Number.isInteger(numberValue)
        ) {
          result[key] = numberValue;
        } else {
          result[key] = value;
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  };

  return convertTypes(converted) as Record<string, unknown> | undefined;
}

/**
 * Convert Gemini tools to OpenAI format for API compatibility.
 * Handles both Gemini tools (using 'parameters' field) and MCP tools
 * (using 'parametersJsonSchema' field).
 */
export async function convertLlmToolsToOpenAI(
  llmTools: ToolListUnion,
  schemaCompliance: SchemaComplianceMode = 'auto',
): Promise<OpenAI.Chat.ChatCompletionTool[]> {
  const openAITools: OpenAI.Chat.ChatCompletionTool[] = [];

  for (const tool of llmTools) {
    let actualTool: Tool;

    // Handle CallableTool vs Tool
    if ('tool' in tool) {
      // This is a CallableTool
      actualTool = await (tool as CallableTool).tool();
    } else {
      // This is already a Tool
      actualTool = tool as Tool;
    }

    if (actualTool.functionDeclarations) {
      for (const func of actualTool.functionDeclarations) {
        if (func.name) {
          let parameters: Record<string, unknown> | undefined;

          // Handle both Gemini tools (parameters) and MCP tools (parametersJsonSchema)
          if (func.parametersJsonSchema) {
            // MCP tool format - use parametersJsonSchema directly
            // Create a shallow copy to avoid mutating the original object
            const paramsCopy = {
              ...(func.parametersJsonSchema as Record<string, unknown>),
            };
            parameters = paramsCopy;
          } else if (func.parameters) {
            // Gemini tool format - convert parameters to OpenAI format
            parameters = convertLlmToolParametersToOpenAI(
              func.parameters as Record<string, unknown>,
            );
          }

          if (parameters) {
            parameters = convertSchema(parameters, schemaCompliance);
            // #7315: gateways enforcing OpenAI's structured-output contract
            // promote every property to required when an object level has
            // `additionalProperties: false` — forcing the model to emit
            // mutually exclusive optional fields (Agent working_dir vs
            // isolation). Relax the wire schema; client-side
            // validateToolParams still enforces the source schema.
            parameters = relaxSchemaForFunctionCalling(parameters);
          }

          openAITools.push({
            type: 'function',
            function: {
              name: func.name,
              description: func.description ?? '',
              parameters,
            },
          });
        }
      }
    }
  }

  return openAITools;
}

/**
 * Convert Gemini request to OpenAI message format.
 */
export function convertLlmRequestToOpenAI(
  request: GenerateContentParameters,
  requestContext: RequestContext,
  options: { cleanOrphanToolCalls: boolean } = { cleanOrphanToolCalls: true },
): OpenAI.Chat.ChatCompletionMessageParam[] {
  let messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  // Handle system instruction from config
  addSystemInstructionMessage(request, messages);

  // Handle contents
  processContents(request.contents, messages, requestContext);

  messages = mergeConsecutiveAssistantMessages(messages);
  if (options.cleanOrphanToolCalls) {
    messages = cleanOrphanedToolCalls(messages);
    messages = mergeConsecutiveAssistantMessages(messages);
  }

  return messages;
}

/**
 * Convert Gemini response to OpenAI completion format (for logging).
 */
export function convertLlmResponseToOpenAI(
  response: GenerateContentResponse,
  requestContext: RequestContext,
): OpenAI.Chat.ChatCompletion {
  const candidate = response.candidates?.[0];
  const parts = (candidate?.content?.parts || []) as Part[];

  // Parse parts inline
  const thoughtParts: string[] = [];
  const contentParts: string[] = [];
  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
  let toolCallIndex = 0;

  for (const part of parts) {
    if (typeof part === 'string') {
      contentParts.push(part);
    } else if ('text' in part && part.text) {
      if ('thought' in part && part.thought) {
        thoughtParts.push(part.text);
      } else {
        contentParts.push(part.text);
      }
    } else if ('functionCall' in part && part.functionCall) {
      toolCalls.push({
        id: part.functionCall.id || `call_${toolCallIndex}`,
        type: 'function' as const,
        function: {
          name: part.functionCall.name || '',
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
      toolCallIndex += 1;
    }
  }

  const message: ExtendedCompletionMessage = {
    role: 'assistant',
    content: contentParts.join('') || null,
    refusal: null,
  };

  const reasoningContent = thoughtParts.join('');
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const finishReason = mapLlmFinishReasonToOpenAI(candidate?.finishReason);

  const usageMetadata = response.usageMetadata;
  const usage: OpenAI.CompletionUsage = {
    prompt_tokens: usageMetadata?.promptTokenCount || 0,
    completion_tokens: usageMetadata?.candidatesTokenCount || 0,
    total_tokens: usageMetadata?.totalTokenCount || 0,
  };

  if (usageMetadata?.cachedContentTokenCount !== undefined) {
    (
      usage as OpenAI.CompletionUsage & {
        prompt_tokens_details?: { cached_tokens?: number };
      }
    ).prompt_tokens_details = {
      cached_tokens: usageMetadata.cachedContentTokenCount,
    };
  }

  const createdMs = response.createTime
    ? Number(response.createTime)
    : Date.now();
  const createdSeconds = Number.isFinite(createdMs)
    ? Math.floor(createdMs / 1000)
    : Math.floor(Date.now() / 1000);

  return {
    id: response.responseId || `gemini-${Date.now()}`,
    object: 'chat.completion',
    created: createdSeconds,
    model: response.modelVersion || requestContext.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage,
  };
}

/**
 * Extract and add system instruction message from request config.
 */
function addSystemInstructionMessage(
  request: GenerateContentParameters,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): void {
  if (!request.config?.systemInstruction) return;

  const systemText = extractTextFromContentUnion(
    request.config.systemInstruction,
  );

  if (systemText) {
    messages.push({
      role: 'system' as const,
      content: systemText,
    });
  }
}

/**
 * Process contents and convert to OpenAI messages.
 */
function processContents(
  contents: ContentListUnion,
  messages: ExtendedChatCompletionMessageParam[],
  requestContext: RequestContext,
): void {
  if (Array.isArray(contents)) {
    for (const content of contents) {
      processContent(content, messages, requestContext);
    }
  } else if (contents) {
    processContent(contents, messages, requestContext);
  }
}

/**
 * Process a single content item and convert to OpenAI message(s).
 */
function processContent(
  content: ContentUnion | PartUnion,
  messages: ExtendedChatCompletionMessageParam[],
  requestContext: RequestContext,
): void {
  if (typeof content === 'string') {
    messages.push({ role: 'user' as const, content });
    return;
  }

  if (!isContentObject(content)) return;
  const parts = content.parts || [];
  const role = content.role === 'model' ? 'assistant' : 'user';

  const contentParts: OpenAIContentPart[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
  let toolCallIndex = 0;
  const emittedFunctionCallIds = new Set<string>();
  const emittedFunctionResponseIds = new Set<string>();
  // New history is normalized before reaching this converter. These local
  // guards only keep already-corrupted or programmatic duplicate parts from
  // leaking duplicate IDs into OpenAI payloads.
  // When `splitToolMedia` is enabled, media stripped from tool messages is
  // accumulated here and emitted as a single follow-up user message after
  // ALL tool messages in this group have been pushed. OpenAI Chat
  // Completions requires every `role: "tool"` response for a given assistant
  // turn to appear contiguously before any non-tool message; emitting the
  // user message inline (after each tool message) would interleave and
  // break that contract when multiple parallel tool calls return media.
  const accumulatedSplitMedia: OpenAIContentPart[] = [];

  for (const part of parts) {
    if (typeof part === 'string') {
      contentParts.push({ type: 'text' as const, text: part });
      continue;
    }

    if ('text' in part && 'thought' in part && part.thought) {
      if (role === 'assistant' && part.text) {
        reasoningParts.push(part.text);
      }
    }

    if ('text' in part && part.text && !('thought' in part && part.thought)) {
      contentParts.push({ type: 'text' as const, text: part.text });
    }

    const mediaPart = createMediaContentPart(part, requestContext);
    if (mediaPart && role === 'user') {
      contentParts.push(mediaPart);
    }

    if ('functionCall' in part && part.functionCall && role === 'assistant') {
      const callId = part.functionCall.id;
      if (callId) {
        if (emittedFunctionCallIds.has(callId)) {
          debugLogger.debug(
            `Dropping duplicate functionCall id=${callId} while converting content`,
          );
          continue;
        }
        emittedFunctionCallIds.add(callId);
      }

      toolCalls.push({
        id: callId || `call_${toolCallIndex}`,
        type: 'function' as const,
        function: {
          name: normalizeMcpToolName(part.functionCall.name || ''),
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
      toolCallIndex += 1;
    }

    if (part.functionResponse && role === 'user') {
      const responseId = part.functionResponse.id;
      if (responseId) {
        if (emittedFunctionResponseIds.has(responseId)) {
          continue;
        }
        emittedFunctionResponseIds.add(responseId);
      }

      // Create tool message for the function response (with embedded media)
      const toolMessage = createToolMessage(
        part.functionResponse,
        requestContext,
      );
      if (toolMessage) {
        // Controlled by ContentGeneratorConfig.splitToolMedia (default true;
        // resolved in pipeline.ts). OpenAI spec only permits string / text-part
        // content on `role: "tool"` messages. Strict OpenAI-compatible servers
        // (e.g. doubao / new-api / LM Studio) silently drop or reject tool
        // messages containing image_url / input_audio / video_url / file parts
        // (HTTP 400 "Invalid 'messages' in payload"), so an image read via
        // read_file never reaches the model. When the flag is set, strip
        // non-text media from this tool message and accumulate it; the combined
        // media is emitted as a single follow-up user message after the parts
        // loop completes — preserving the "all tool responses contiguous"
        // requirement for parallel tool calls. Opt out (flag false) to restore
        // the legacy behavior: media embedded in the tool message, which only
        // permissive providers accept. See #4876, #3616.
        if (
          requestContext.splitToolMedia &&
          Array.isArray(toolMessage.content)
        ) {
          const mediaParts: OpenAIContentPart[] = [];
          const textParts: OpenAI.Chat.ChatCompletionContentPartText[] = [];
          for (const cp of toolMessage.content as OpenAIContentPart[]) {
            if (
              cp &&
              (cp.type === 'image_url' ||
                cp.type === 'input_audio' ||
                cp.type === 'video_url' ||
                cp.type === 'file')
            ) {
              mediaParts.push(cp);
            } else if (cp && cp.type === 'text') {
              textParts.push(cp);
            }
          }
          if (mediaParts.length > 0) {
            const textOnly = textParts.map((p) => p.text).join('\n');
            toolMessage.content =
              textOnly || '[media attached in following user message]';
            accumulatedSplitMedia.push(...mediaParts);
          }
        }
        if (
          requestContext.toolResultContentFormat === 'string' &&
          Array.isArray(toolMessage.content)
        ) {
          const toolContent = toolMessage.content as OpenAIContentPart[];
          if (
            toolContent.every(
              (cp): cp is OpenAI.Chat.ChatCompletionContentPartText =>
                cp?.type === 'text',
            )
          ) {
            toolMessage.content = toolContent.map((cp) => cp.text).join('\n');
          }
        }
        messages.push(toolMessage);
      }
    }
  }

  // Emit one combined user message containing all media stripped from the
  // tool messages in this group. Runs after the parts loop so all tool
  // messages remain contiguous (OpenAI requirement for parallel tool calls).
  if (accumulatedSplitMedia.length > 0) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: SPLIT_TOOL_MEDIA_TEXT,
        },
        ...accumulatedSplitMedia,
      ] as unknown as OpenAI.Chat.ChatCompletionContentPartText[],
    });
  }

  if (role === 'assistant') {
    if (
      contentParts.length === 0 &&
      toolCalls.length === 0 &&
      reasoningParts.length === 0
    ) {
      return;
    }

    const assistantTextContent = contentParts
      .filter(
        (part): part is OpenAI.Chat.ChatCompletionContentPartText =>
          part.type === 'text',
      )
      .map((part) => part.text)
      .join('');
    const assistantMessage: ExtendedChatCompletionAssistantMessageParam = {
      role: 'assistant',
      // When there is reasoning content but no text, use "" instead of null.
      // Some OpenAI-compatible providers (e.g. Ollama) reject content: null
      // when reasoning_content is present, returning HTTP 400.
      // For tool-call-only messages we keep null to stay spec-compliant.
      content: assistantTextContent || (reasoningParts.length > 0 ? '' : null),
    };

    if (toolCalls.length > 0) {
      assistantMessage.tool_calls = toolCalls;
    }

    const reasoningContent = reasoningParts.join('');
    if (reasoningContent) {
      assistantMessage.reasoning_content = reasoningContent;
    }

    messages.push(assistantMessage);
    return;
  }

  if (contentParts.length > 0) {
    messages.push({
      role: 'user',
      content:
        contentParts as unknown as OpenAI.Chat.ChatCompletionContentPart[],
    });
  }
}

function extractFunctionResponseContent(response: unknown): string {
  if (response === null || response === undefined) {
    return '';
  }

  if (typeof response === 'string') {
    return response;
  }

  if (typeof response === 'object') {
    const responseObject = response as Record<string, unknown>;
    const output = responseObject['output'];
    if (typeof output === 'string') {
      return output;
    }

    const error = responseObject['error'];
    if (typeof error === 'string') {
      return error;
    }
  }

  try {
    const serialized = JSON.stringify(response);
    return serialized ?? String(response);
  } catch {
    return String(response);
  }
}

/**
 * Create a tool message from function response (with embedded media parts).
 */
function createToolMessage(
  response: FunctionResponse,
  requestContext: RequestContext,
): OpenAI.Chat.ChatCompletionToolMessageParam | null {
  const textContent = extractFunctionResponseContent(response.response);
  const contentParts: OpenAIContentPart[] = [];

  // Add text content first if present
  if (textContent) {
    contentParts.push({ type: 'text' as const, text: textContent });
  }

  // Add nested parts from the function response. Most entries here are
  // media (image/document attachments) — but the compaction slimmer
  // replaces inlineData/fileData with text placeholders like
  // `[image: image/png]` so the summary side-query doesn't carry raw
  // base64. Pass those text placeholders through as text content;
  // otherwise they'd be silently dropped by createMediaContentPart
  // (which only knows image_url / file_url shapes), and the summary
  // model would receive an empty tool response with no indication that
  // an image was ever there.
  for (const part of response.parts || []) {
    if ('text' in part && typeof part.text === 'string') {
      if (part.text.length > 0) {
        contentParts.push({ type: 'text' as const, text: part.text });
      }
      continue;
    }
    const mediaPart = createMediaContentPart(part, requestContext);
    if (mediaPart) {
      contentParts.push(mediaPart);
    }
  }

  // IMPORTANT: Always return a tool message, even if content is empty
  // OpenAI API requires that every tool call has a corresponding tool response
  // Empty tool results are valid (e.g., reading an empty file, successful operations with no output)
  if (contentParts.length === 0) {
    // Return empty string for empty tool results
    return {
      role: 'tool' as const,
      tool_call_id: response.id || '',
      content: '',
    };
  }

  // Cast to OpenAI type - some OpenAI-compatible APIs support richer content in tool messages
  return {
    role: 'tool' as const,
    tool_call_id: response.id || '',
    content: contentParts as unknown as
      | string
      | OpenAI.Chat.ChatCompletionContentPartText[],
  };
}

/**
 * Create OpenAI media content part from Gemini part.
 * Checks modality support before building each media type.
 */
function createMediaContentPart(
  part: Part,
  requestContext: RequestContext,
): OpenAIContentPart | null {
  const { modalities } = requestContext;

  if (part.inlineData?.mimeType && part.inlineData?.data) {
    const mimeType = part.inlineData.mimeType;
    const mediaType = getMediaType(mimeType);
    const displayName = part.inlineData.displayName || mimeType;

    if (mediaType === 'image') {
      if (!modalities.image) {
        return unsupportedModalityPlaceholder(
          'image',
          displayName,
          requestContext,
        );
      }
      const dataUrl = `data:${mimeType};base64,${part.inlineData.data}`;
      return {
        type: 'image_url' as const,
        image_url: { url: dataUrl },
      };
    }

    if (mimeType === 'application/pdf') {
      if (!modalities.pdf) {
        return unsupportedModalityPlaceholder(
          'pdf',
          displayName,
          requestContext,
        );
      }
      const filename = part.inlineData.displayName || 'document.pdf';
      return {
        type: 'file' as const,
        file: {
          filename,
          file_data: `data:${mimeType};base64,${part.inlineData.data}`,
        },
      };
    }

    if (mediaType === 'audio') {
      if (!modalities.audio) {
        return unsupportedModalityPlaceholder(
          'audio',
          displayName,
          requestContext,
        );
      }
      const format = getAudioFormat(mimeType);
      if (format) {
        return {
          type: 'input_audio' as const,
          input_audio: {
            data: `data:${mimeType};base64,${part.inlineData.data}`,
            format,
          },
        };
      }
    }

    if (mediaType === 'video') {
      if (!modalities.video) {
        return unsupportedModalityPlaceholder(
          'video',
          displayName,
          requestContext,
        );
      }
      return {
        type: 'video_url' as const,
        video_url: {
          url: `data:${mimeType};base64,${part.inlineData.data}`,
        },
      };
    }

    return {
      type: 'text' as const,
      text: `Unsupported inline media type: ${mimeType} (${displayName}).`,
    };
  }

  if (part.fileData?.mimeType && part.fileData?.fileUri) {
    const filename = part.fileData.displayName || 'file';
    const fileUri = part.fileData.fileUri;
    const mimeType = part.fileData.mimeType;
    const mediaType = getMediaType(mimeType);

    if (mediaType === 'image') {
      if (!modalities.image) {
        return unsupportedModalityPlaceholder(
          'image',
          filename,
          requestContext,
        );
      }
      return {
        type: 'image_url' as const,
        image_url: { url: fileUri },
      };
    }

    if (mimeType === 'application/pdf') {
      if (!modalities.pdf) {
        return unsupportedModalityPlaceholder('pdf', filename, requestContext);
      }
      return {
        type: 'file' as const,
        file: {
          filename,
          file_data: fileUri,
        },
      };
    }

    if (mediaType === 'video') {
      if (!modalities.video) {
        return unsupportedModalityPlaceholder(
          'video',
          filename,
          requestContext,
        );
      }
      return {
        type: 'video_url' as const,
        video_url: {
          url: fileUri,
        },
      };
    }

    const displayNameStr = part.fileData.displayName
      ? ` (${part.fileData.displayName})`
      : '';
    return {
      type: 'text' as const,
      text: `Unsupported file media type: ${mimeType}${displayNameStr}.`,
    };
  }

  return null;
}

/**
 * Create a text placeholder for unsupported modalities.
 */
function unsupportedModalityPlaceholder(
  modality: string,
  displayName: string,
  requestContext: RequestContext,
): OpenAIContentPart {
  debugLogger.warn(
    `Model '${requestContext.model}' does not support ${modality} input. ` +
      `Replacing with text placeholder: ${displayName}`,
  );
  let hint: string;
  if (modality === 'pdf') {
    hint =
      'This model does not support PDF input directly. The read_file tool cannot extract PDF content either. To extract text from the PDF file, try using skills if applicable, or guide user to install pdf skill by running this slash command:\n/extensions install https://github.com/anthropics/skills:document-skills';
  } else {
    hint = `This model does not support ${modality} input. The read_file tool cannot process this type of file either. To handle this file, try using skills if applicable, or any tools installed at system wide, or let the user know you cannot process this type of file.`;
  }
  return {
    type: 'text' as const,
    text: `[Unsupported ${modality} file: "${displayName}". ${hint}]`,
  };
}

function getMediaType(mimeType: string): 'image' | 'audio' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

function getAudioFormat(mimeType: string): 'wav' | 'mp3' | null {
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'mp3';
  return null;
}

function isContentObject(
  content: unknown,
): content is { role: string; parts: Part[] } {
  return (
    typeof content === 'object' &&
    content !== null &&
    'role' in content &&
    'parts' in content &&
    Array.isArray((content as Record<string, unknown>)['parts'])
  );
}

function extractTextFromContentUnion(contentUnion: unknown): string {
  if (typeof contentUnion === 'string') {
    return contentUnion;
  }

  if (Array.isArray(contentUnion)) {
    return contentUnion
      .map((item) => extractTextFromContentUnion(item))
      .filter(Boolean)
      .join('\n');
  }

  if (typeof contentUnion === 'object' && contentUnion !== null) {
    if ('parts' in contentUnion) {
      const content = contentUnion as Content;
      return (
        content.parts
          ?.map((part: Part) => {
            if (typeof part === 'string') return part;
            if ('text' in part) return part.text || '';
            return '';
          })
          .filter(Boolean)
          .join('\n') || ''
      );
    }
  }

  return '';
}

function convertOpenAITextToParts(
  text: string,
  requestContext: RequestContext,
  final = true,
): Part[] {
  if (!requestContext.responseParsingOptions?.taggedThinkingTags) {
    return text ? [{ text }] : [];
  }

  if (requestContext.taggedThinkingParser) {
    return requestContext.taggedThinkingParser.parse(text, final);
  }

  return parseTaggedThinkingText(text);
}

function hasThoughtPart(parts: Part[]): boolean {
  return parts.some((part) => part.thought === true);
}

// Thinking-tag vocabulary for the contentOnly scanner family below
// (scanBalancedThinkingBlock and friends): whitespace-tolerant and
// case-insensitive, pairing leading blocks only for fail-closed demotion. A
// second, deliberately different pairing engine lives in
// taggedThinkingParser.ts (TaggedThinkingParser, taggedThinkingTags route)
// and matches only the literal '<think>'/'<thinking>' tags with no
// whitespace inside tags — review both grammars together when changing
// either, so the two routes do not silently drift apart.
const THINKING_TAG_PATTERN = /<\/?think(?:ing)?\s*>/i;
const CLOSING_THINKING_TAG_PATTERN = /\n[^\S\r\n]*<\/think(?:ing)?[^\S\r\n]*>/i;
const LEADING_CLOSING_THINKING_TAG_PATTERN =
  /^[^\S\r\n]*<\/think(?:ing)?[^\S\r\n]*>/i;
const LEADING_THINKING_TAG_PATTERN = /^\s*<\/?think(?:ing)?\s*>/i;
const STANDALONE_CLOSING_THINKING_TAG_PATTERN =
  /^\s*<\/(think|thinking)\s*>\s*$/i;
const OPENING_THINKING_TAG_WORD_PATTERN = /<think(?:ing)?\s*>/i;
const MAX_THINKING_TAG_CANDIDATE_LENGTH = 128;

/**
 * True when `text` carries more closing than opening thinking tags. The
 * held-candidate superset strip uses this as a direction guard for
 * opening-block candidates: a genuine continuation that re-starts with the
 * held candidate's text must net-close the candidate's still-open depth
 * (more closers than openers), while a renormalized re-send of an
 * opening-block candidate re-opens at least as much as it closes — see the
 * strip's comment. The premise holds only for opening-block candidates; a
 * closing-shaped candidate has no open depth, so its renormalized re-send
 * IS net-closing and the guard must not apply to it.
 */
function carriesNetClosingTagSurplus(text: string): boolean {
  const openers = text.match(/<think(?:ing)?\s*>/gi)?.length ?? 0;
  const closers = text.match(/<\/think(?:ing)?\s*>/gi)?.length ?? 0;
  return closers > openers;
}

function startsWithOpeningThinkingTag(text: string): boolean {
  return (
    LEADING_THINKING_TAG_PATTERN.test(text) &&
    !text.trimStart().startsWith('</')
  );
}

function canBeStandaloneThinkingTagPrefix(text: string): boolean {
  const candidate = text.trimStart().toLowerCase();
  if (!candidate) return true;

  return ['<think', '<thinking', '</think', '</thinking'].some((tag) => {
    if (tag.startsWith(candidate)) return true;
    if (!candidate.startsWith(tag)) return false;
    return /^\s*(?:>\s*)?$/.test(candidate.slice(tag.length));
  });
}

/**
 * Longest trailing suffix of `text` that could still complete into a thinking
 * tag (a prefix of `<think(ing)?>` / `</think(ing)?>`, including optional
 * whitespace before `>`), or '' when the tail cannot become one. Capped like
 * the candidate machinery so an undecided tail cannot grow the hold
 * unboundedly — but a still-completable suffix that outgrew the cap is
 * reported via `overCapStillPossible` so the caller fails closed (mirroring
 * the candidate machinery's overflow policy) instead of releasing a
 * whitespace-padded tag into visible output.
 */
function trailingPotentialThinkingTagSuffix(text: string): {
  suffix: string;
  overCapStillPossible: boolean;
} {
  const lastTagStart = text.lastIndexOf('<');
  if (lastTagStart === -1) return { suffix: '', overCapStillPossible: false };
  const suffix = text.slice(lastTagStart);
  if (!canBeStandaloneThinkingTagPrefix(suffix)) {
    return { suffix: '', overCapStillPossible: false };
  }
  if (suffix.length > MAX_THINKING_TAG_CANDIDATE_LENGTH) {
    return { suffix: '', overCapStillPossible: true };
  }
  return { suffix, overCapStillPossible: false };
}

/**
 * Scan `text` from `startIndex` (immediately after an opening tag) for the
 * closing tag that balances it. Returns the end offset of the balanced block,
 * or undefined when no closer balances; `hasNestedOpening` reports whether
 * the scanned range contained a further opening tag (the classifier uses it
 * to distinguish unclosed nested blocks from still-pending prefixes). Every
 * balance walk goes through this scanner so the split and classify paths
 * cannot disagree about whether the same block balances.
 */
function scanBalancedThinkingBlock(
  text: string,
  startIndex: number,
): { end: number | undefined; hasNestedOpening: boolean } {
  // Constructed per call instead of sharing a module-level `g`-flag regex:
  // a shared regex carries mutable lastIndex state, and local construction
  // eliminates any stale-lastIndex hazard for current or future callers
  // (allocation is negligible — the scanner runs only a few times per chunk).
  const scanPattern = new RegExp(THINKING_TAG_PATTERN.source, 'gi');
  scanPattern.lastIndex = startIndex;
  let depth = 1;
  let hasNestedOpening = false;
  for (;;) {
    const match = scanPattern.exec(text);
    if (!match) break;
    const closing = match[0].startsWith('</');
    hasNestedOpening ||= !closing;
    depth += closing ? -1 : 1;
    if (depth === 0) {
      return { end: scanPattern.lastIndex, hasNestedOpening };
    }
  }
  return { end: undefined, hasNestedOpening };
}

function classifyContentOnlyThinkingTagPrefix(
  text: string,
  streamFinished: boolean,
): 'clean' | 'pending' | 'suspicious' | 'leaked' {
  const candidate = text.trimStart().toLowerCase();
  if (!candidate) return 'clean';

  const consumeTag = (
    value: string,
    closing: boolean,
  ): number | null | undefined => {
    const match = LEADING_THINKING_TAG_PATTERN.exec(value)?.[0];
    if (match) {
      return match.trimStart().startsWith('</') === closing
        ? match.length
        : undefined;
    }

    if (!canBeStandaloneThinkingTagPrefix(value)) return undefined;
    if (!value || value === '<') return null;
    return closing === value.startsWith('</') ? null : undefined;
  };

  let rest = candidate;
  for (const closing of [false, true, false]) {
    const tagLength = consumeTag(rest, closing);
    if (tagLength === null) return 'pending';
    if (tagLength === undefined) {
      if (!closing) return 'clean';
      break;
    }
    rest = rest.slice(tagLength).trimStart();
    if (closing && !rest) return 'clean';
    // An opening tag followed by ordinary text is only a legitimate literal
    // if a closing tag still balances it later. Without one, the turn is an
    // unclosed thinking block — the exact shape of the recorded production
    // leaks (issue #6666). Hold it mid-stream (a closing tag may still
    // arrive) and reject it once the stream finishes. Whitespace-only tails
    // stay undecided: they may still resolve into a closing tag.
    if (
      closing === false &&
      /\S/.test(rest) &&
      !/<\/think(?:ing)?\s*>/i.test(rest)
    ) {
      return streamFinished ? 'leaked' : 'pending';
    }
  }

  const { end, hasNestedOpening } = scanBalancedThinkingBlock(rest, 0);
  if (end !== undefined) return 'clean';
  if (!hasNestedOpening) return 'pending';
  return streamFinished ? 'leaked' : 'suspicious';
}

const TRAILING_CLOSING_THINKING_TAG_PATTERN = /<\/think(?:ing)?\s*>\s*$/i;

/**
 * Split off a leading balanced thinking block (`<think(ing)?> ... matching
 * closer`) from `text`. Returns undefined when the text does not start with
 * an opening tag or no balancing closing tag exists.
 */
function splitLeadingBalancedThinkingBlock(
  text: string,
): { block: string; rest: string } | undefined {
  if (!startsWithOpeningThinkingTag(text)) return undefined;

  const openMatch = LEADING_THINKING_TAG_PATTERN.exec(text)?.[0];
  if (!openMatch) return undefined;
  const { end } = scanBalancedThinkingBlock(text, openMatch.length);
  if (end === undefined) return undefined;
  return { block: text.slice(0, end), rest: text.slice(end) };
}

function stripOuterThinkingTags(block: string): string {
  const openMatch = LEADING_THINKING_TAG_PATTERN.exec(block)?.[0] ?? '';
  return block
    .slice(openMatch.length)
    .replace(TRAILING_CLOSING_THINKING_TAG_PATTERN, '');
}

/**
 * Extract every leading balanced thinking block from `text` (consecutive
 * blocks are all consumed). Returns the stripped inner texts plus the
 * remaining tail, or undefined when no leading block balances.
 * Whitespace-only blocks are consumed too — they still balance — but
 * contribute no inner text; keying the return on consumption rather than on
 * non-empty inner text keeps `<thinking></thinking>Answer` from being
 * mistaken for "no block balanced".
 */
function extractLeadingBalancedThinkingBlocks(
  text: string,
): { innerThoughts: string[]; rest: string } | undefined {
  const innerThoughts: string[] = [];
  let rest = text;
  let consumed = false;
  for (;;) {
    const split = splitLeadingBalancedThinkingBlock(rest);
    if (!split) break;
    consumed = true;
    const innerThought = stripOuterThinkingTags(split.block).trim();
    if (/\S/.test(innerThought)) {
      innerThoughts.push(innerThought);
    }
    rest = split.rest;
  }
  return consumed ? { innerThoughts, rest } : undefined;
}

function throwProtocolTagLeak(requestContext: RequestContext): never {
  debugLogger.debug(
    `thinking-tag leak rejected (held candidate length=${
      requestContext.pendingThinkingTagCandidate?.text.length ?? 0
    })`,
  );
  requestContext.pendingThinkingTagCandidate = undefined;
  requestContext.pendingUntrustedResponseParts = undefined;
  throw new InvalidStreamError(
    'Model response leaked thinking tags.',
    'PROTOCOL_TAG_LEAK',
  );
}

/**
 * Convert OpenAI response to Gemini format.
 */
export function convertOpenAIResponseToLlm(
  openaiResponse: OpenAI.Chat.ChatCompletion,
  requestContext: RequestContext,
): GenerateContentResponse {
  const choice = openaiResponse.choices?.[0];
  const message = choice?.message as ExtendedCompletionMessage | undefined;
  const reasoningText = message?.reasoning_content ?? message?.reasoning;
  const response = new GenerateContentResponse();

  if (choice) {
    const parts: Part[] = [];
    const textParts = choice.message.content
      ? convertOpenAITextToParts(choice.message.content, requestContext)
      : [];

    // Handle reasoning content (thoughts).
    // Tagged thinking providers may put thoughts in content, while other
    // responses still use reasoning_content. Preserve the separate reasoning
    // channel unless content parsing already produced thought parts.
    if (reasoningText && !hasThoughtPart(textParts)) {
      parts.push(createOpenAIReasoningThoughtPart(reasoningText));
    }

    // Handle text content
    parts.push(...textParts);

    // Handle tool calls
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.function) {
          let args: Record<string, unknown> = {};
          if (toolCall.function.arguments) {
            args = safeJsonParse(toolCall.function.arguments, {});
          }

          parts.push({
            functionCall: {
              id: toolCall.id,
              name: toolCall.function.name,
              args,
            },
          });
        }
      }
    }

    response.candidates = [
      {
        content: {
          parts,
          role: 'model' as const,
        },
        finishReason: mapOpenAIFinishReasonToLlm(
          choice.finish_reason || 'stop',
        ),
        index: 0,
        safetyRatings: [],
      },
    ];
  } else {
    response.candidates = [];
  }

  response.responseId = openaiResponse.id;
  response.createTime = openaiResponse.created
    ? openaiResponse.created.toString()
    : new Date().getTime().toString();

  response.modelVersion = openaiResponse.model || undefined;
  response.promptFeedback = { safetyRatings: [] };

  // Add usage metadata if available
  if (openaiResponse.usage) {
    const usage = openaiResponse.usage;

    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || 0;
    // Support both formats: prompt_tokens_details.cached_tokens (OpenAI standard)
    // and cached_tokens (some models return it at top level)
    const extendedUsage = usage as ExtendedCompletionUsage;
    const cachedTokens =
      usage.prompt_tokens_details?.cached_tokens ??
      extendedUsage.cached_tokens ??
      0;
    const cachedInputTokensReported =
      typeof usage.prompt_tokens_details?.cached_tokens === 'number' ||
      typeof extendedUsage.cached_tokens === 'number';
    const providerReasoningTokens =
      usage.completion_tokens_details?.reasoning_tokens;
    let thinkingTokens = providerReasoningTokens;
    if (thinkingTokens == null) {
      const estimatedThinkingTokens = estimateTextTokens(reasoningText ?? '');
      thinkingTokens =
        completionTokens > 0
          ? Math.min(estimatedThinkingTokens, completionTokens)
          : estimatedThinkingTokens;
      if (thinkingTokens > 0) {
        debugLogger.debug(
          `convertOpenAIResponseToLlm: reasoning_tokens absent; estimated ${thinkingTokens} from text`,
        );
      }
    }

    const hasTokenBreakdown =
      totalTokens === 0 || promptTokens !== 0 || completionTokens !== 0;

    response.usageMetadata = {
      ...(hasTokenBreakdown
        ? {
            promptTokenCount: promptTokens,
            candidatesTokenCount: completionTokens,
          }
        : {}),
      totalTokenCount: totalTokens,
      cachedContentTokenCount: cachedTokens,
      thoughtsTokenCount: thinkingTokens,
    };
    setGenAiUsageProvenance(response.usageMetadata, {
      cachedInputTokensReported,
    });
  }

  return response;
}

/**
 * Convert OpenAI stream chunk to Gemini format.
 *
 * `requestContext.toolCallParser` carries the tool-call parser for this
 * stream. Callers MUST attach a fresh parser at stream start and pass the
 * same instance for every chunk of that stream. Concurrent streams MUST use
 * distinct parsers or their tool-call buffers will interleave (issue #3516).
 */
export function convertOpenAIChunkToLlm(
  chunk: OpenAI.Chat.ChatCompletionChunk,
  requestContext: RequestContext,
): GenerateContentResponse {
  const choice = chunk.choices?.[0];
  const response = new GenerateContentResponse();
  const preparations: ToolCallPreparation[] = [];
  const toolCallParser = requestContext.toolCallParser;
  if (!toolCallParser) {
    throw new Error(
      'convertOpenAIChunkToLlm requires requestContext.toolCallParser — attach a fresh StreamingToolCallParser at stream start.',
    );
  }

  if (choice) {
    let parts: Part[] = [];
    let contentParts: Part[] = [];
    // The content-channel normalizer's regime signal for this chunk (set
    // below when the content delta is normalized; read by the held-candidate
    // superset strip further down).
    let tagHoldVerbatimEmission = false;

    // Post-finish redelivery must not mutate channel state. The finish-state
    // gate further down clears this chunk's parts/visibleText, but every
    // channel runs before it: a redelivered id-less tool-call arguments
    // fragment would find all buffers complete, allocate a NEW nameless
    // parser index via findMostRecentIncompleteIndex(), and make the
    // redelivered finish chunk throw MALFORMED_TOOL_CALL on a completed
    // turn; redelivered reasoning deltas pass the normalizer verbatim and
    // re-add estimateTextTokenUnits to emittedTokenUnits, inflating the
    // thoughtsTokenCount a redelivered usage chunk merges into the
    // already-yielded finish response. Skip the reasoning/content/tool-call
    // accumulation entirely once the finish chunk was converted; the
    // chunk.usage assembly below still runs, so a redelivered usage chunk is
    // absorbed with the pre-finish counter values (issue #9348).
    const postFinishRedelivery = requestContext.finishChunkConverted === true;

    // Handle reasoning content (thoughts).
    const reasoningText =
      (choice.delta as ExtendedCompletionChunkDelta)?.reasoning_content ??
      (choice.delta as ExtendedCompletionChunkDelta)?.reasoning;

    // Handle text content
    if (typeof choice.delta?.content === 'string' && !postFinishRedelivery) {
      const contentDeltaState = (requestContext.textDeltaState ??= {
        emittedText: '',
        emittedLength: 0,
        cumulativeMode: false,
      });
      // While a pre-demotion opening-shaped tag candidate is held, the held
      // bytes are in the normalizer baseline but were never emitted to the
      // user; a prefix-overlapping chunk carrying a full opening tag word is
      // then undecidable between a cumulative re-send and a genuine nested
      // opener, so emit it verbatim instead of slicing it (issue #9348 R8-1).
      // The guard is restricted to candidates that already carry a full
      // opening tag word: a sub-word candidate ('<t', '<thi') cannot itself
      // be mistaken for a nested opener, and slicing the overlap recombines
      // the suffix with the held prefix in the guard zone. Verbatim-emitting
      // sub-word candidates instead concatenates the whole re-send onto the
      // candidate and leaks raw tags on ordinary cumulative delivery
      // (issue #9348 R11-2 entrance 1).
      const heldOpeningTagCandidate =
        requestContext.pendingThinkingTagCandidate;
      contentDeltaState.tagHoldActive =
        requestContext.inlineThinkingBlockDemoted !== true &&
        heldOpeningTagCandidate !== undefined &&
        heldOpeningTagCandidate.closingTagName === undefined &&
        !heldOpeningTagCandidate.text.trimStart().startsWith('</') &&
        OPENING_THINKING_TAG_WORD_PATTERN.test(heldOpeningTagCandidate.text);
      const normalizedContent = normalizeStreamingTextDelta(
        choice.delta.content,
        contentDeltaState,
      );
      // Capture the normalizer's regime signal for the guard zone below:
      // true when this delta was emitted verbatim by a tag-hold overlap
      // guard, i.e. it is a cumulative re-send candidate rather than a
      // genuinely fresh delta (issue #9348 R11-2).
      tagHoldVerbatimEmission =
        contentDeltaState.tagHoldVerbatimEmission === true;
      // Skip empty-string push mid-stream; still call on finish_reason to
      // flush any buffered tagged-thinking content.
      if (normalizedContent || choice.finish_reason) {
        contentParts = convertOpenAITextToParts(
          normalizedContent,
          requestContext,
          Boolean(choice.finish_reason),
        );
      }
    } else if (choice.finish_reason && !postFinishRedelivery) {
      // Flush any buffered tagged-thinking content on stream end
      contentParts = convertOpenAITextToParts('', requestContext, true);
    }

    if (hasThoughtPart(contentParts)) {
      requestContext.hasTaggedThinkingThought = true;
      requestContext.pendingReasoningText = undefined;
      debugLogger.debug(
        'convertOpenAIChunkToLlm: tagged thinking content emitted a thought; dropping buffered reasoning',
      );
      if (requestContext.pendingContentParts?.length) {
        debugLogger.debug(
          `convertOpenAIChunkToLlm: flushing ${requestContext.pendingContentParts.length} buffered content part(s) before tagged content`,
        );
        parts.push(...requestContext.pendingContentParts);
        requestContext.pendingContentParts = undefined;
      }
    }

    if (
      reasoningText &&
      !postFinishRedelivery &&
      (!requestContext.responseParsingOptions?.taggedThinkingTags ||
        !requestContext.hasTaggedThinkingThought)
    ) {
      const reasoningDeltaState = (requestContext.reasoningDeltaState ??= {
        emittedText: '',
        emittedLength: 0,
        cumulativeMode: false,
      });
      const normalizedReasoningText = normalizeStreamingTextDelta(
        reasoningText,
        reasoningDeltaState,
      );
      if (normalizedReasoningText) {
        reasoningDeltaState.emittedTokenUnits =
          (reasoningDeltaState.emittedTokenUnits ?? 0) +
          estimateTextTokenUnits(normalizedReasoningText);
        requestContext.hasStructuredReasoningContent = true;
        if (THINKING_TAG_PATTERN.test(normalizedReasoningText)) {
          requestContext.hasThinkingTagInReasoning = true;
        }
      }
      if (
        normalizedReasoningText &&
        !requestContext.responseParsingOptions?.taggedThinkingTags
      ) {
        parts.push(createOpenAIReasoningThoughtPart(normalizedReasoningText));
      } else if (
        normalizedReasoningText &&
        !requestContext.hasTaggedThinkingThought
      ) {
        requestContext.pendingReasoningText =
          (requestContext.pendingReasoningText ?? '') + normalizedReasoningText;
        debugLogger.debug(
          `convertOpenAIChunkToLlm: buffered reasoning text (${requestContext.pendingReasoningText.length} chars) for tagged stream`,
        );
      }
    }

    if (
      requestContext.responseParsingOptions?.taggedThinkingTags &&
      !requestContext.hasTaggedThinkingThought &&
      requestContext.pendingReasoningText &&
      contentParts.length
    ) {
      requestContext.pendingContentParts = [
        ...(requestContext.pendingContentParts ?? []),
        ...contentParts,
      ];
      debugLogger.debug(
        `convertOpenAIChunkToLlm: buffered ${contentParts.length} content part(s) behind pending reasoning`,
      );
      contentParts = [];
    }

    if (
      choice.finish_reason &&
      requestContext.responseParsingOptions?.taggedThinkingTags &&
      !requestContext.hasTaggedThinkingThought &&
      requestContext.pendingReasoningText
    ) {
      debugLogger.debug(
        'convertOpenAIChunkToLlm: flushing buffered reasoning for tagged stream with no tagged thought',
      );
      parts.push(
        createOpenAIReasoningThoughtPart(requestContext.pendingReasoningText),
      );
      requestContext.pendingReasoningText = undefined;
    }
    if (choice.finish_reason && requestContext.pendingContentParts?.length) {
      debugLogger.debug(
        `convertOpenAIChunkToLlm: flushing ${requestContext.pendingContentParts.length} buffered content part(s) on stream finish`,
      );
      parts.push(...requestContext.pendingContentParts);
      requestContext.pendingContentParts = undefined;
    }
    parts.push(...contentParts);

    // Handle tool calls using the stream-local parser
    if (choice.delta?.tool_calls && !postFinishRedelivery) {
      for (const toolCall of choice.delta.tool_calls) {
        const index = toolCall.index ?? 0;

        // Process the tool call chunk through the streaming parser
        const parseResult = toolCall.function?.arguments
          ? toolCallParser.addChunk(
              index,
              toolCall.function.arguments,
              toolCall.id,
              toolCall.function.name,
            )
          : toolCallParser.addChunk(
              index,
              '', // Empty chunk for metadata-only updates
              toolCall.id,
              toolCall.function?.name,
            );

        const { id: callId, name: toolName } = toolCallParser.getToolCallMeta(
          parseResult.actualIndex ?? index,
        );
        if (callId && toolName) {
          const emitted = (requestContext.preparedToolCallIds ??= new Set());
          if (!emitted.has(callId)) {
            emitted.add(callId);
            preparations.push({ callId, toolName });
          }
        }
      }
    }

    const getVisibleText = (part: Part): string =>
      part.thought !== true && typeof part.text === 'string' ? part.text : '';
    let visibleText = parts.map(getVisibleText).join('');

    // Finish-state gate: once the finish chunk was converted, the pipeline
    // treats any further content as droppable (finishYielded absorption /
    // pendingFinishResponse merging discards it). A gateway redelivery
    // arriving after finish can therefore never contribute to the turn —
    // drop it here instead of running it through the replay and leaked-tag
    // gates, which would fail closed (PROTOCOL_TAG_LEAK) a completed turn
    // the finish response already closed. Drop EVERY part, not just
    // visible-text ones: redelivered reasoning_content still creates thought
    // parts (getVisibleText returns '' for them, so a visible-text-only
    // filter keeps them), and a reasoning-only redelivery carries no visible
    // text at all — either shape surviving into the pipeline trips the
    // pendingFinishProtocolTagSanitized latch ('Model response continued
    // after a finish reason.', PROTOCOL_TAG_LEAK) on sanitized turns,
    // hard-failing the completed turn this gate exists to protect. The
    // postFinishRedelivery skip at the top of this function keeps the
    // reasoning/content/tool-call channels from mutating parser state or
    // the token counter before this gate runs; the gate remains the
    // backstop that clears whatever the guard-zone flushes still produced.
    if (requestContext.finishChunkConverted === true) {
      parts = [];
      visibleText = '';
    }

    const pendingTagCandidate = requestContext.pendingThinkingTagCandidate;
    // Replay recognition keys on the accepted/emission sequence:
    // pre-demotion the held candidate is the accepted sequence. Content
    // equality and prefix comparison cannot tell a provider rewind apart
    // from a genuine nested opening tag arriving as its own delta (arbitrary
    // chunking of arbitrary content is undecidable against content
    // comparison — a full tag word CAN legitimately re-arrive while the
    // block it nests in is still held), and dropping the genuine shape
    // corrupts a real thinking block. Re-sends are therefore dropped only
    // while they carry NO full opening tag word (sub-word fragments like
    // '<think' can no longer be a genuine nested opener at this layer); an
    // equal re-send carrying a full opening tag word is appended instead,
    // exactly like a proper-prefix re-send. A true rewind then degrades to
    // duplicated content inside the hidden thought channel — which the
    // depth-counting scanner absorbs — or to the fail-closed finish check
    // when it never re-balances, rather than failing a legitimate turn.
    const replayedTagPrefix =
      !pendingTagCandidate?.closingTagName &&
      /\S/.test(pendingTagCandidate?.text ?? '') &&
      pendingTagCandidate?.text === visibleText &&
      !OPENING_THINKING_TAG_WORD_PATTERN.test(visibleText);
    const replayedClosingTag =
      STANDALONE_CLOSING_THINKING_TAG_PATTERN.exec(
        visibleText,
      )?.[1]?.toLowerCase();
    if (
      replayedTagPrefix ||
      (pendingTagCandidate?.closingTagName &&
        pendingTagCandidate.closingTagName === replayedClosingTag)
    ) {
      parts = parts.filter((part) => !getVisibleText(part));
      visibleText = '';
    }
    // Short cumulative replays can pass through normalizeStreamingTextDelta
    // verbatim. Detect them only from the complete accepted post-demotion
    // sequence: equality is an exact replay — EXCEPT when the accepted
    // sequence consists of balanced thinking blocks only: a genuine
    // consecutive block can be byte-identical to the blocks accepted so
    // far, and no visible content has been emitted yet, so the equality is
    // undecidable between a replay and a genuine consecutive identical
    // block. Dropping it silently loses the genuine block (the single-chunk
    // twin yields two thought parts), so a blocks-only equality is
    // appended; a true rewind then degrades to a duplicated thought inside
    // the hidden channel. Equality against a baseline that already carries
    // visible content is unambiguous (a genuine block can never re-send the
    // accepted visible tail) and stays dropped. A prefix-extending chunk is
    // a cumulative superset whose already-accepted prefix must be stripped
    // — with the same blocks-only exception: when the stripped prefix is
    // balanced blocks only, the delta can equally be a genuine consecutive
    // identical block run continuing into further blocks (chunked together),
    // and stripping silently loses the repeated block where both
    // single-chunk twins yield it. The blocks-only prefix is appended; a
    // true cumulative superset then degrades to a duplicated thought inside
    // the hidden channel, matching the equality branch's pinned horn.
    // A proper prefix of the sequence is NOT dropped: every demotion-seeded
    // baseline starts with an opening tag, so a lone genuine consecutive
    // block opener ('<thinking>') always prefixes the baseline and is
    // indistinguishable from a rewind replay by content comparison alone —
    // dropping it corrupts the genuine consecutive/nested block. Such
    // deltas are appended instead: a true rewind then degrades to
    // duplicated content inside the hidden thought channel — or to the
    // fail-closed leaked-tag gate once visible content exists, matching the
    // single-chunk twin — instead of silently losing a genuine block. Never
    // infer replay from suffix equality — genuine adjacent deltas can repeat
    // the same character or tag-like fragment. Compare trimStart()-aligned
    // in every branch: a whitespace-only content delta can be emitted before
    // any reasoning_content arrives (it cannot be held — no structured
    // reasoning yet — and /\S/ keeps it from setting hasVisibleContent), so
    // the provider's cumulative replay can carry leading whitespace the
    // demotion-seeded baseline excludes; the mirror polarity (baseline
    // seeded from a held candidate carrying whitespace the replay lacks)
    // must be recognized too.
    if (
      requestContext.inlineThinkingBlockDemoted === true &&
      visibleText &&
      requestContext.postDemotionReplayText !== undefined
    ) {
      const alignedVisibleText = visibleText.trimStart();
      const alignedReplayText =
        requestContext.postDemotionReplayText.trimStart();
      const baselineBlocks =
        extractLeadingBalancedThinkingBlocks(alignedReplayText);
      const baselineBlocksOnly =
        baselineBlocks !== undefined && baselineBlocks.rest === '';
      if (alignedVisibleText === alignedReplayText && !baselineBlocksOnly) {
        parts = parts.filter((part) => !getVisibleText(part));
        visibleText = '';
      } else if (
        alignedReplayText.length > 0 &&
        alignedVisibleText.startsWith(alignedReplayText) &&
        alignedVisibleText !== alignedReplayText &&
        !baselineBlocksOnly
      ) {
        const leadingLength = visibleText.length - alignedVisibleText.length;
        visibleText = visibleText.slice(
          leadingLength + alignedReplayText.length,
        );
        parts = parts.filter((part) => !getVisibleText(part));
        if (visibleText) parts.push({ text: visibleText });
      }
    }
    // Cumulative superset replays can also arrive while the opening block is
    // still held in a pre-demotion candidate: a provider buffer renormalized
    // against the delta history (the exact anomaly the post-demotion
    // alignment above was built for — e.g. the renormalization stripped the
    // leading whitespace the held candidate carries) passes through
    // normalizeStreamingTextDelta unsliced. Concatenating it onto the
    // pending candidate would duplicate the held prefix and guarantee the
    // block never balances, so the finish chunk would throw
    // PROTOCOL_TAG_LEAK on a legitimate turn. Strip the held candidate's
    // trimStart()-aligned prefix before concatenation, mirroring the
    // post-demotion baseline — but only when the candidate already carries a
    // full tag word. A sub-word candidate ('<', '<t', '<thi') matches the
    // startsWith condition against unrelated genuine content ('<EOF',
    // '<<thinking>…') too, and stripping then either silently drops a
    // genuine '<' or reassembles the remainder into a block that gets
    // demoted into the hidden thought channel. Without the strip a sub-word
    // candidate still recombines correctly with its genuine continuation.
    // Direction guards on the delta:
    // - Never strip a net-closing delta against an opening-block candidate:
    //   a genuine nested continuation whose prefix coincidentally equals the
    //   held candidate (the inner block re-starts with the candidate's
    //   bytes) must net-close the candidate's still-open depth, while a
    //   renormalized re-send of an opening-block candidate re-opens at
    //   least as much as it closes. Stripping the net-closing shape
    //   reassembles an early-balancing block whose leftover stray closer
    //   fails the turn mid-stream; appending it lets the depth-counting
    //   scanner absorb the nested block instead.
    // - On a genuinely fresh delta, never strip when the bytes immediately
    //   after the held candidate's prefix form a closing tag: that shape (a
    //   net-zero delta, so the net-closing guard lets it through) is a
    //   genuine nested block whose opener + partial body coincidentally
    //   re-spell the held candidate — e.g. held '<thinking>b' and a nested
    //   '<thinking>b</thinking>' chunk. Stripping merges the nested closer
    //   against the candidate's opener into an early-balancing flat block,
    //   corrupting a real thinking block chunking-dependently (the
    //   single-chunk twin demotes cleanly), so append it instead and let the
    //   depth-counting scanner absorb the nested block. On the tag-hold
    //   overlap-verbatim regime the identical shape is the held block's own
    //   cumulative snapshot completing its closer, so it strips instead —
    //   see entrance 2 below (issue #9348 R8-1, R11-2). A re-send that
    //   EXTENDS the candidate's body ('<thinking>x' re-sent as
    //   '<thinking>xyz…') still strips: its remainder starts with body
    //   text, not a closer.
    // - Closing-shaped candidates ('</think…' held before the '>' arrives)
    //   have no open depth: their renormalized re-send IS net-closing, and
    //   the net-closing guard would skip the strip and concatenate the
    //   re-send into raw garbage, so both direction guards are skipped for
    //   them and the strip re-assembles the re-send onto the closingTagName
    //   route (issue #9348 R10-1).
    const stripCandidateIsClosingShaped =
      pendingTagCandidate !== undefined &&
      pendingTagCandidate.text.trimStart().startsWith('</');
    if (
      pendingTagCandidate &&
      !pendingTagCandidate.closingTagName &&
      /\S/.test(pendingTagCandidate.text) &&
      /<\/?think(?:ing)?/i.test(pendingTagCandidate.text) &&
      visibleText &&
      (stripCandidateIsClosingShaped ||
        !carriesNetClosingTagSurplus(visibleText))
    ) {
      const alignedCandidateText = pendingTagCandidate.text.trimStart();
      const alignedVisibleText = visibleText.trimStart();
      if (alignedVisibleText.startsWith(alignedCandidateText)) {
        const remainder = alignedVisibleText.slice(alignedCandidateText.length);
        // R8-1: these shapes mark the delta as genuine content that must be
        // kept whole (the depth-counting scanner absorbs it) rather than
        // stripped against the candidate:
        //  (entrance 1) the delta equals the candidate (remainder '') — an
        //    opening-word equal re-send the equality drop deliberately
        //    appended; stripping would empty it and lose the block;
        //  (entrance 2) the bytes right after the candidate prefix open with
        //    a closing tag — held '<thinking>b' + nested '<thinking>b</thinking>'.
        //    The anchor is whitespace-tolerant so a nested body ending in
        //    whitespace ('<thinking>b </thinking>') still matches. This
        //    entrance applies only to genuinely fresh deltas: on the
        //    tag-hold overlap-verbatim regime the same shape is the held
        //    block's OWN cumulative snapshot completing its closer —
        //    ordinary per-token cumulative delivery — and appending it
        //    re-spells the block's opener+body into the candidate so the
        //    block never balances and the turn fails closed at finish.
        //    Overlap-regime deltas therefore strip: the remainder carries
        //    exactly the completing bytes (issue #9348 R11-2 entrance 2).
        //    A fresh delta re-spelling the candidate stays undecidable and
        //    keeps the R8-1 append direction;
        //  (entrance 3) the candidate is a bare opener and the delta is a
        //    complete balanced block — held '<thinking>' + nested
        //    '<thinking>inner</thinking>'.
        // Closing-shaped candidates are exempt: their re-send MUST strip to
        // re-assemble the closingTagName route (R10-1).
        const candidateIsBareOpener = /^\s*<think(?:ing)?\s*>$/i.test(
          pendingTagCandidate.text,
        );
        const deltaBalancedBlocks = candidateIsBareOpener
          ? extractLeadingBalancedThinkingBlocks(alignedVisibleText)
          : undefined;
        const genuineNestedRespell =
          !stripCandidateIsClosingShaped &&
          (remainder === '' ||
            (!tagHoldVerbatimEmission &&
              /^\s*<\/think(?:ing)?\s*>/i.test(remainder)) ||
            (candidateIsBareOpener &&
              deltaBalancedBlocks !== undefined &&
              deltaBalancedBlocks.rest === ''));
        if (!genuineNestedRespell) {
          visibleText = remainder;
          parts = parts.filter((part) => !getVisibleText(part));
          if (visibleText) parts.push({ text: visibleText });
        }
      }
    }
    // Accumulate the baseline AFTER the superset strip above: accumulating
    // the pre-strip delta would double-count the held rest's text into
    // postDemotionReplayText when a cumulative-superset resend arrives while
    // a post-demotion rest candidate is held, permanently desyncing the
    // baseline from the accepted sequence. The baseline must always reflect
    // the post-strip accepted content.
    if (requestContext.inlineThinkingBlockDemoted === true && visibleText) {
      requestContext.postDemotionReplayText =
        (requestContext.postDemotionReplayText ?? '') + visibleText;
    }
    const combinedCandidateText =
      (pendingTagCandidate?.text ?? '') + visibleText;
    const hasStructuredReasoning =
      requestContext.hasStructuredReasoningContent === true;
    const detectContentOnlyThinkingTagLeaks =
      requestContext.responseParsingOptions?.contentOnlyThinkingTagLeaks ===
      true;
    const contentOnlyThinkingState =
      hasStructuredReasoning ||
      requestContext.hasVisibleContent === true ||
      !detectContentOnlyThinkingTagLeaks
        ? 'clean'
        : classifyContentOnlyThinkingTagPrefix(
            combinedCandidateText,
            Boolean(choice.finish_reason),
          );
    const confirmedOpeningTagCandidate = startsWithOpeningThinkingTag(
      combinedCandidateText,
    );
    const canStartTagCandidate =
      requestContext.hasVisibleContent !== true &&
      visibleText.length > 0 &&
      ((hasStructuredReasoning &&
        (canBeStandaloneThinkingTagPrefix(combinedCandidateText) ||
          confirmedOpeningTagCandidate)) ||
        contentOnlyThinkingState !== 'clean');

    if (pendingTagCandidate || canStartTagCandidate) {
      const closingTag = STANDALONE_CLOSING_THINKING_TAG_PATTERN.exec(
        combinedCandidateText,
      )?.[1]?.toLowerCase();
      const closingTagName =
        closingTag === 'think' || closingTag === 'thinking'
          ? closingTag
          : undefined;
      const isPossibleTag =
        canBeStandaloneThinkingTagPrefix(combinedCandidateText) ||
        contentOnlyThinkingState === 'pending' ||
        contentOnlyThinkingState === 'suspicious';
      const finishedWhitespaceCandidate =
        Boolean(choice.finish_reason) &&
        !closingTagName &&
        !/\S/.test(combinedCandidateText);
      // The length cap releases undecided prefixes (e.g. a literal "<t" that
      // never resolves) so ordinary content is not buffered forever. Once the
      // candidate has committed to a complete opening tag, though, releasing
      // it can leak the whole block — production thinking-tag leaks are longer
      // than the cap (issue #6666). Keep those held until a closing tag arrives
      // or the finished-stream check rejects an unclosed block.
      const releaseContentOnlyCandidate =
        contentOnlyThinkingState === 'pending' &&
        !confirmedOpeningTagCandidate &&
        (Boolean(choice.finish_reason) ||
          combinedCandidateText.trimStart().length >
            MAX_THINKING_TAG_CANDIDATE_LENGTH);

      if (contentOnlyThinkingState === 'leaked') {
        throwProtocolTagLeak(requestContext);
      }

      if (pendingTagCandidate?.closingTagName && !closingTagName) {
        throwProtocolTagLeak(requestContext);
      }

      // A structured-reasoning turn whose content opens with an inline
      // thinking tag is a legitimate second thinking phase once the block
      // balances (issue #9348) — hard-failing the moment the opening tag
      // completed made retries regenerate the same shape and surface
      // "[API Error: Model response leaked thinking tags.]" mid-session.
      // Hold the block while it is incomplete, demote balanced block(s) to
      // the thought channel, and keep rejecting blocks that never close.
      // The inline path must also run on the initial content delta: when the
      // first chunk already carries a complete opening tag (or a whole
      // balanced block), no pending candidate exists yet, and falling
      // through to the leaked-tag check would reject a valid shape that
      // depends only on stream chunking.
      const inlineOpeningTagCandidate =
        hasStructuredReasoning &&
        !closingTagName &&
        confirmedOpeningTagCandidate;

      if (inlineOpeningTagCandidate) {
        const balancedInlineThinkingBlocks =
          extractLeadingBalancedThinkingBlocks(combinedCandidateText);
        if (balancedInlineThinkingBlocks) {
          requestContext.inlineThinkingBlockDemoted = true;
          // Accumulate every accepted content delta from the first demotion so
          // an exact cumulative replay (including one spanning later
          // demotions) can be recognized without guessing from suffixes.
          requestContext.postDemotionReplayText ??= combinedCandidateText;
          parts = parts.filter((part) => !getVisibleText(part));
          for (const innerThought of balancedInlineThinkingBlocks.innerThoughts) {
            parts.push(createOpenAIReasoningThoughtPart(innerThought));
          }
          const rest = balancedInlineThinkingBlocks.rest;
          const restState = classifyContentOnlyThinkingTagPrefix(
            rest,
            Boolean(choice.finish_reason),
          );
          debugLogger.debug(
            `inline thinking blocks demoted (blocks=${balancedInlineThinkingBlocks.innerThoughts.length}, rest=${rest.length}b, restState=${restState})`,
          );
          requestContext.pendingThinkingTagCandidate = undefined;
          if (!choice.finish_reason && restState !== 'clean') {
            // The tail starts with an incomplete opener or tag prefix right
            // after the demoted block(s); keep holding it until the closer
            // arrives (or the finished-stream check rejects it). A complete
            // tag embedded further inside the tail is caught by the
            // post-demotion leaked-tag gate below.
            requestContext.pendingThinkingTagCandidate = { text: rest };
            visibleText = '';
          } else if (
            // Fail closed only when the undigested tail contains a full tag
            // word (e.g. a '<thinking' truncated before '>'): its chunk-split
            // twin throws via the hold path once the tag completes, so
            // releasing it here would make the outcome chunking-dependent.
            // ('leaked' is classified only when the stream has finished, so
            // it is fully subsumed by this finish-time check.) A sub-word
            // fragment (e.g. '<thi') can no longer become a tag once the
            // stream has ended; release it as literal text like the
            // post-demotion tag-tail finish release and the pipeline EOF
            // backstop, so the outcome does not depend on whether a visible
            // character landed right before the truncation point.
            choice.finish_reason &&
            restState !== 'clean' &&
            /<\/?think(?:ing)?/i.test(rest)
          ) {
            throwProtocolTagLeak(requestContext);
          } else {
            if (rest) {
              parts.push({ text: rest });
            }
            visibleText = rest;
          }
        } else if (choice.finish_reason) {
          // Stream finished with an opening tag that never balanced — a
          // genuine leak; preserve the historical rejection.
          throwProtocolTagLeak(requestContext);
        } else {
          // Incomplete block mid-stream: keep holding it until the closing
          // tag arrives (or the finished-stream check rejects it).
          debugLogger.debug(
            `inline thinking block held mid-stream (candidate length=${combinedCandidateText.length})`,
          );
          requestContext.pendingThinkingTagCandidate = {
            text: combinedCandidateText,
          };
          parts = parts.filter((part) => !getVisibleText(part));
          visibleText = '';
        }
      } else if (finishedWhitespaceCandidate || releaseContentOnlyCandidate) {
        parts = parts.filter((part) => !getVisibleText(part));
        if (combinedCandidateText) {
          parts.push({ text: combinedCandidateText });
        }
        visibleText = combinedCandidateText;
        requestContext.pendingThinkingTagCandidate = undefined;
      } else if (isPossibleTag) {
        if (
          !confirmedOpeningTagCandidate &&
          !closingTagName &&
          combinedCandidateText.trimStart().length >
            MAX_THINKING_TAG_CANDIDATE_LENGTH
        ) {
          throwProtocolTagLeak(requestContext);
        }
        requestContext.pendingThinkingTagCandidate = closingTagName
          ? { text: `</${closingTagName}>`, closingTagName }
          : { text: combinedCandidateText };
        parts = parts.filter((part) => !getVisibleText(part));
        visibleText = '';

        if (choice.finish_reason && !closingTagName) {
          if (/<\/?think(?:ing)?/i.test(combinedCandidateText)) {
            throwProtocolTagLeak(requestContext);
          }
          // Sub-word fragment (e.g. a truncated '<thi'): it can no longer
          // become a tag once the stream has ended. Release it as literal
          // text — aligned with the demotion-rest finish check, the
          // post-demotion tag-tail finish release, and the pipeline EOF
          // backstop — instead of hard-failing a truncated turn.
          requestContext.pendingThinkingTagCandidate = undefined;
          if (combinedCandidateText) {
            parts.push({ text: combinedCandidateText });
          }
          visibleText = combinedCandidateText;
        }
      } else if (pendingTagCandidate) {
        parts = parts.filter((part) => !getVisibleText(part));
        parts.push({ text: combinedCandidateText });
        visibleText = combinedCandidateText;
        requestContext.pendingThinkingTagCandidate = undefined;
      }
    }

    // Once a demotion has released visible content the candidate machinery
    // above is disengaged (hasVisibleContent is true), so a thinking tag
    // assembled across chunk boundaries would never appear complete in any
    // one chunk and would slip past the per-chunk leaked-tag gate below.
    // Keep the defense engaged: hold any trailing suffix of the emitted text
    // that could still complete into a tag, gate on tail + current chunk
    // together, and fail closed at finish if the held tail never resolves.
    if (
      requestContext.inlineThinkingBlockDemoted === true &&
      (visibleText || requestContext.pendingPostDemotionTagTail)
    ) {
      const combinedVisibleText =
        (requestContext.pendingPostDemotionTagTail ?? '') + visibleText;
      if (THINKING_TAG_PATTERN.test(combinedVisibleText)) {
        throwProtocolTagLeak(requestContext);
      }
      const { suffix: heldTagSuffix, overCapStillPossible } =
        trailingPotentialThinkingTagSuffix(combinedVisibleText);
      if (overCapStillPossible) {
        // A still-completable suffix (e.g. a whitespace-padded '<thinking'
        // assembled across chunks) outgrew the cap: releasing it would let
        // the padded tag slip past the fail-closed gate above, so mirror the
        // candidate machinery's isPossibleTag overflow policy and fail
        // closed instead.
        throwProtocolTagLeak(requestContext);
      }
      let resolvedVisibleText = combinedVisibleText.slice(
        0,
        combinedVisibleText.length - heldTagSuffix.length,
      );
      requestContext.pendingPostDemotionTagTail = heldTagSuffix || undefined;
      if (choice.finish_reason && requestContext.pendingPostDemotionTagTail) {
        // Fail closed only when the held tail already contains a full tag
        // word (e.g. a '<thinking' truncated before '>'): its chunk-split
        // twin throws via the gate above once the tag completes, so
        // releasing it here would make the outcome chunking-dependent. A
        // sub-word fragment ('<', '<t', '<T' — e.g. a generic type cut by
        // max_tokens) can no longer become a tag once the stream has ended,
        // so release it as literal text instead of hard-failing a
        // legitimate demoted turn.
        if (
          /<\/?think(?:ing)?/i.test(requestContext.pendingPostDemotionTagTail)
        ) {
          throwProtocolTagLeak(requestContext);
        }
        resolvedVisibleText = combinedVisibleText;
        requestContext.pendingPostDemotionTagTail = undefined;
      }
      parts = parts.filter((part) => !getVisibleText(part));
      if (resolvedVisibleText) {
        parts.push({ text: resolvedVisibleText });
      }
      visibleText = resolvedVisibleText;
    }

    const leakedThinkingTag =
      requestContext.hasStructuredReasoningContent === true &&
      ((requestContext.hasVisibleContent !== true &&
        LEADING_THINKING_TAG_PATTERN.test(visibleText)) ||
        (requestContext.hasThinkingTagInReasoning === true &&
          (CLOSING_THINKING_TAG_PATTERN.test(visibleText) ||
            (requestContext.atVisibleLineStart === true &&
              LEADING_CLOSING_THINKING_TAG_PATTERN.test(visibleText)))) ||
        // Once a balanced inline block has been demoted, any further complete
        // tag in visible content is embedded or stray — the candidate
        // machinery no longer applies after visible content exists, so the
        // chunk-split twin of an interleaved shape would otherwise emit raw
        // tags. Literal tag references stay sanctioned before any demotion.
        (requestContext.inlineThinkingBlockDemoted === true &&
          THINKING_TAG_PATTERN.test(visibleText)));

    if (/\S/.test(visibleText)) {
      requestContext.hasVisibleContent = true;
    }
    if (visibleText && requestContext.hasThinkingTagInReasoning === true) {
      const lastLineBreak = visibleText.lastIndexOf('\n');
      const lineSuffix = visibleText.slice(lastLineBreak + 1);
      requestContext.atVisibleLineStart =
        (lastLineBreak >= 0 || requestContext.atVisibleLineStart === true) &&
        /^[^\S\r\n]*$/.test(lineSuffix);
    }
    if (leakedThinkingTag) {
      throwProtocolTagLeak(requestContext);
    }

    const toolCallWithoutName = toolCallParser.hasNamelessToolCall();
    const completedToolCalls = choice.finish_reason
      ? toolCallParser.getCompletedToolCalls()
      : [];
    // Some providers report "stop" or "tool_calls" for JSON cut off by the
    // token limit, so validate the parser state independently of finish_reason.
    const toolCallsTruncated = choice.finish_reason
      ? toolCallParser.hasIncompleteToolCalls()
      : false;
    if (
      choice.finish_reason &&
      requestContext.pendingThinkingTagCandidate?.closingTagName
    ) {
      if (
        requestContext.hasThinkingTagInReasoning === true ||
        choice.finish_reason !== 'tool_calls' ||
        completedToolCalls.length === 0 ||
        toolCallWithoutName ||
        toolCallParser.hasConflictingToolCallIdentity() ||
        toolCallsTruncated ||
        toolCallParser.hasInvalidToolCallArguments()
      ) {
        throwProtocolTagLeak(requestContext);
      }
      requestContext.protocolTagSanitized = {
        tagName: requestContext.pendingThinkingTagCandidate.closingTagName,
        toolCallCount: completedToolCalls.length,
      };
      requestContext.pendingThinkingTagCandidate = undefined;
    }

    if (
      choice.finish_reason &&
      (toolCallParser.hasInvalidToolCallIndex() ||
        toolCallWithoutName ||
        (choice.finish_reason === 'tool_calls' &&
          completedToolCalls.length === 0))
    ) {
      requestContext.pendingUntrustedResponseParts = undefined;
      throw new InvalidStreamError(
        'Model response contained a malformed tool call.',
        'MALFORMED_TOOL_CALL',
      );
    }

    // Record the finish state only after the finish chunk's own flushes and
    // fail-closed checks have run: content arriving in later chunks is
    // post-finish redelivery the pipeline treats as droppable, and the
    // finish-state gate at the top of the guard zone drops it instead of
    // failing the completed turn.
    if (choice.finish_reason) {
      requestContext.finishChunkConverted = true;
    }

    const shouldHoldParts =
      !choice.finish_reason &&
      (toolCallWithoutName ||
        requestContext.hasThinkingTagInReasoning === true ||
        requestContext.pendingThinkingTagCandidate !== undefined);
    if (shouldHoldParts) {
      (requestContext.pendingUntrustedResponseParts ??= []).push(...parts);
      parts.length = 0;
    } else if (requestContext.pendingUntrustedResponseParts) {
      parts = requestContext.pendingUntrustedResponseParts.concat(parts);
      requestContext.pendingUntrustedResponseParts = undefined;
    }

    // Only emit function calls when streaming is complete (finish_reason is present)
    if (choice.finish_reason) {
      for (const toolCall of completedToolCalls) {
        if (toolCall.name) {
          parts.push({
            functionCall: {
              id:
                toolCall.id ||
                `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
              name: toolCall.name,
              args: toolCall.args,
            },
          });
        }
      }
    }

    // If tool call JSON was truncated, override to "length" so downstream
    // (turn.ts) correctly sets wasOutputTruncated=true.
    const effectiveFinishReason =
      toolCallsTruncated && choice.finish_reason !== 'length'
        ? 'length'
        : choice.finish_reason;

    // Only include finishReason key if finish_reason is present
    const candidate: Candidate = {
      content: {
        parts,
        role: 'model' as const,
      },
      index: 0,
      safetyRatings: [],
    };
    if (effectiveFinishReason) {
      candidate.finishReason = mapOpenAIFinishReasonToLlm(
        effectiveFinishReason,
      );
    }
    response.candidates = [candidate];
  } else {
    response.candidates = [];
  }

  response.responseId = chunk.id;
  response.createTime = chunk.created
    ? chunk.created.toString()
    : new Date().getTime().toString();

  response.modelVersion = chunk.model || undefined;
  response.promptFeedback = { safetyRatings: [] };

  // Add usage metadata if available in the chunk
  if (chunk.usage) {
    const usage = chunk.usage;

    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || 0;
    const providerReasoningTokens =
      usage.completion_tokens_details?.reasoning_tokens;
    const estimatedThinkingTokens = Math.ceil(
      (requestContext.reasoningDeltaState?.emittedTokenUnits ?? 0) /
        TOKEN_ESTIMATE_UNITS_PER_TOKEN,
    );
    const thinkingTokens =
      providerReasoningTokens ??
      (completionTokens > 0
        ? Math.min(estimatedThinkingTokens, completionTokens)
        : estimatedThinkingTokens);
    if (providerReasoningTokens == null && estimatedThinkingTokens > 0) {
      debugLogger.debug(
        `convertOpenAIChunkToLlm: reasoning_tokens absent; estimated ${thinkingTokens} from streamed text`,
      );
    }
    // Support both formats: prompt_tokens_details.cached_tokens (OpenAI standard)
    // and cached_tokens (some models return it at top level)
    const extendedUsage = usage as ExtendedCompletionUsage;
    const cachedTokens =
      usage.prompt_tokens_details?.cached_tokens ??
      extendedUsage.cached_tokens ??
      0;
    const cachedInputTokensReported =
      typeof usage.prompt_tokens_details?.cached_tokens === 'number' ||
      typeof extendedUsage.cached_tokens === 'number';

    const hasTokenBreakdown =
      totalTokens === 0 || promptTokens !== 0 || completionTokens !== 0;

    response.usageMetadata = {
      ...(hasTokenBreakdown
        ? {
            promptTokenCount: promptTokens,
            candidatesTokenCount: completionTokens,
          }
        : {}),
      thoughtsTokenCount: thinkingTokens,
      totalTokenCount: totalTokens,
      cachedContentTokenCount: cachedTokens,
    };
    setGenAiUsageProvenance(response.usageMetadata, {
      cachedInputTokensReported,
    });
  }

  if (preparations.length > 0) {
    setToolCallPreparations(response, preparations);
  }

  return response;
}

function mapOpenAIFinishReasonToLlm(openaiReason: string | null): FinishReason {
  if (typeof openaiReason !== 'string') {
    return FinishReason.FINISH_REASON_UNSPECIFIED;
  }
  const mapping: Record<string, FinishReason> = {
    stop: FinishReason.STOP,
    length: FinishReason.MAX_TOKENS,
    max_tokens: FinishReason.MAX_TOKENS,
    content_filter: FinishReason.SAFETY,
    function_call: FinishReason.STOP,
    tool_calls: FinishReason.STOP,
  };
  return (
    mapping[openaiReason.toLowerCase()] ||
    FinishReason.FINISH_REASON_UNSPECIFIED
  );
}

function mapLlmFinishReasonToOpenAI(
  llmReason?: FinishReason,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' {
  if (!llmReason) {
    return 'stop';
  }

  switch (llmReason) {
    case FinishReason.STOP:
      return 'stop';
    case FinishReason.MAX_TOKENS:
      return 'length';
    case FinishReason.SAFETY:
    case FinishReason.RECITATION:
    case FinishReason.BLOCKLIST:
    case FinishReason.PROHIBITED_CONTENT:
    case FinishReason.SPII:
    case FinishReason.IMAGE_SAFETY:
    case FinishReason.IMAGE_RECITATION:
    case FinishReason.IMAGE_PROHIBITED_CONTENT:
    case FinishReason.IMAGE_OTHER:
      return 'content_filter';
    case FinishReason.NO_IMAGE:
      return 'stop';
    default:
      return 'stop';
  }
}

/** Type guard: is this an assistant message with at least one tool call? */
function hasToolCalls(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): message is OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  tool_calls: OpenAI.Chat.ChatCompletionMessageToolCall[];
} {
  return (
    message.role === 'assistant' &&
    'tool_calls' in message &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  );
}

function isSplitToolMediaMessage(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): boolean {
  if (
    message.role !== 'user' ||
    !('content' in message) ||
    !Array.isArray(message.content)
  ) {
    return false;
  }

  const firstPart = message.content[0] as
    | { type?: string; text?: string }
    | undefined;
  return firstPart?.type === 'text' && firstPart.text === SPLIT_TOOL_MEDIA_TEXT;
}

/**
 * Clean up orphaned tool calls from message history to prevent OpenAI API errors.
 *
 * Assumes consecutive assistant messages have already been merged.
 */
function cleanOrphanedToolCalls(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const cleaned: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const validToolCallsByAssistant = new Map<
    number,
    OpenAI.Chat.ChatCompletionMessageToolCall[]
  >();
  const validToolResponseIndexesByAssistant = new Map<number, number[]>();
  const splitMediaIndexesByAssistant = new Map<number, number[]>();
  const emittedWithAssistant = new Set<number>();
  const survivingToolCallIds = new Set<string>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (hasToolCalls(message)) {
      const candidateToolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] =
        [];
      const candidateToolCallIds = new Set<string>();
      for (const toolCall of message.tool_calls) {
        const id = toolCall.id;
        if (!id || survivingToolCallIds.has(id)) {
          continue;
        }
        if (candidateToolCallIds.has(id)) {
          continue;
        }
        candidateToolCallIds.add(id);
        candidateToolCalls.push(toolCall);
      }

      const adjacentToolResponseIds = new Set<string>();
      const toolResponseIndexes: number[] = [];
      const splitMediaIndexes: number[] = [];
      let lastToolResponseMatchesAssistant = false;

      for (
        let nextIndex = index + 1;
        nextIndex < messages.length;
        nextIndex += 1
      ) {
        const nextMessage = messages[nextIndex];
        if (nextMessage.role === 'tool' && 'tool_call_id' in nextMessage) {
          if (!nextMessage.tool_call_id) {
            lastToolResponseMatchesAssistant = false;
            continue;
          }

          if (
            candidateToolCallIds.has(nextMessage.tool_call_id) &&
            !adjacentToolResponseIds.has(nextMessage.tool_call_id)
          ) {
            adjacentToolResponseIds.add(nextMessage.tool_call_id);
            toolResponseIndexes.push(nextIndex);
            lastToolResponseMatchesAssistant = true;
          } else {
            lastToolResponseMatchesAssistant = false;
          }

          // Other tool responses in this block may belong to another assistant.
          continue;
        }

        if (isSplitToolMediaMessage(nextMessage)) {
          if (lastToolResponseMatchesAssistant) {
            splitMediaIndexes.push(nextIndex);
          }
          continue;
        }

        if (nextMessage.role === 'assistant' && !hasToolCalls(nextMessage)) {
          // Consecutive assistant turns are merged before cleanup.
          continue;
        }

        break;
      }

      const validToolCalls = candidateToolCalls.filter((toolCall) =>
        adjacentToolResponseIds.has(toolCall.id),
      );
      for (const toolCall of validToolCalls) {
        survivingToolCallIds.add(toolCall.id);
      }
      validToolCallsByAssistant.set(index, validToolCalls);
      validToolResponseIndexesByAssistant.set(index, toolResponseIndexes);
      splitMediaIndexesByAssistant.set(index, splitMediaIndexes);
    }
  }

  for (let index = 0; index < messages.length; index += 1) {
    if (emittedWithAssistant.has(index)) {
      continue;
    }

    const message = messages[index];
    if (hasToolCalls(message)) {
      const reasoningContent = (
        message as ExtendedChatCompletionAssistantMessageParam
      ).reasoning_content;
      const validToolCalls = validToolCallsByAssistant.get(index) ?? [];

      if (validToolCalls.length > 0) {
        const cleanedMessage = { ...message };
        (
          cleanedMessage as OpenAI.Chat.ChatCompletionMessageParam & {
            tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
          }
        ).tool_calls = validToolCalls;
        cleaned.push(cleanedMessage);

        for (const toolResponseIndex of validToolResponseIndexesByAssistant.get(
          index,
        ) ?? []) {
          const toolResponse = messages[toolResponseIndex];
          if (toolResponse) {
            cleaned.push(toolResponse);
            emittedWithAssistant.add(toolResponseIndex);
          }
        }

        for (const splitMediaIndex of splitMediaIndexesByAssistant.get(index) ??
          []) {
          const splitMediaMessage = messages[splitMediaIndex];
          if (splitMediaMessage) {
            cleaned.push(splitMediaMessage);
            emittedWithAssistant.add(splitMediaIndex);
          }
        }
      } else if (
        (typeof message.content === 'string' && message.content.trim()) ||
        reasoningContent
      ) {
        // Keep text/reasoning content, but remove orphaned tool calls.
        const cleanedMessage = { ...message };
        delete (
          cleanedMessage as OpenAI.Chat.ChatCompletionMessageParam & {
            tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
          }
        ).tool_calls;
        cleaned.push(cleanedMessage);
      } else {
        debugLogger.debug(
          `cleanOrphanedToolCalls: dropping assistant with ${message.tool_calls.length} orphaned tool call(s) and no text/reasoning content`,
        );
      }
    } else if (message.role === 'tool' && 'tool_call_id' in message) {
      debugLogger.debug(
        `cleanOrphanedToolCalls: dropping orphaned tool response ${message.tool_call_id || '<empty>'}`,
      );
    } else if (isSplitToolMediaMessage(message)) {
      debugLogger.debug(
        'cleanOrphanedToolCalls: dropping orphaned split tool media message',
      );
    } else {
      cleaned.push(message);
    }
  }

  return cleaned;
}

/**
 * Merge consecutive assistant messages to combine split text and tool calls.
 */
function mergeConsecutiveAssistantMessages(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const merged: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'assistant' && merged.length > 0) {
      const lastMessage = merged[merged.length - 1];

      // If the last message is also an assistant message, merge them
      if (lastMessage.role === 'assistant') {
        const lastToolCalls =
          'tool_calls' in lastMessage ? lastMessage.tool_calls || [] : [];
        const currentToolCalls =
          'tool_calls' in message ? message.tool_calls || [] : [];
        // Combine content
        const lastContent = lastMessage.content;
        const currentContent = message.content;

        // Determine if we should use array format (if either content is an array)
        const useArrayFormat =
          Array.isArray(lastContent) || Array.isArray(currentContent);

        let combinedContent:
          | string
          | OpenAI.Chat.ChatCompletionContentPart[]
          | null;

        if (useArrayFormat) {
          // Convert both to array format and merge
          const lastParts = Array.isArray(lastContent)
            ? lastContent
            : typeof lastContent === 'string' && lastContent
              ? [{ type: 'text' as const, text: lastContent }]
              : [];

          const currentParts = Array.isArray(currentContent)
            ? currentContent
            : typeof currentContent === 'string' && currentContent
              ? [{ type: 'text' as const, text: currentContent }]
              : [];

          combinedContent = [
            ...lastParts,
            ...currentParts,
          ] as OpenAI.Chat.ChatCompletionContentPart[];
        } else {
          // Both are strings or null, merge as strings
          const lastText = typeof lastContent === 'string' ? lastContent : '';
          const currentText =
            typeof currentContent === 'string' ? currentContent : '';
          const mergedText = [lastText, currentText].filter(Boolean).join('');
          combinedContent = mergedText || null;
        }

        // Combine tool calls
        const combinedToolCalls = [...lastToolCalls, ...currentToolCalls];

        // Update the last message with combined data
        (
          lastMessage as OpenAI.Chat.ChatCompletionMessageParam & {
            content: string | OpenAI.Chat.ChatCompletionContentPart[] | null;
            tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
          }
        ).content = combinedContent || null;
        if (combinedToolCalls.length > 0) {
          (
            lastMessage as OpenAI.Chat.ChatCompletionMessageParam & {
              content: string | OpenAI.Chat.ChatCompletionContentPart[] | null;
              tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
            }
          ).tool_calls = combinedToolCalls;
        }

        // Combine reasoning_content the same way content is combined. Otherwise
        // the merged-away turn's reasoning is silently dropped, while
        // cleanOrphanedToolCalls (which also merges assistant turns) keeps it.
        const lastReasoning = (
          lastMessage as ExtendedChatCompletionAssistantMessageParam
        ).reasoning_content;
        const currentReasoning = (
          message as ExtendedChatCompletionAssistantMessageParam
        ).reasoning_content;
        const combinedReasoning = [lastReasoning, currentReasoning]
          .filter(Boolean)
          .join('');
        if (combinedReasoning) {
          (
            lastMessage as ExtendedChatCompletionAssistantMessageParam
          ).reasoning_content = combinedReasoning;
        }

        continue; // Skip adding the current message since it's been merged
      }
    }

    // Add the message as-is if no merging is needed
    merged.push(message);
  }

  return merged;
}

export const OpenAIContentConverter = {
  convertLlmToolParametersToOpenAI,
  convertLlmToolsToOpenAI,
  convertLlmRequestToOpenAI,
  convertLlmResponseToOpenAI,
  convertOpenAIResponseToLlm,
  convertOpenAIChunkToLlm,
};
