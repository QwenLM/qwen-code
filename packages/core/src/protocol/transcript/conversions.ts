/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Message construction and transcript conversion helpers.
 *
 * These factory functions create runtime messages with consistent UUID and
 * timestamp fields. They should be preferred over ad-hoc object literals for
 * any message that enters the runtime array.
 */

import { randomUUID } from 'node:crypto';
import type { ModelMessage } from '../../provider/event/modelCompleteEvent.js';
import type { ToolResultBlock } from '../../core/tool-result.js';
import type { ToolResultContentPart } from '../../tools/tool-result-message.js';
import type { ModelInputContentBlock } from '../../provider/modelStreamRequest.js';
import type { McpInfo } from '../../mcp/tools/mcp-tool.js';
import type { NonNullableUsage } from '../schemas/common.js';
import { cloneUsage } from '../provider/empty-usage.js';
import type {
  AssistantMessage,
  ContentBlockParam,
  HumanInputSnapshot,
  SystemMessage,
  SystemSubtype,
  ToolResultBlockParam,
  UserMessage,
  Message,
} from './message.js';
import { LOCAL_COMMAND_CAVEAT } from '../../constants/xmlTags.js';
import type { TranscriptMessage } from './entry.js';
import { SYNTHETIC_MODEL } from '../provider/request-converter.js';

// ---------------------------------------------------------------------------
// createAssistantMessage
// ---------------------------------------------------------------------------

/** 推理结果进入会话的边界；标准模型载荷不直接进入历史数组或落盘。 */
export function createAssistantMessage(
  result: ModelMessage,
  requestId?: string,
  mcpToolIdentities?: Readonly<Record<string, McpInfo>>,
  usage?: NonNullableUsage,
  responseGroupId?: string,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: modelMessageToAssistantPayload(result, mcpToolIdentities, usage),
    requestId,
    ...(responseGroupId !== undefined ? { responseGroupId } : {}),
  };
}

export function modelMessageToAssistantPayload(
  result: ModelMessage,
  mcpToolIdentities?: Readonly<Record<string, McpInfo>>,
  hostUsage?: NonNullableUsage,
): AssistantMessage['message'] {
  const usage =
    hostUsage ??
    (result.usage
      ? {
          ...cloneUsage(),
          input_tokens: result.usage.inputTokens ?? 0,
          output_tokens: result.usage.outputTokens ?? 0,
          cache_read_input_tokens: result.usage.cacheReadInputTokens ?? 0,
          cache_creation_input_tokens:
            result.usage.cacheCreationInputTokens ?? 0,
        }
      : undefined);
  return {
    id: result.messageId,
    type: 'message',
    role: 'assistant',
    model: result.model,
    stop_reason: result.stopReason ?? null,
    stop_sequence: null,
    container: null,
    context_management: null,
    ...(usage ? { usage } : {}),
    // map 保留稀疏 index；不补交消费者尚未见过的完成块。
    content: result.blocks.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: block.type, text: block.text, citations: null };
        case 'thinking':
          return {
            type: block.type,
            thinking: block.thinking,
            signature: block.signature ?? '',
            ...(block.reasoning
              ? { reasoning_item: structuredClone(block.reasoning) }
              : {}),
          };
        case 'redacted_thinking':
          return {
            type: block.type,
            data: block.data,
            ...(block.reasoning
              ? { reasoning_item: structuredClone(block.reasoning) }
              : {}),
          };
        case 'tool_use': {
          const identity = mcpToolIdentities?.[block.id];
          return {
            type: block.type,
            id: block.id,
            name: block.name,
            input: structuredClone(block.input),
            ...(block.inputJson !== undefined
              ? { inputJson: block.inputJson }
              : {}),
            ...(block.thoughtSignature !== undefined
              ? { thoughtSignature: block.thoughtSignature }
              : {}),
            ...(identity ? { mcpInfo: { ...identity } } : {}),
          };
        }
        default:
          throw new Error('不支持的模型完成内容块');
      }
    }),
  };
}

/** 会话输入进入请求边界时转换媒体及缓存字段，不改变历史对象。 */
export function transcriptInputToModelBlock(
  block: Exclude<ContentBlockParam, ToolResultBlockParam>,
): ModelInputContentBlock {
  const cache = block.cache_control
    ? { cacheControl: { ...block.cache_control } }
    : {};
  if (block.type === 'text')
    return { type: 'text', text: block.text, ...cache };
  return {
    type: 'image',
    source:
      block.source.type === 'url'
        ? { ...block.source }
        : {
            type: 'base64',
            mediaType: block.source.media_type,
            data: block.source.data,
          },
    ...cache,
  };
}

/** 标准输入进入会话时恢复稳定媒体及缓存字段，不重排原始内容块。 */
export function modelInputToTranscriptBlock(
  block: ModelInputContentBlock,
): Exclude<ContentBlockParam, ToolResultBlockParam> {
  return inputPartToTranscriptBlock(block);
}

/** 工具执行结果进入会话的边界；不经模型请求契约回投影。 */
export function toolResultPartToTranscriptBlock(
  part: ToolResultContentPart,
): Exclude<ContentBlockParam, ToolResultBlockParam> {
  return inputPartToTranscriptBlock(part);
}

/** 共享字段映射机制，各入口仍保留各自领域的入参契约。 */
function inputPartToTranscriptBlock(
  block: ModelInputContentBlock | ToolResultContentPart,
): Exclude<ContentBlockParam, ToolResultBlockParam> {
  const cache = block.cacheControl
    ? { cache_control: { ...block.cacheControl } }
    : {};
  if (block.type === 'text')
    return { type: 'text', text: block.text, ...cache };
  return {
    type: 'image',
    source:
      block.source.type === 'url'
        ? { ...block.source }
        : {
            type: 'base64',
            media_type: block.source.mediaType,
            data: block.source.data,
          },
    ...cache,
  };
}

// ---------------------------------------------------------------------------
// createAssistantAPIErrorMessage
// ---------------------------------------------------------------------------

/**
 * Creates a synthetic AssistantMessage representing an API error.
 *
 * These messages are persisted to the transcript for error traceability but
 * are automatically filtered out by `normalizeMessagesForAPI` (via the
 * `isSyntheticApiErrorMessage` check) so they never reach the model.
 *
 * The synthetic stop shape deliberately differs from a real model response:
 * callers must use the surrounding terminal result to determine failure.
 */
export function createAssistantAPIErrorMessage({
  content,
  error,
  errorDetails,
  displayErrorCode,
  errorFallbackMessage,
  modelError,
  isContentFilteredMessage,
}: {
  content: string;
  error?: string;
  errorDetails?: string;
  displayErrorCode?: string | number;
  errorFallbackMessage?: string;
  modelError?: AssistantMessage['modelError'];
  isContentFilteredMessage?: boolean;
}): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: SYNTHETIC_MODEL,
      stop_reason: null,
      stop_sequence: null,
      container: null,
      context_management: null,
      content: [{ type: 'text', text: content || '[No content]' }],
    },
    isApiErrorMessage: true,
    error,
    errorDetails,
    displayErrorCode,
    errorFallbackMessage,
    ...(modelError ? { modelError } : {}),
    ...(isContentFilteredMessage ? { isContentFilteredMessage: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// createUserMessage
// ---------------------------------------------------------------------------

/**
 * Creates a `UserMessage` from a plain-text prompt.
 *
 * Use `createToolResultMessage()` when the content represents tool output.
 */
export function createUserMessage(
  prompt: UserMessage['message']['content'],
  options?: {
    uuid?: string;
    timestamp?: string;
    isMeta?: boolean;
    isVisibleInTranscriptOnly?: boolean;
    isVirtual?: boolean;
    isCompactSummary?: boolean;
    permissionMode?: string;
    origin?: { kind: 'human' | string };
    humanInput?: HumanInputSnapshot;
    requestSetId?: string;
    businessModelKey?: string;
    businessIdentity?: UserMessage['businessIdentity'];
  },
): UserMessage {
  return {
    type: 'user',
    uuid: options?.uuid ?? randomUUID(),
    timestamp: options?.timestamp ?? new Date().toISOString(),
    message: {
      role: 'user',
      content: typeof prompt === 'string' ? prompt : [...prompt],
    },
    isMeta: options?.isMeta,
    isVisibleInTranscriptOnly: options?.isVisibleInTranscriptOnly,
    isVirtual: options?.isVirtual,
    isCompactSummary: options?.isCompactSummary,
    permissionMode: options?.permissionMode,
    origin: options?.origin,
    ...(options?.requestSetId ? { requestSetId: options.requestSetId } : {}),
    ...(options?.businessModelKey
      ? { businessModelKey: options.businessModelKey }
      : {}),
    ...(options?.businessIdentity ? { businessIdentity: { ...options.businessIdentity } } : {}),
    ...(options?.humanInput ? { humanInput: options.humanInput } : {}),
  };
}

// ---------------------------------------------------------------------------
// createSyntheticUserCaveatMessage
// ---------------------------------------------------------------------------

/**
 * Creates a synthetic caveat message for local commands (bash, slash).
 * A new message is created each call because messages must have unique uuids.
 */
export function createSyntheticUserCaveatMessage(): UserMessage {
  return createUserMessage(LOCAL_COMMAND_CAVEAT, { isMeta: true });
}

// ---------------------------------------------------------------------------
// createToolResultMessage
// ---------------------------------------------------------------------------

/**
 * Creates a `UserMessage` that wraps tool_result content blocks.
 *
 * `sourceToolAssistantUUID` links the tool output back to the assistant
 * message that requested the tool call.
 */
export function createToolResultMessage(
  results: ToolResultBlock[],
  assistantUuid: string,
  options: { promptId?: string } = {},
): UserMessage {
  const content: ContentBlockParam[] = results.map(
    (r): ToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: r.tool_use_id,
      content:
        typeof r.content === 'string'
          ? r.content
          : r.content.map(toolResultPartToTranscriptBlock),
      ...(r.is_error ? { is_error: true } : {}),
    }),
  );

  const toolUseResults = results.map((result) => result.toolUseResult);
  const hasAnyToolUseResult = toolUseResults.some(
    (result) => result !== undefined,
  );
  const mcpMetas = results.map((result) => result.mcpMeta ?? null);
  const hasAnyMcpMeta = mcpMetas.some((meta) => meta !== null);
  const readReplacements = results.map(
    (result) => result.readOutputReplacement ?? null,
  );
  const toolDenialKinds = results.map((result) => result.toolDenialKind);
  const hasAnyToolDenialKind = toolDenialKinds.some(
    (kind) => kind !== undefined,
  );
  const userFeedback = results.map((result) => result.userFeedback);
  const hasAnyUserFeedback = userFeedback.some(
    (feedback) => feedback !== undefined,
  );

  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content,
    },
    sourceToolAssistantUUID: assistantUuid,
    ...(readReplacements.some((value) => value !== null)
      ? {
          readOutputReplacement:
            results.length === 1
              ? results[0].readOutputReplacement
              : readReplacements,
        }
      : {}),
    ...(options.promptId ? { promptId: options.promptId } : {}),
    toolUseResult:
      results.length === 1
        ? results[0]?.toolUseResult
        : hasAnyToolUseResult
          ? toolUseResults
          : undefined,
    mcpMeta:
      results.length === 1
        ? results[0]?.mcpMeta
        : hasAnyMcpMeta
          ? mcpMetas
          : undefined,
    toolDenialKind:
      results.length === 1
        ? results[0]?.toolDenialKind
        : hasAnyToolDenialKind
          ? toolDenialKinds
          : undefined,
    userFeedback:
      results.length === 1
        ? results[0]?.userFeedback
        : hasAnyUserFeedback
          ? userFeedback
          : undefined,
  };
}

// ---------------------------------------------------------------------------
// createSystemMessage
// ---------------------------------------------------------------------------

/**
 * Creates a `SystemMessage` for internal events and legacy transcript records.
 *
 * Local command context that should be visible to the model is now stored as
 * meta user messages at the source.
 */
export function createSystemMessage(
  subtype: SystemSubtype,
  content: string,
  level: 'info' | 'error' = 'info',
): SystemMessage {
  return {
    type: 'system',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    subtype,
    content,
    level,
  };
}

// ---------------------------------------------------------------------------
// transcriptToMessage
// ---------------------------------------------------------------------------

/**
 * Strips transcript-only chain metadata from a `TranscriptMessage`, producing
 * a runtime `Message`.
 *
 * Session context fields remain on the returned value so resumed conversations
 * still carry the metadata needed by later persistence and API-projection code.
 */
export function transcriptToMessage(entry: TranscriptMessage): Message {
  // Destructure out the chain metadata fields, keep everything else
  const {
    parentUuid: _parentUuid,
    logicalParentUuid: _logicalParentUuid,
    isSidechain: _isSidechain,
    ...message
  } = entry;

  return message as Message;
}
