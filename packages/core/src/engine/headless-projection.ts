/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview SDK projection helpers — convert internal Message/QueryEvent
 * shapes into the SDKMessage stream that headless CLI / SDK consumers
 * see. Shared between the live agent loop projection in QueryEngine and the
 * post-compact replay projection used by the headless slash dispatcher so the
 * two paths cannot drift.
 */

import { cloneUsage } from '../protocol/provider/empty-usage.js';
import { createToolResultMessage, transcriptInputToModelBlock } from '../protocol/transcript/conversions.js';
import type { ToolResultBlock } from '../core/tool-result.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type {
  SDKAssistantMessage,
  SDKCodeModeHostResult,
  SDKMessage,
  SDKMessageOrigin,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from '../protocol/schemas/sdk-message.js';
import type {
  ModelStreamEvent,
  ModelStreamUsage,
} from '../provider/event/modelStreamEvent.js';
import type { QueryEvent } from '../core/query-event.js';
import type { ModelMessage } from '../provider/event/modelCompleteEvent.js';
import type {
  ModelCacheControl,
  ModelInputContentBlock,
  ModelStreamUserContent,
  ModelStreamToolResultMessage,
} from '../provider/modelStreamRequest.js';
import { detectImageFormatFromBuffer } from '../utils/imageReader.js';
import {
  normalizeImageMediaType,
  unsupportedImagePlaceholder,
} from '../utils/supportedImageTypes.js';
import type { McpInfo } from '../mcp/tools/mcp-tool.js';
import type { MessageOrigin } from '../input/types.js';
import { ENV_EXPOSE_REQUEST_ID, readBrandEnv } from '../config/brand.js';
import { shouldExposeTokenUsage } from '../protocol/token-usage-visibility.js';
import type {
  AssistantMessage,
  ContentBlockParam,
  Message,
  UserMessage,
} from '../protocol/transcript/message.js';
import {
  projectMcpHostEnvelope,
  selectMcpResultMeta,
  selectToolResultSideChannel,
} from '../protocol/transcript/tool-result-side-channel.js';
import { projectFileToolResultForExternalUse } from '../tools/file-tool-result-projection.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function shouldExposeAssistantRequestId(): boolean {
  return readBrandEnv(ENV_EXPOSE_REQUEST_ID)?.trim().toLowerCase() === 'true';
}

function normalizeAssistantRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function isSyntheticTranscriptMessage(event: {
  isCompactSummary?: boolean;
  isMeta?: boolean;
  isVisibleInTranscriptOnly?: boolean;
}): boolean {
  return (
    event.isCompactSummary === true ||
    event.isMeta === true ||
    event.isVisibleInTranscriptOnly === true
  );
}

/** 将内部消息来源投影为可安全暴露给 SDK 的最小字段集合。 */
export function projectMessageOriginForSdk(
  origin: MessageOrigin | undefined,
): SDKMessageOrigin | undefined {
  if (!origin || origin.kind === 'coordinator') {
    return undefined;
  }

  switch (origin.kind) {
    case 'task-notification':
    case 'human':
      return { kind: origin.kind };
    case 'bridge':
      return {
        kind: 'bridge',
        ...(origin.sessionId !== undefined
          ? { sessionId: origin.sessionId }
          : {}),
      };
    case 'peer':
      return {
        kind: 'peer',
        ...(origin.from !== undefined ? { from: origin.from } : {}),
        ...(origin.senderTaskId !== undefined
          ? { senderTaskId: origin.senderTaskId }
          : {}),
        ...(origin.name !== undefined ? { name: origin.name } : {}),
        ...(origin.body !== undefined ? { body: origin.body } : {}),
      };
    default:
      return undefined;
  }
}

/**
 * Project an internal task-lifecycle event onto the public SDK wire shape.
 *
 * Task controls can complete outside a model turn, so both QueryEngine and the
 * headless control plane use this helper. Keeping the projection here prevents
 * the two output paths from drifting.
 */
export function projectTaskSystemEventForSdk(
  event: Extract<QueryEvent, { type: 'system' }>,
  sessionId: string,
): SDKMessage {
  const {
    uuid,
    subtype,
    sessionId: _sessionId,
    timestamp: _timestamp,
    content: _content,
    level: _level,
    usage: _usage,
    tool_input: _toolInput,
    ...fields
  } = event;
  return {
    ...fields,
    type: 'system',
    subtype,
    uuid,
    session_id: event.sessionId ?? sessionId,
  } as unknown as SDKMessage;
}

/**
 * Normalize an arbitrary provider/runtime usage object into the complete
 * SDK `NonNullableUsage` shape while preserving any real counts it carries.
 *
 * Use this for internal accounting paths that need a structurally complete
 * usage object. Do not use it directly for headless / SDK stdout payloads,
 * because those public protocol surfaces must not expose token counts.
 */
export function cloneUsageWithDefaults(usage: unknown): NonNullableUsage {
  const base = cloneUsage();
  if (!isRecord(usage)) {
    return base;
  }

  const serverToolUse = isRecord(usage['server_tool_use'])
    ? usage['server_tool_use']
    : {};
  const cacheCreation = isRecord(usage['cache_creation'])
    ? usage['cache_creation']
    : {};

  return {
    ...base,
    ...usage,
    server_tool_use: {
      ...base.server_tool_use,
      ...serverToolUse,
    },
    cache_creation: {
      ...base.cache_creation,
      ...cacheCreation,
    },
    iterations: Array.isArray(usage['iterations'])
      ? [...usage['iterations']]
      : base.iterations,
  } as NonNullableUsage;
}

/**
 * Normalize usage for public headless / SDK protocol output.
 *
 * This intentionally reuses `cloneUsageWithDefaults` first so older consumers
 * still receive the full protocol shape. Token counts are hidden by default
 * and exposed only when the internal token-usage env switch is enabled, or when
 * a caller opts in via `exposeTokenCounts` (custom-provider responses, whose
 * tokens are accounted locally). Keeping both conditions here means the
 * exposure decision has exactly one home.
 */
export function cloneUsageForSdkOutput(
  usage: unknown,
  options?: { contextUsageRatio?: number; exposeTokenCounts?: boolean },
): NonNullableUsage {
  const projected = cloneUsageWithDefaults(usage) as NonNullableUsage &
    Record<string, unknown>;

  if (options?.exposeTokenCounts || shouldExposeTokenUsage()) {
    const exposed: NonNullableUsage & Record<string, unknown> = {
      ...projected,
      iterations: [...projected.iterations],
    };
    if (options?.contextUsageRatio !== undefined) {
      exposed['context_usage_ratio'] = options.contextUsageRatio;
    }
    return exposed;
  }

  const masked: NonNullableUsage & Record<string, unknown> = {
    ...projected,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { ...projected.server_tool_use },
    cache_creation: {
      ...projected.cache_creation,
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    iterations: [...projected.iterations],
  };

  for (const key of ['total_tokens', 'prompt_tokens', 'completion_tokens']) {
    if (key in masked) {
      masked[key] = 0;
    }
  }

  if (options?.contextUsageRatio !== undefined) {
    masked['context_usage_ratio'] = options.contextUsageRatio;
  }

  return masked;
}

/** 压缩事件只对外暴露上下文比例和费用，不补齐通用 usage 字段。 */
export function projectCompactUsageForSdk(
  usage: unknown,
): { context_usage_ratio?: number; credits?: number } {
  const source = usage && typeof usage === 'object'
    ? usage as Record<string, unknown>
    : {};
  return {
    ...(typeof source['context_usage_ratio'] === 'number'
      ? { context_usage_ratio: source['context_usage_ratio'] } : {}),
    ...(typeof source['credits'] === 'number'
      ? { credits: source['credits'] } : {}),
  };
}

/**
 * Project session-cumulative token usage for an SDK result. Request-scoped
 * Billing metadata belongs on assistant/stream usage and is removed here
 * so `total_credits` remains the single session-level result value.
 */
export function cloneUsageForSdkResult(usage: unknown): NonNullableUsage {
  const projected = cloneUsageForSdkOutput(usage);
  delete projected.credits;
  delete projected.original_credits;
  delete projected.billable;
  return projected;
}

/** 标准模型用量仅在协议出口转换，不回流到内部统计或历史。 */
function projectStreamUsageForSdk(
  usage: ModelStreamUsage | undefined,
  requestId?: string,
): NonNullableUsage {
  return cloneUsageForSdkOutput({
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    cache_read_input_tokens: usage?.cacheReadInputTokens ?? 0,
    cache_creation_input_tokens: usage?.cacheCreationInputTokens ?? 0,
    ...(requestId ? { request_id: requestId } : {}),
  });
}

/** 标准模型原语到 SDK 协议的唯一出口，保留时序、身份与用量屏蔽。 */
export function projectModelStreamEventForSdk(
  event: ModelStreamEvent,
  requestId?: string,
): SDKPartialAssistantMessage['event'] {
  switch (event.type) {
    case 'message_start':
      return {
        type: event.type,
        message: {
          id: event.message.id,
          type: 'message',
          role: 'assistant',
          model: event.message.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          container: null,
          context_management: null,
          usage: projectStreamUsageForSdk(event.message.usage, requestId),
        },
      };
    case 'content_block_start': {
      const block = event.contentBlock;
      switch (block.type) {
        case 'text':
          return {
            type: event.type,
            index: event.index,
            content_block: { ...block, citations: null },
          };
        case 'thinking': {
          const { reasoning, ...content } = block;
          return {
            type: event.type,
            index: event.index,
            content_block: {
              ...content,
              signature: '',
              ...(reasoning
                ? { reasoning_item: structuredClone(reasoning) }
                : {}),
            },
          };
        }
        case 'redacted_thinking': {
          const { reasoning, ...content } = block;
          return {
            type: event.type,
            index: event.index,
            content_block: {
              ...content,
              ...(reasoning
                ? { reasoning_item: structuredClone(reasoning) }
                : {}),
            },
          };
        }
        case 'tool_use':
          return {
            type: event.type,
            index: event.index,
            content_block: structuredClone(block),
          };
        default:
          throw new Error('不支持的模型内容块');
      }
    }
    case 'content_block_stop':
      return {
        type: event.type,
        index: event.index,
        ...(event.reasoning
          ? { reasoning_item: structuredClone(event.reasoning) }
          : {}),
      };
    case 'message_delta':
      return {
        type: event.type,
        context_management: null,
        delta: {
          stop_reason: event.delta.stopReason,
          stop_sequence: null,
          container: null,
        },
        usage: projectStreamUsageForSdk(event.usage, requestId),
      };
    case 'content_block_delta':
    case 'message_stop':
      return structuredClone(event);
    default:
      throw new Error('不支持的模型流事件');
  }
}

/**
 * Mask the per-model token breakdown on result messages. Non-token metadata
 * such as cost placeholders, context window, and web-search counts is left in
 * place so the SDK result shape remains backward compatible.
 */
type SdkModelUsageLike = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

export function maskModelUsageForSdkOutput<
  T extends Record<string, SdkModelUsageLike>,
>(modelUsage: T): T {
  if (shouldExposeTokenUsage()) {
    const exposed: Record<string, SdkModelUsageLike> = {};
    for (const [model, usage] of Object.entries(modelUsage)) {
      exposed[model] = { ...usage };
    }
    return exposed as T;
  }

  const masked: Record<string, SdkModelUsageLike> = {};
  for (const [model, usage] of Object.entries(modelUsage)) {
    masked[model] = {
      ...usage,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
  }
  return masked as T;
}

export function deriveSdkProjectionUuid(
  baseUuid: string,
  index: number,
  shouldDerive: boolean,
): string {
  if (!shouldDerive) {
    return baseUuid;
  }

  const hex = index.toString(16).padStart(12, '0');
  return `${baseUuid.slice(0, 24)}${hex}`;
}

export function shouldEmitChildAssistantBlock(
  block: SDKAssistantMessage['message']['content'][number],
  parentToolUseId: string | null | undefined,
): boolean {
  if (!parentToolUseId) {
    return true;
  }

  return block.type === 'tool_use';
}

/** 标准完成消息只在 SDK 出口生成协议外壳及块默认值。 */
export function projectModelMessageForSdk(
  message: ModelMessage,
  requestId?: string,
  mcpToolIdentities?: Readonly<Record<string, McpInfo>>,
): Pick<SDKAssistantMessage, 'message' | 'request_id'> {
  const normalizedRequestId = normalizeAssistantRequestId(requestId);
  return {
    message: {
      id: message.messageId,
      type: 'message',
      role: 'assistant',
      model: message.model,
      container: null,
      context_management: null,
      stop_reason: message.stopReason ?? null,
      stop_sequence: null,
      usage: projectStreamUsageForSdk(message.usage, requestId),
      content: message.blocks.flatMap<
        SDKAssistantMessage['message']['content'][number]
      >((block) => {
        switch (block.type) {
          case 'text':
            return [{ type: block.type, text: block.text, citations: null }];
          case 'thinking':
            return [
              {
                type: block.type,
                thinking: block.thinking,
                signature: block.signature ?? '',
                ...(block.reasoning
                  ? { reasoning_item: structuredClone(block.reasoning) }
                  : {}),
              },
            ];
          case 'redacted_thinking':
            return [
              {
                type: block.type,
                data: block.data,
                ...(block.reasoning
                  ? { reasoning_item: structuredClone(block.reasoning) }
                  : {}),
              },
            ];
          case 'tool_use': {
            const identity = mcpToolIdentities?.[block.id];
            return [
              {
                type: block.type,
                id: block.id,
                name: block.name,
                input: structuredClone(block.input),
                ...(identity ? { mcpInfo: { ...identity } } : {}),
              },
            ];
          }
          default:
            throw new Error('不支持的模型内容块');
        }
      }),
    },
    ...(shouldExposeAssistantRequestId() && normalizedRequestId
      ? { request_id: normalizedRequestId }
      : {}),
  };
}

export function projectAssistantPayloadForSdk(
  message: ModelMessage,
  requestId?: unknown,
  mcpToolIdentities?: Readonly<Record<string, McpInfo>>,
  hostUsage?: NonNullableUsage,
): Pick<SDKAssistantMessage, 'message' | 'request_id'> {
  const normalizedRequestId =
    normalizeAssistantRequestId(requestId) ??
    normalizeAssistantRequestId(hostUsage?.request_id);
  const projected = projectModelMessageForSdk(
    message,
    normalizedRequestId,
    mcpToolIdentities,
  );
  return {
    ...projected,
    message: {
      ...projected.message,
      ...(hostUsage ? { usage: cloneUsageForSdkOutput(hostUsage) } : {}),
    },
  };
}

export function splitAssistantForSdk(
  event: AssistantMessage,
  sessionId: string,
): SDKAssistantMessage[] {
  const requestId =
    normalizeAssistantRequestId(event.requestId) ??
    normalizeAssistantRequestId(event.message.usage?.request_id);
  const projected: Pick<SDKAssistantMessage, 'message' | 'request_id'> = {
    message: {
      ...structuredClone(event.message),
      content: event.message.content.map((block) => {
        if (block.type === 'tool_use') {
          // 原始参数 JSON 仅供历史请求重建，不属于 SDK 内容块契约。
          const { inputJson: _inputJson, ...content } = block;
          return structuredClone(content);
        }
        return block.type === 'text'
          ? { ...block, citations: block.citations ?? null }
          : structuredClone(block);
      }),
      usage: cloneUsageForSdkOutput(event.message.usage, {
        exposeTokenCounts: event.modelSource === 'custom',
      }),
    },
    ...(shouldExposeAssistantRequestId() && requestId
      ? { request_id: requestId }
      : {}),
  };
  const content = projected.message.content;
  const parentToolUseId = event.parent_tool_use_id ?? null;
  const shouldDeriveUuid = content.length > 1;

  return content
    .filter((block) => shouldEmitChildAssistantBlock(block, parentToolUseId))
    .map(
      (block, index) =>
        ({
          type: 'assistant',
          ...projected,
          message: {
            ...projected.message,
            content: [block],
          },
          parent_tool_use_id: parentToolUseId,
          ...(event.aborted === true ? { aborted: true as const } : {}),
          uuid: deriveSdkProjectionUuid(event.uuid, index, shouldDeriveUuid),
          session_id: event.session_id ?? event.sessionId ?? sessionId,
        }) satisfies SDKAssistantMessage,
    );
}

/** SDK／远端网络入口校验文本和图片，并立即转换成标准模型输入块。 */
export function parseSdkInputBlock(
  value: unknown,
): ModelInputContentBlock | undefined {
  if (!isRecord(value) || Array.isArray(value)) return undefined;
  let cacheControl: ModelCacheControl | undefined;
  const cache = value['cache_control'];
  if (cache !== undefined && cache !== null) {
    if (!isRecord(cache) || cache['type'] !== 'ephemeral') return undefined;
    const ttl = cache['ttl'];
    if (ttl !== undefined && ttl !== '5m' && ttl !== '1h') return undefined;
    cacheControl = { type: 'ephemeral', ...(ttl !== undefined ? { ttl } : {}) };
  }
  if (value['type'] === 'text' && isString(value['text'])) {
    return {
      type: 'text',
      text: value['text'],
      ...(cacheControl ? { cacheControl } : {}),
    };
  }
  if (value['type'] !== 'image') return undefined;
  const source = value['source'];
  if (!isRecord(source)) return undefined;
  if (source['type'] === 'url' && isString(source['url'])) {
    return {
      type: 'image',
      source: { type: 'url', url: source['url'] },
      ...(cacheControl ? { cacheControl } : {}),
    };
  }
  if (source['type'] === 'base64' && isString(source['data'])) {
    const mediaType = isString(source['media_type'])
      ? source['media_type']
      : isString(source['mediaType'])
        ? source['mediaType']
        : detectImageFormatFromBuffer(
            Buffer.from(source['data'], 'base64').subarray(0, 16),
          );
    return {
      type: 'image',
      source: {
        type: 'base64',
        mediaType: normalizeImageMediaType(mediaType),
        data: source['data'],
      },
      ...(cacheControl ? { cacheControl } : {}),
    };
  }
  return undefined;
}

/** SDK 输入在边界拆成标准用户内容与独立工具结果；非法块拒绝整条消息。 */
export function parseSdkUserContent(value: unknown):
  | {
      content: ModelStreamUserContent;
      toolResults: readonly ModelStreamToolResultMessage[];
    }
  | undefined {
  if (typeof value === 'string') return { content: value, toolResults: [] };
  if (!Array.isArray(value)) return undefined;
  const content: ModelInputContentBlock[] = [];
  const toolResults: ModelStreamToolResultMessage[] = [];
  for (const block of value) {
    if (isRecord(block) && block['type'] === 'tool_result') {
      if (
        !isString(block['tool_use_id']) ||
        (block['is_error'] !== undefined && !isBoolean(block['is_error']))
      )
        return undefined;
      const result = parseSdkUserContent(block['content'] ?? '');
      if (!result || result.toolResults.length) return undefined;
      toolResults.push({
        role: 'tool',
        toolCallId: block['tool_use_id'],
        content: result.content,
        ...(isBoolean(block['is_error']) ? { isError: block['is_error'] } : {}),
      });
    } else {
      const input = parseSdkInputBlock(block);
      if (!input) return undefined;
      content.push(input);
    }
  }
  return { content, toolResults };
}

/** 标准输入仅在 SDK 回放／回执出口恢复正式协议载荷。 */
export function projectUserInputForSdk(
  content: ModelStreamUserContent,
  toolResults: readonly ModelStreamToolResultMessage[] = [],
): SDKUserMessage['message'] {
  if (typeof content === 'string' && !toolResults.length)
    return { role: 'user', content };
  return {
    role: 'user',
    content: [
      ...toolResults.map((result) => ({
        type: 'tool_result' as const,
        tool_use_id: result.toolCallId,
        ...(result.isError !== undefined ? { is_error: result.isError } : {}),
        content:
          typeof result.content === 'string'
            ? result.content
            : result.content.map(projectInputBlockForSdk),
      })),
      ...(typeof content === 'string'
        ? [{ type: 'text' as const, text: content }]
        : content.map(projectInputBlockForSdk)),
    ],
  };
}

/** 仅在 SDK 出口转换媒体与缓存字段，不向内部回传线协议块。 */
export function projectInputBlockForSdk(
  block: ModelInputContentBlock,
): Extract<
  Exclude<SDKUserMessage['message']['content'], string>[number],
  { type: 'text' | 'image' }
> {
  let cache_control: Extract<
    Exclude<SDKUserMessage['message']['content'], string>[number],
    { type: 'text' }
  >['cache_control'];
  if (block.cacheControl) {
    const ttl = block.cacheControl.ttl;
    if (ttl === undefined) {
      cache_control = { type: 'ephemeral' };
    } else if (ttl === '5m' || ttl === '1h') {
      cache_control = { type: 'ephemeral', ttl };
    } else {
      throw new Error(`Unsupported SDK cache TTL: ${ttl}`);
    }
  }
  if (block.type === 'text') {
    return {
      type: 'text',
      text: block.text,
      ...(cache_control ? { cache_control } : {}),
    };
  }
  const source = block.source;
  if (source.type === 'url') {
    return {
      type: 'image',
      source: { ...source },
      ...(cache_control ? { cache_control } : {}),
    };
  }
  const media_type = normalizeImageMediaType(source.mediaType);
  switch (media_type) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/gif':
    case 'image/webp':
      return {
        type: 'image',
        source: { type: 'base64', media_type, data: source.data },
        ...(cache_control ? { cache_control } : {}),
      };
    default:
      return {
        type: 'text',
        text: unsupportedImagePlaceholder(media_type),
        ...(cache_control ? { cache_control } : {}),
      };
  }
}

export function splitUserForSdk(
  event: UserMessage,
  sessionId: string,
): SDKMessage[] {
  const rawContent = event.message.content;
  const contentBlocks: ContentBlockParam[] =
    typeof rawContent === 'string'
      ? [{ type: 'text', text: rawContent }]
      : Array.isArray(rawContent)
        ? rawContent
        : [];
  const shouldDeriveUuid = contentBlocks.length > 1;
  const origin: SDKMessageOrigin | undefined =
    event.origin?.kind === 'task-notification'
      ? { kind: 'task-notification' }
      : undefined;
  const synthetic =
    origin?.kind === 'task-notification' || isSyntheticTranscriptMessage(event);
  const toolResultCount = contentBlocks.filter(
    (block) => block.type === 'tool_result',
  ).length;

  let toolResultIndex = 0;
  return contentBlocks.map((block, index) => {
    const sdkUserMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          block.type === 'tool_result'
            ? {
                type: 'tool_result',
                tool_use_id: block.tool_use_id,
                ...(block.is_error === undefined
                  ? {}
                  : { is_error: block.is_error }),
                content:
                  typeof block.content === 'string'
                    ? block.content
                    : block.content.map((part) =>
                        projectInputBlockForSdk(
                          transcriptInputToModelBlock(part),
                        ),
                      ),
              }
            : projectInputBlockForSdk(transcriptInputToModelBlock(block)),
        ],
      },
      parent_tool_use_id: event.parent_tool_use_id ?? null,
      session_id: event.sessionId ?? sessionId,
      uuid: deriveSdkProjectionUuid(event.uuid, index, shouldDeriveUuid),
      timestamp: event.timestamp,
      isSynthetic: synthetic,
      ...(origin === undefined ? {} : { origin }),
    };

    if (block.type === 'tool_result') {
      const currentToolResultIndex = toolResultIndex;
      toolResultIndex += 1;

      const toolUseResult = selectToolResultSideChannel(
        event.toolUseResult,
        currentToolResultIndex,
        toolResultCount,
      );
      const mcpMeta = selectMcpResultMeta(
        event.mcpMeta,
        currentToolResultIndex,
        toolResultCount,
      );
      if (toolUseResult !== undefined || mcpMeta !== undefined) {
        sdkUserMessage.tool_use_result = projectMcpHostEnvelope(
          mcpMeta === undefined
            ? projectFileToolResultForExternalUse(toolUseResult)
            : toolUseResult,
          mcpMeta,
        );
      }

      const nonExecutionKind = Array.isArray(event.toolDenialKind)
        ? event.toolDenialKind[currentToolResultIndex]
        : toolResultCount === 1
          ? event.toolDenialKind
          : undefined;
      const userFeedback = Array.isArray(event.userFeedback)
        ? event.userFeedback[currentToolResultIndex]
        : toolResultCount === 1
          ? event.userFeedback
          : undefined;
      if (nonExecutionKind) {
        sdkUserMessage.tool_result_meta = [
          {
            id: block.tool_use_id,
            non_execution_kind: nonExecutionKind,
            ...(typeof userFeedback === 'string'
              ? { user_feedback: userFeedback }
              : {}),
          },
        ];
      }
    }

    return sdkUserMessage;
  });
}

/** Project native text, images, file results and MCP metadata for the host. */
export function projectToolResultForHost(result: ToolResultBlock): SDKCodeModeHostResult {
  const [message] = splitUserForSdk(createToolResultMessage([result], ''), '');
  if (message?.type !== 'user' || !Array.isArray(message.message.content)) {
    throw new Error('Tool result projection did not produce a user message');
  }
  const block = message.message.content[0];
  if (block?.type !== 'tool_result') {
    throw new Error('Tool result projection did not produce a tool_result');
  }
  return {
    content: block.content as SDKCodeModeHostResult['content'],
    ...(block.is_error === undefined ? {} : { is_error: block.is_error }),
    ...(message.tool_use_result === undefined ? {} : { tool_use_result: message.tool_use_result }),
    ...(message.tool_result_meta === undefined ? {} : { tool_result_meta: message.tool_result_meta }),
  };
}

export function projectCompactBoundaryForSdk(
  message: Extract<Message, { type: 'system' }>,
  sessionId: string,
  fallbackTrigger: 'manual' | 'auto' = 'auto',
): SDKMessage {
  const md = message.compactMetadata;
  const compact_metadata = md
    ? {
        trigger: md.trigger,
        pre_tokens: md.preTokens,
        ...(md.postTokens !== undefined ? { post_tokens: md.postTokens } : {}),
        ...(md.messagesSummarized !== undefined
          ? { messages_summarized: md.messagesSummarized }
          : {}),
        ...(md.durationMs !== undefined ? { duration_ms: md.durationMs } : {}),
        ...(md.preservedSegment
          ? {
              preserved_segment: {
                head_uuid: md.preservedSegment.headUuid,
                anchor_uuid: md.preservedSegment.anchorUuid,
                tail_uuid: md.preservedSegment.tailUuid,
              },
            }
          : {}),
      }
    : { trigger: fallbackTrigger, pre_tokens: 0 };

  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata,
    ...(message.compactUsage ? { usage: projectCompactUsageForSdk(message.compactUsage) } : {}),
    ...(message.modelRequestIds ? { modelRequestIds: message.modelRequestIds } : {}),
    ...(message.agentId ? { agent_id: message.agentId } : {}),
    uuid: message.uuid,
    session_id: message.sessionId ?? sessionId,
  } as SDKMessage;
}
