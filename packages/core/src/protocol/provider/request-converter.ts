/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 请求历史准备：展开宿主上下文，生成并校验标准 ModelStreamMessage。
 * 工具配对、图片能力限制和缓存断点直接处理标准请求消息；协议映射由 Transport 负责。
 */

import type {
  ModelImageBlock,
  ModelStreamAssistantMessage,
  ModelStreamToolResultMessage,
  ModelStreamToolResultContent,
  ModelInputContentBlock,
  ModelStreamMessage,
  ModelStreamTextBlock,
  ModelStreamToolCall,
} from '../../provider/modelStreamRequest.js';
import type {
  ModelThinkingBlock,
  ModelRedactedThinkingBlock,
} from '../../provider/event/modelCompleteEvent.js';
import { sanitizeToolName } from '../../utils/tool-name-utils.js';
import { transcriptInputToModelBlock } from '../transcript/conversions.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  ENV_MAX_REQUEST_IMAGES,
  positiveIntegerFromEnv,
} from '../../config/brand.js';
import { addCacheBreakpoints } from '../../prompts/cache-control.js';
import { normalizeAttachmentForAPI } from '../../attachments/normalize.js';
import { restoreAttachment } from '../../attachments/transcript-conversion.js';
import type {
  Message,
  ContentBlockParam as RuntimeContentBlockParam,
} from '../transcript/message.js';
import { API_IMAGE_MAX_BASE64_SIZE } from '../../utils/constants.js';
import {
  EDIT_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from '../../tools/definitions/base-declarations.js';
import { projectRefusalContext } from './refusal-context.js';
import {
  isSupportedImageMediaType,
  normalizeImageMediaType,
  unsupportedImagePlaceholder,
} from '../../utils/supportedImageTypes.js';

// ---------------------------------------------------------------------------
// Vision capability gating
// ---------------------------------------------------------------------------

/**
 * Replacement text for history images that cannot be sent to the target model.
 *
 * Images already recorded in the transcript (pasted by the user, or returned by
 * an image tool read) stay in the durable history forever, but the active model
 * can change mid-session via `/model`. Emitting an `image_url` part to a model
 * without vision capability makes the provider reject the whole request
 * ("Unexpected item type in content."), which is not retryable and leaves the
 * session permanently stuck. Downgrading to text keeps the turn valid and tells
 * the model why the image is unavailable.
 */
export const NON_VISION_IMAGE_PLACEHOLDER =
  '[Image omitted: the current model does not support image input. ' +
  'Ask the user to switch to a vision-capable model if the image content is needed.]';

/** Options for {@link convertMessages}. */
export interface ConvertMessagesOptions {
  /**
   * Whether the target model accepts image input. Defaults to `true` so
   * existing callers keep the previous pass-through behaviour; the remote
   * request builder passes the same `is_vl` value it declares in
   * `model_config`, keeping payload and declared capability consistent.
   */
  supportsVision?: boolean;
  /** Images allowed in one request before older ones are trimmed. */
  maxRequestImages?: number;
}

// ---------------------------------------------------------------------------
// Message history sanitization — tool_use / tool_result pairing repair
// ---------------------------------------------------------------------------

const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  'Error: tool execution was interrupted (stream truncated)';

/**
 * 单次遍历修复标准工具调用及紧随其后的独立工具结果。
 * 跨轮复用的调用 ID 生成唯一后缀，同轮重复调用和孤立结果仅保留首个匹配。
 * 缺失结果补为中断错误消息，不修改用户正文或创建虚构用户轮次。
 */
export function ensureToolResultPairing(
  messages: readonly ModelStreamMessage[],
): ModelStreamMessage[] {
  const result: ModelStreamMessage[] = [];
  const allSeenToolUseIds = new Set<string>();
  const rewriteStates = new Map<string, ToolUseIdRewriteState>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool') {
      runLogger.warn(
        `[RequestConverter] Orphan tool_result '${msg.toolCallId}' found; stripping it`,
      );
      continue;
    }
    if (msg.role !== 'assistant') {
      result.push(msg);
      continue;
    }

    // 只按本轮收到的 ID 配对；跨轮重写不会改变后续结果的查找键。
    const emittedIds = new Map<string, string>();
    const toolCalls: ModelStreamToolCall[] = [];
    for (const call of msg.toolCalls ?? []) {
      if (emittedIds.has(call.id)) {
        runLogger.warn(
          `[RequestConverter] Duplicate tool_use ID '${call.id}' within one assistant turn; stripping later occurrence`,
        );
        continue;
      }
      const id = allSeenToolUseIds.has(call.id)
        ? makeUniqueToolUseId(call.id, rewriteStates, allSeenToolUseIds)
        : call.id;
      emittedIds.set(call.id, id);
      allSeenToolUseIds.add(id);
      toolCalls.push(id === call.id ? call : { ...call, id });
    }
    result.push(msg.toolCalls ? { ...msg, toolCalls } : msg);

    const completed = new Set<string>();
    const toolResults: ModelStreamToolResultMessage[] = [];
    while (messages[i + 1]?.role === 'tool') {
      const next = messages[++i];
      if (next.role !== 'tool') break;
      const id = emittedIds.get(next.toolCallId);
      if (id === undefined || completed.has(next.toolCallId)) {
        runLogger.warn(
          `[RequestConverter] Orphan or duplicate tool_result '${next.toolCallId}' found; stripping it`,
        );
        continue;
      }
      completed.add(next.toolCallId);
      toolResults.push(
        id === next.toolCallId ? next : { ...next, toolCallId: id },
      );
    }
    // 缺失结果先补齐，保持缓存前缀和既有中断事实的顺序。
    for (const [arrivedId, id] of emittedIds) {
      if (!completed.has(arrivedId)) {
        result.push({
          role: 'tool',
          toolCallId: id,
          content: [{ type: 'text', text: SYNTHETIC_TOOL_RESULT_PLACEHOLDER }],
          isError: true,
        });
      }
    }
    result.push(...toolResults);
  }
  logToolUseIdRewrites(rewriteStates);
  return result;
}

/** Per-base-id bookkeeping for {@link makeUniqueToolUseId}. */
interface ToolUseIdRewriteState {
  /** How many times this base id was rewritten; feeds the aggregated WARN. */
  count: number;
  /**
   * Suffix to probe first on the next rewrite. Tracked separately from `count`
   * because a collision can advance it by more than 1.
   */
  nextSuffix: number;
}

/**
 * Build an id that is not present in `usedIds` by suffixing the original id,
 * probing upwards from where this base id's last rewrite stopped.
 *
 * The result depends only on the history prefix already walked, so repeated
 * conversions of a growing history keep an identical prefix, preserving
 * provider prompt caching. Owning `rewriteStates` here — rather than returning
 * the next suffix for the caller to store — keeps the cursor advancing past
 * collision ranges instead of rescanning them on every rewrite.
 */
function makeUniqueToolUseId(
  originalId: string,
  rewriteStates: Map<string, ToolUseIdRewriteState>,
  usedIds: Set<string>,
): string {
  const state = rewriteStates.get(originalId);
  let suffix = state?.nextSuffix ?? 2;
  let candidate = `${originalId}_dup${suffix}`;
  while (usedIds.has(candidate)) {
    candidate = `${originalId}_dup${++suffix}`;
  }

  if (state) {
    state.count++;
    state.nextSuffix = suffix + 1;
  } else {
    rewriteStates.set(originalId, { count: 1, nextSuffix: suffix + 1 });
  }
  return candidate;
}

/**
 * Emit a single aggregated WARN per conversion instead of one line per rewritten
 * block: a long session with reused upstream ids otherwise floods the run log
 * with thousands of identical warnings.
 */
function logToolUseIdRewrites(
  rewriteStates: Map<string, ToolUseIdRewriteState>,
): void {
  if (rewriteStates.size === 0) return;

  const MAX_BREAKDOWN = 5;
  let total = 0;
  const breakdown: string[] = [];
  for (const [id, { count }] of rewriteStates) {
    total += count;
    if (breakdown.length < MAX_BREAKDOWN) breakdown.push(`${id} x${count}`);
  }
  const elided = rewriteStates.size > MAX_BREAKDOWN ? ', …' : '';

  runLogger.warn(
    `[RequestConverter] Rewrote ${total} tool_use id(s) reused across turns to keep tool history intact ` +
      `(${breakdown.join(', ')}${elided}); ` +
      `upstream should return globally unique tool_call ids`,
  );
}

// ---------------------------------------------------------------------------
// Content block conversion
// ---------------------------------------------------------------------------

function textBlock(text: string): ModelStreamTextBlock {
  return { type: 'text', text };
}

function unsupportedImageSourceMediaType(
  source: ModelImageBlock['source'],
): string | null {
  if (source.type === 'base64') {
    return isSupportedImageMediaType(source.mediaType)
      ? null
      : source.mediaType;
  }

  const dataMediaType = /^data:([^;,]+)/i.exec(source.url)?.[1];
  if (
    dataMediaType?.toLowerCase().startsWith('image/') &&
    !isSupportedImageMediaType(dataMediaType)
  ) {
    return dataMediaType;
  }

  try {
    return new URL(source.url).pathname.toLowerCase().endsWith('.svg')
      ? 'image/svg+xml'
      : null;
  } catch {
    return source.url.toLowerCase().split(/[?#]/, 1)[0].endsWith('.svg')
      ? 'image/svg+xml'
      : null;
  }
}

/** 图片不受支持时保留文本说明及原缓存标记；支持的图片保留标准源结构。 */
function convertImageBlock(
  block: ModelImageBlock,
  supportsVision: boolean,
): ModelInputContentBlock {
  const unsupportedMediaType = unsupportedImageSourceMediaType(block.source);
  if (unsupportedMediaType || !supportsVision) {
    return {
      type: 'text',
      text: unsupportedMediaType
        ? unsupportedImagePlaceholder(unsupportedMediaType)
        : NON_VISION_IMAGE_PLACEHOLDER,
      ...(block.cacheControl ? { cacheControl: block.cacheControl } : {}),
    };
  }
  return block.source.type === 'base64'
    ? {
        ...block,
        source: {
          ...block.source,
          mediaType: normalizeImageMediaType(block.source.mediaType),
        },
      }
    : block;
}

/**
 * Convert tool_result content to provider input blocks.
 *
 * Text-only results collapse into a single text block. Results that contain
 * images keep every block so the image remains attached to the role=tool
 * message instead of being emitted as a separate user message.
 */
function projectInputContent(
  content: ModelStreamToolResultContent,
): ModelInputContentBlock[] {
  if (typeof content === 'string') return content ? [textBlock(content)] : [];
  return [...content];
}

// ---------------------------------------------------------------------------
// User message conversion
// ---------------------------------------------------------------------------

/**
 * Convert an Anthropic user message to provider messages.
 *
 * A single Anthropic user message containing both tool_result and text/image
 * blocks is split into multiple messages:
 *   tool results → role:tool messages (emitted first)
 *   text/images  → role:user message  (emitted second)
 *
 * This preserves the OpenAI ordering: assistant(tool_calls) → tool(results) → user(text).
 */
function convertUserMessage(
  content: string | readonly RuntimeContentBlockParam[],
): ModelStreamMessage[] {
  if (typeof content === 'string') {
    return content ? [{ role: 'user', content: [textBlock(content)] }] : [];
  }
  const tools: ModelStreamToolResultMessage[] = [];
  const blocks: ModelInputContentBlock[] = [];
  for (const block of content) {
    if (block.type === 'tool_result') {
      tools.push({
        role: 'tool',
        toolCallId: block.tool_use_id,
        content:
          typeof block.content === 'string'
            ? projectInputContent(block.content)
            : block.content.map(transcriptInputToModelBlock),
        ...(block.is_error ? { isError: true } : {}),
      });
    } else {
      blocks.push(transcriptInputToModelBlock(block));
    }
  }
  return [
    ...tools,
    ...(blocks.length ? [{ role: 'user' as const, content: blocks }] : []),
  ];
}

// ---------------------------------------------------------------------------
// Assistant message conversion
// ---------------------------------------------------------------------------

/**
 * Convert an Anthropic assistant message to a provider assistant message.
 *
 * Text, thinking and redacted_thinking blocks keep their original order; each
 * tool_use becomes a tool call carried separately on `toolCalls`.
 */
function convertAssistantMessage(
  msg: Extract<Message, { type: 'assistant' }>,
  differentProvider: boolean,
): ModelStreamAssistantMessage {
  const content: Array<
    ModelStreamTextBlock | ModelThinkingBlock | ModelRedactedThinkingBlock
  > = [];
  const toolCalls: ModelStreamToolCall[] = [];
  for (const block of msg.message.content) {
    switch (block.type) {
      case 'text':
        if (block.text) content.push(textBlock(block.text));
        break;
      case 'thinking':
        if (differentProvider) {
          if (block.thinking) content.push(textBlock(block.thinking));
        } else {
          content.push({
            type: 'thinking',
            thinking: block.thinking,
            ...(block.signature ? { signature: block.signature } : {}),
            ...(block.reasoning_item
              ? { reasoning: structuredClone(block.reasoning_item) }
              : {}),
          });
        }
        break;
      case 'redacted_thinking':
        if (!differentProvider && block.data)
          content.push({
            type: 'redacted_thinking',
            data: block.data,
            ...(block.reasoning_item
              ? { reasoning: structuredClone(block.reasoning_item) }
              : {}),
          });
        break;
      case 'tool_use':
        toolCalls.push({
          id: block.id,
          name: sanitizeToolName(block.name),
          arguments:
            block.inputJson ??
            JSON.stringify(normalizeToolInputForAPI(block.name, block.input)),
          ...(block.thoughtSignature !== undefined
            ? { thoughtSignature: block.thoughtSignature }
            : {}),
        });
        break;
      default:
        break;
    }
  }
  return {
    role: 'assistant',
    content,
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

// ---------------------------------------------------------------------------
// normalizeMessagesForAPI — unified Message[] → MessageParam[] pipeline
// ---------------------------------------------------------------------------

/** Placeholder for non-trailing assistant messages with empty content. */
const NO_CONTENT_MESSAGE = '[No message content]';

export interface NormalizeMessagesForAPIOptions {
  /** Effective model key that will receive the projected history. */
  targetModel?: string;
  /** 仅端侧直连设置；用于隔离不同 provider 的 reasoning。 */
  targetCustomProviderId?: string;
}

/**
 * Transforms runtime `Message[]` into API-ready `MessageParam[]`.
 *
 * This is the single entry point for all Message → API conversions. It runs a
 * unified pipeline:
 *
 *   Step 0  — Raw history preparation:
 *             · move attachments back to the previous assistant/tool_result boundary
 *             · build precise strip targets from prior API media errors
 *   Step 1  — Filter + convert runtime Message types:
 *             · user/assistant pass through (isVirtual skipped)
 *             · system → dropped (local_command now stored as user type)
 *             · attachment → expanded via normalizeAttachmentForAPI()
 *             · progress / tool_use_summary / tombstone → dropped
 *   Step 2  — Merge adjacent same-role fragments
 *   Step 3  — Sanitize thinking blocks:
 *             · remove orphaned thinking-only assistant messages
 *             · strip trailing thinking from last assistant
 *   Step 4  — Remove whitespace-only assistant messages
 *   Step 5  — Ensure non-empty content on non-trailing assistant messages
 *   Step 6  — Fold internal <system-reminder> siblings into tool_result content
 *   Step 7  — Strip internal metadata (_assistantMessageId tracking field)
 *   Step 8  — Replace unsupported image blocks with text placeholders
 *   Step 9  — Validate images are within API size limits
 *   Step 10 — Sanitize error tool_results (strip non-text from is_error blocks)
 *
 * Does not mutate the input array.
 *
 * @param messages - Runtime Message[] (the full conversation history)
 * @param options - Target-aware projection options
 * @returns Clean alternating user/assistant MessageParam[] ready for API dispatch
 */
export function normalizeMessagesForAPI(
  messages: readonly Message[],
  options: NormalizeMessagesForAPIOptions = {},
): ModelStreamMessage[] {
  // A compacted session prefix is a separate user-context region. Normalize
  // each region before merging users so the ordinary attachment/tool folding
  // rules cannot move announcements into a retained historical tool result.
  const compactSummary = messages.find(
    (m) => m.isCompactSummary && m.isCompactionPrefix,
  );
  if (compactSummary) {
    const prefix = messages.filter(
      (m) => m.isCompactionPrefix && !m.isCompactSummary,
    );
    const recovery = messages.filter(
      (m) =>
        m.type === 'attachment' &&
        m.attachment.type === 'post_compact_restored_files',
    );
    const body = messages.filter(
      (m) => !prefix.includes(m) && !recovery.includes(m),
    );
    const at = body.indexOf(compactSummary);
    const unmark = (m: Message): Message => ({
      ...m,
      isCompactionPrefix: undefined,
    });
    return mergeUserMessages([
      ...normalizeMessagesForAPI(
        [...body.slice(0, at), ...prefix].map(unmark),
        options,
      ),
      ...normalizeMessagesForAPI(recovery.map(unmark), options),
      ...normalizeMessagesForAPI(body.slice(at).map(unmark), options),
    ]);
  }
  const reordered = reorderRawAttachmentsForAPI(
    projectRefusalContext(messages),
  );
  const stripTargets = buildRawStripTargets(reordered);
  const prepared = mergeAssistantFragments(
    reordered.filter(
      (msg) =>
        !msg.isVirtual &&
        !isRawApiErrorMarkerMessage(msg) &&
        (msg.type === 'user' ||
          msg.type === 'assistant' ||
          msg.type === 'attachment'),
    ),
  );
  const projected = filterAndConvert(
    prepared,
    stripTargets,
    options.targetCustomProviderId,
  );
  const normalized = mergeUserMessages(projected);
  const sanitized = sanitizeImages(normalized, true);
  validateImagesForAPI(sanitized);
  return sanitizeErrorToolResults(sanitized);
}

// ---------------------------------------------------------------------------
// Step 1: Filter + convert runtime Message types
// ---------------------------------------------------------------------------

/**
 * Runtime-only fields on tool_use inputs that must be stripped before
 * sending back to the API. These are injected by the UI/harness (e.g.,
 * Edit and WriteFile tools' "user modified" flow) but are not part of the
 * tool's API schema.
 */
const SYNTHETIC_TOOL_INPUT_FIELDS = new Set([
  'modified_by_user',
  'ai_proposed_content',
]);

/** Pre-computed per-tool strip sets (avoids allocation per tool_use block). */
const EXIT_PLAN_MODE_KEYS_TO_STRIP = new Set<string>([
  ...SYNTHETIC_TOOL_INPUT_FIELDS,
  'plan',
  'planFilePath',
  'plan_filename',
  'approved',
  'permissionMode',
  'feedback',
  'planWasEdited',
]);

const EDIT_KEYS_TO_STRIP = new Set<string>([
  ...SYNTHETIC_TOOL_INPUT_FIELDS,
  'replace_all',
]);

/**
 * Strip runtime-only synthetic fields from a tool_use input object and
 * normalize legacy/session-only keys that are not part of the current public
 * tool schema.
 *
 * Returns the original object when no stripping is needed (fast path).
 */
function normalizeToolInputForAPI(
  toolName: string | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const keysToStrip =
    toolName === EXIT_PLAN_MODE_TOOL_NAME
      ? EXIT_PLAN_MODE_KEYS_TO_STRIP
      : toolName === EDIT_TOOL_NAME
        ? EDIT_KEYS_TO_STRIP
        : SYNTHETIC_TOOL_INPUT_FIELDS;

  if (!Object.keys(input).some((k) => keysToStrip.has(k))) {
    return input;
  }
  return Object.fromEntries(
    Object.entries(input).filter(([k]) => !keysToStrip.has(k)),
  );
}

/**
 * Filters runtime Message[] to API-relevant types and converts each to
 * InternalMessageParam format.
 */
function filterAndConvert(
  messages: readonly Message[],
  stripTargets: ReadonlyMap<string, Set<string>>,
  targetCustomProviderId?: string,
): ModelStreamMessage[] {
  const result: ModelStreamMessage[] = [];
  const assistantIdsWithVisibleContent = new Set(
    messages.flatMap((message) =>
      message.type === 'assistant' &&
      message.message.content.some(
        (block) =>
          block.type === 'tool_use' ||
          (block.type === 'text' && block.text.trim()),
      )
        ? [message.message.id]
        : [],
    ),
  );
  for (const [index, msg] of messages.entries()) {
    switch (msg.type) {
      case 'user': {
        const content = maybeStripRawTargetContent(
          msg,
          normalizeUserContent(msg.message.content),
          stripTargets,
        );
        if (content) result.push(...convertUserMessage(content));
        break;
      }
      case 'assistant': {
        const differentProvider =
          targetCustomProviderId !== undefined &&
          (msg.modelSource !== 'custom' ||
            msg.customProviderId !== targetCustomProviderId);
        let projected = convertAssistantMessage(msg, differentProvider);
        if (typeof projected.content !== 'string' && projected.content.length) {
          const blocks = projected.content;
          // 先隔离 provider 元数据，切换后仍可见的 reasoning 文本不能作为思考孤片删除。
          if (
            !projected.toolCalls?.length &&
            (blocks.every(
              (block) => block.type === 'text' && !block.text.trim(),
            ) ||
              (blocks.every(
                (block) =>
                  block.type === 'thinking' ||
                  block.type === 'redacted_thinking',
              ) &&
                !assistantIdsWithVisibleContent.has(msg.message.id)))
          )
            break;
          if (index === messages.length - 1) {
            let end = blocks.length;
            while (
              end > 0 &&
              (blocks[end - 1].type === 'thinking' ||
                blocks[end - 1].type === 'redacted_thinking')
            )
              end--;
            if (end !== blocks.length)
              projected = { ...projected, content: blocks.slice(0, end) };
          }
        }
        result.push(
          !projected.content.length &&
            !projected.toolCalls?.length &&
            index !== messages.length - 1
            ? { ...projected, content: [textBlock(NO_CONTENT_MESSAGE)] }
            : projected,
        );
        break;
      }
      case 'attachment': {
        const attachment = restoreAttachment(msg.attachment);
        for (const expanded of attachment
          ? normalizeAttachmentForAPI(attachment)
          : []) {
          const content = maybeStripRawTargetContent(
            msg,
            projectInputContent(expanded.content),
            stripTargets,
          );
          if (content) result.push({ role: 'user', content });
        }
        break;
      }
      default:
        break;
    }
  }
  return result;
}

/**
 * Normalizes user message content to `ContentBlockParam[]`.
 */
function normalizeUserContent(
  content: string | RuntimeContentBlockParam[],
): RuntimeContentBlockParam[] {
  if (!content) return [];
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}

function maybeStripRawTargetContent<T extends { type: string }>(
  msg: Message,
  content: readonly T[],
  stripTargets: ReadonlyMap<string, Set<string>>,
): readonly T[] | undefined {
  const typesToStrip = stripTargets.get(msg.uuid);
  if (!typesToStrip) return content;

  const filtered = content.filter(
    (block: { type: string }) => !typesToStrip.has(block.type),
  );

  return filtered.length > 0 ? filtered : undefined;
}

// ---------------------------------------------------------------------------
// Step 2: Merge adjacent same-role messages
// ---------------------------------------------------------------------------

/**
 * Returns true if a content array contains at least one tool_result block.
 * Shared predicate used by merge and pairing-repair passes.
 */
function mergeAssistantFragments(messages: readonly Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    if (msg.type !== 'assistant') {
      result.push(msg);
      continue;
    }
    let merged = false;
    for (let index = result.length - 1; index >= 0; index--) {
      const prior = result[index];
      if (prior.type === 'assistant') {
        if (prior.message.id === msg.message.id) {
          result[index] = {
            ...prior,
            message: {
              ...prior.message,
              content: [...prior.message.content, ...msg.message.content],
            },
          };
          merged = true;
          break;
        }
        continue;
      }
      if (
        prior.type === 'user' &&
        Array.isArray(prior.message.content) &&
        prior.message.content.some((block) => block.type === 'tool_result')
      )
        continue;
      break;
    }
    if (!merged) result.push(msg);
  }
  return result;
}

/**
 * Merge two user content block arrays: join at the text seam and hoist
 * tool_results to the front. Shared by both InternalMessageParam and
 * plain MessageParam merge passes.
 */

/**
 * Merges consecutive user messages and assistant fragments.
 *
 * User merge: adjacent user messages are merged with joinTextAtSeam + hoistToolResults.
 *
 * Assistant merge: walks backward from the tail of `result`, skipping
 * tool_result user messages and different-ID assistants, to find an
 * assistant with the same `_assistantMessageId`. This supports concurrent
 * agent (teammates) scenarios where streaming content blocks from multiple
 * API responses with different message IDs can be interleaved with
 * tool_result user messages.
 */
function mergeUserMessages(
  messages: readonly ModelStreamMessage[],
): ModelStreamMessage[] {
  const result: ModelStreamMessage[] = [];
  let tools: ModelStreamToolResultMessage[] = [];
  let content: ModelInputContentBlock[] = [];
  const flush = () => {
    const reminders = tools.length
      ? content.filter(
          (block) =>
            block.type === 'text' && block.text.startsWith('<system-reminder>'),
        )
      : [];
    if (reminders.length) {
      const texts = reminders.flatMap((block) =>
        block.type === 'text' ? [block.text.trim()] : [],
      );
      tools[tools.length - 1] = smooshIntoToolResult(
        tools[tools.length - 1],
        texts,
      );
      const removed = new Set(reminders);
      content = content.filter((block) => !removed.has(block));
    }
    result.push(...tools);
    if (content.length) result.push({ role: 'user', content });
    tools = [];
    content = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      tools.push(message);
    } else if (message.role === 'user') {
      const blocks =
        typeof message.content === 'string'
          ? [textBlock(message.content)]
          : message.content;
      content = joinTextAtSeam(content, blocks);
    } else {
      flush();
      result.push(message);
    }
  }
  flush();
  return result;
}

/**
 * Concatenate two content block arrays, appending `\n` to a's last text block
 * when the seam is text-text. The API concatenates adjacent text blocks in a
 * user message without a separator, so two queued prompts `"2 + 2"` +
 * `"3 + 3"` would otherwise reach the model as `"2 + 23 + 3"`.
 *
 * Blocks stay separate; the `\n` is appended to `a`'s last text block so
 * that content classifiers keying on `b`'s prefix (e.g.
 * `startsWith('<system-reminder>')`) are unaffected.
 */
function joinTextAtSeam(
  a: readonly ModelInputContentBlock[],
  b: readonly ModelInputContentBlock[],
): ModelInputContentBlock[] {
  const lastA = a.at(-1);
  const firstB = b[0];
  if (lastA?.type === 'text' && firstB?.type === 'text') {
    return [...a.slice(0, -1), { ...lastA, text: lastA.text + '\n' }, ...b];
  }
  return [...a, ...b];
}

/**
 * Hoists tool_result blocks to the front of a content array.
 */

/**
 * Fold internal `<system-reminder>` text siblings into the last tool_result in
 * the same user turn. When left as a sibling, convertMessages() would split the
 * tool_result to role:tool and the reminder to role:user, teaching the provider
 * an artificial user turn after tool output.
 */

function smooshIntoToolResult(
  toolResult: ModelStreamToolResultMessage,
  texts: readonly string[],
): ModelStreamToolResultMessage {
  const existing = toolResult.content;
  if (typeof existing === 'string') {
    return {
      ...toolResult,
      content: [existing.trim(), ...texts].filter(Boolean).join('\n\n'),
    };
  }
  const content: ModelInputContentBlock[] = [];
  for (const block of [...existing, ...texts.map(textBlock)]) {
    if (block.type !== 'text') {
      content.push(block);
      continue;
    }
    const text = block.text.trim();
    if (!text) continue;
    const previous = content.at(-1);
    if (previous?.type === 'text') {
      content[content.length - 1] = {
        ...previous,
        text: `${previous.text}\n\n${text}`,
      };
    } else {
      content.push({ ...block, text });
    }
  }
  return { ...toolResult, content };
}

// ---------------------------------------------------------------------------
// Step 3: Sanitize thinking blocks
// ---------------------------------------------------------------------------

/**
 * Sanitizes thinking blocks in two passes:
 * 1. Remove thinking-only assistants only when no same message.id assistant
 *    carries non-thinking content.
 * 2. Strip trailing thinking blocks from the last assistant message.
 */

// ---------------------------------------------------------------------------
// Strip internal metadata
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Step 9: Sanitize error tool_results
// ---------------------------------------------------------------------------

/**
 * Strips non-text content from `is_error: true` tool_result blocks.
 */
function sanitizeErrorToolResults(
  messages: readonly ModelStreamMessage[],
): ModelStreamMessage[] {
  return messages.map((message) => {
    if (
      message.role !== 'tool' ||
      !message.isError ||
      typeof message.content === 'string' ||
      message.content.every((block) => block.type === 'text')
    )
      return message;
    const texts = message.content.flatMap((block) =>
      block.type === 'text' ? [block.text] : [],
    );
    return {
      ...message,
      content: texts.length ? [textBlock(texts.join('\n\n'))] : [],
    };
  });
}

// ---------------------------------------------------------------------------
// Step 8: Sanitize unsupported images for API
// ---------------------------------------------------------------------------

function sanitizeImages(
  messages: readonly ModelStreamMessage[],
  supportsVision: boolean,
): ModelStreamMessage[] {
  return messages.map((message) => {
    if (
      (message.role !== 'user' && message.role !== 'tool') ||
      typeof message.content === 'string'
    )
      return message;
    return {
      ...message,
      content: message.content.map((block) =>
        block.type === 'image'
          ? convertImageBlock(block, supportsVision)
          : block,
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Step 9: Validate images for API
// ---------------------------------------------------------------------------

/**
 * Validates that all base64-encoded images in user messages are within the
 * API size limit, including images nested inside tool_result content. Throws
 * an error listing all oversized images.
 */
function validateImagesForAPI(messages: readonly ModelStreamMessage[]): void {
  const oversized: string[] = [];
  let imageIndex = 0;
  for (const message of messages) {
    if (
      (message.role !== 'user' && message.role !== 'tool') ||
      typeof message.content === 'string'
    )
      continue;
    for (const block of message.content) {
      if (block.type !== 'image') continue;
      imageIndex++;
      if (
        block.source.type === 'base64' &&
        block.source.data.length > API_IMAGE_MAX_BASE64_SIZE
      ) {
        const sizeMB = (block.source.data.length / (1024 * 1024)).toFixed(1);
        oversized.push(`image[${imageIndex}]: ${sizeMB}MB`);
      }
    }
  }
  if (oversized.length > 0) {
    const limitMB = (API_IMAGE_MAX_BASE64_SIZE / (1024 * 1024)).toFixed(0);
    throw new Error(
      `Image(s) exceed API size limit (${limitMB}MB): ${oversized.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 4: filter whitespace-only assistant messages
// ---------------------------------------------------------------------------

/**
 * Remove assistant messages whose every content block is pure whitespace text.
 *
 * These arise when a stream is cancelled after emitting only whitespace (e.g.
 * `\n\n`). Sending them to the API can trigger a 400 error.
 *
 * After removal, adjacent user messages that may have been separated by the
 * removed message are re-merged.
 */

// ---------------------------------------------------------------------------
// Phase 5: ensure non-empty assistant content
// ---------------------------------------------------------------------------

/**
 * Insert a placeholder text block into assistant messages with empty content
 * arrays, except for the very last assistant message (which may be empty for
 * prefill purposes).
 */

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const DEFAULT_MAX_REQUEST_IMAGES = 50;
const REQUEST_IMAGE_HEADROOM_RATIO = 0.4;
const REMOVED_IMAGE_PLACEHOLDER = '[media removed: request limit]';

export function getMaxRequestImages(): number {
  return positiveIntegerFromEnv(
    ENV_MAX_REQUEST_IMAGES,
    DEFAULT_MAX_REQUEST_IMAGES,
  );
}

function limitImagesForAPI(
  messages: readonly ModelStreamMessage[],
  maxRequestImages: number,
): ModelStreamMessage[] {
  const trimTarget =
    maxRequestImages -
    Math.floor(maxRequestImages * REQUEST_IMAGE_HEADROOM_RATIO);
  let retainedImages = 0;
  let imagesToRemove = 0;
  for (const message of messages) {
    if (
      (message.role !== 'user' && message.role !== 'tool') ||
      typeof message.content === 'string'
    ) continue;
    for (const block of message.content) {
      if (block.type !== 'image') continue;
      retainedImages++;
      if (retainedImages > maxRequestImages) {
        imagesToRemove += retainedImages - trimTarget;
        retainedImages = trimTarget;
      }
    }
  }
  if (imagesToRemove === 0) return [...messages];

  runLogger.log('[RequestConverter] Trimmed request history images', {
    original: retainedImages + imagesToRemove,
    removed: imagesToRemove,
    retained: retainedImages,
  });

  return messages.map((message): ModelStreamMessage => {
    if (
      imagesToRemove === 0 ||
      (message.role !== 'user' && message.role !== 'tool') ||
      typeof message.content === 'string'
    ) return message;

    const content: ModelInputContentBlock[] = [];
    for (const block of message.content) {
      if (imagesToRemove > 0 && block.type === 'image') {
        imagesToRemove--;
        if (message.role === 'tool') {
          content.push({ type: 'text', text: REMOVED_IMAGE_PLACEHOLDER });
        }
      } else {
        content.push(block);
      }
    }
    return {
      ...message,
      content: content.length > 0
        ? content
        : [{ type: 'text', text: REMOVED_IMAGE_PLACEHOLDER }],
    };
  });
}

/**
 * 准备标准请求消息：修复工具配对、按视觉能力处理图片、限制合并后的历史图片并注入缓存断点。
 * skipCacheWrite 仅标记倒数第二条消息；不转换消息协议或修改输入。
 */
export function convertMessages(
  messages: readonly ModelStreamMessage[],
  skipCacheWrite = false,
  options?: ConvertMessagesOptions,
): ModelStreamMessage[] {
  const supportsVision = options?.supportsVision ?? true;
  const sanitized = sanitizeImages(ensureToolResultPairing(messages), supportsVision);
  // Forks may join separately normalized prefixes and suffixes, so limit only
  // the final conversation and inject cache breakpoints after trimming.
  const limited = supportsVision
    ? limitImagesForAPI(
        sanitized,
        options?.maxRequestImages ?? DEFAULT_MAX_REQUEST_IMAGES,
      )
    : sanitized;
  return addCacheBreakpoints(limited, skipCacheWrite);
}

// ---------------------------------------------------------------------------
// Step 0: Raw history preparation
// ---------------------------------------------------------------------------

export const SYNTHETIC_MODEL = '<synthetic>';
const API_ERROR_MESSAGE_PREFIX = '[API Error';

/**
 * Moves attachments toward the preceding assistant or tool-result boundary.
 * Transcript order remains append-only (`user -> attachments`), while the
 * provider sees contextual attachments before the current user prompt.
 */
function reorderRawAttachmentsForAPI(messages: readonly Message[]): Message[] {
  if (!messages.some((m) => m.type === 'attachment')) {
    return [...messages];
  }

  const result: Message[] = [];
  const pendingAttachments: Message[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;

    if (message.type === 'attachment') {
      pendingAttachments.push(message);
      continue;
    }

    if (
      isRawAttachmentStoppingPoint(message) &&
      pendingAttachments.length > 0
    ) {
      result.push(...pendingAttachments);
      result.push(message);
      pendingAttachments.length = 0;
      continue;
    }

    result.push(message);
  }

  result.push(...pendingAttachments);
  result.reverse();
  return result;
}

function isRawAttachmentStoppingPoint(message: Message): boolean {
  if (message.type === 'assistant') return true;
  if (message.type !== 'user') return false;
  const content = message.message.content;
  return Array.isArray(content) && content[0]?.type === 'tool_result';
}

function isRawApiErrorMarkerMessage(message: Message): boolean {
  return (
    isSyntheticApiErrorMessage(message) || isLegacyApiErrorUserMessage(message)
  );
}

function isSyntheticApiErrorMessage(message: Message): boolean {
  return (
    message.type === 'assistant' &&
    message.isApiErrorMessage === true &&
    message.message.model === SYNTHETIC_MODEL
  );
}

function isLegacyApiErrorUserMessage(message: Message): boolean {
  if (message.type !== 'user' || message.isMeta !== true) return false;
  const text = getFirstUserText(message);
  return text?.trim().startsWith(API_ERROR_MESSAGE_PREFIX) === true;
}

/**
 * Build a targeted raw-message strip map. Synthetic API error messages only
 * strip media from the nearest preceding meta user / attachment message; the
 * scan stops at assistants and normal user messages.
 */
function buildRawStripTargets(
  messages: readonly Message[],
): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    const blockTypesToStrip = getRawApiErrorStripTypes(msg);
    if (!blockTypesToStrip) continue;

    for (let j = i - 1; j >= 0; j--) {
      const candidate = messages[j];
      if (!candidate) continue;

      if (
        candidate.type === 'attachment' ||
        (candidate.type === 'user' && candidate.isMeta === true)
      ) {
        addRawStripTarget(targets, candidate.uuid, blockTypesToStrip);
        break;
      }

      if (isRawApiErrorMarkerMessage(candidate)) {
        continue;
      }

      break;
    }
  }

  return targets;
}

function addRawStripTarget(
  targets: Map<string, Set<string>>,
  uuid: string,
  blockTypes: Set<string>,
): void {
  const existing = targets.get(uuid);
  if (existing) {
    for (const type of blockTypes) existing.add(type);
    return;
  }
  targets.set(uuid, new Set(blockTypes));
}

function getRawApiErrorStripTypes(message: Message): Set<string> | undefined {
  const errorText = getRawApiErrorText(message);
  return errorText ? blockTypesForApiErrorText(errorText) : undefined;
}

function getRawApiErrorText(message: Message): string | undefined {
  if (isSyntheticApiErrorMessage(message)) {
    return unwrapApiErrorText(getFirstAssistantText(message));
  }
  if (isLegacyApiErrorUserMessage(message)) {
    return unwrapApiErrorText(getFirstUserText(message));
  }
  return undefined;
}

function getFirstAssistantText(message: Message): string | undefined {
  if (message.type !== 'assistant') return undefined;
  const block = message.message.content[0];
  return block?.type === 'text' ? block.text : undefined;
}

function getFirstUserText(message: Message): string | undefined {
  if (message.type !== 'user') return undefined;
  const content = message.message.content;
  if (typeof content === 'string') return content;
  const block = content[0];
  return block?.type === 'text' ? block.text : undefined;
}

function unwrapApiErrorText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  const match = trimmed.match(/^\[API Error:\s*([\s\S]*)\]$/);
  return (match?.[1] ?? trimmed).trim();
}

const ERROR_PREFIX_TO_BLOCK_TYPES: ReadonlyArray<
  [string, ReadonlySet<string>]
> = [
  ['Image was too large.', new Set(['image'])],
  ['Request too large (', new Set(['image'])],
];

function blockTypesForApiErrorText(text: string): Set<string> | undefined {
  for (const [prefix, types] of ERROR_PREFIX_TO_BLOCK_TYPES) {
    if (text.startsWith(prefix)) {
      return new Set(types);
    }
  }
  return undefined;
}
