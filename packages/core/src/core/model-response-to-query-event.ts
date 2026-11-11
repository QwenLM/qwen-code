/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AssistantBlockEvent, StreamEvent } from './query-event.js';
import type { ModelStreamResponse } from '../provider/modelStreamResponse.js';
import type { ModelPartialMessage } from '../provider/aggregate/modelPartialMessage.js';
import type {
  ModelCompleteEvent,
  ModelContentBlock,
  ModelMessage,
} from '../provider/event/modelCompleteEvent.js';
import type {
  ModelStreamEvent,
  ModelStreamUsage,
} from '../provider/event/modelStreamEvent.js';
import {
  cloneUsage,
  markCacheReadUsageAvailable,
  markCacheWriteUsageAvailable,
} from '../protocol/provider/empty-usage.js';
import { attachThinkingTokenCount } from '../protocol/provider/usage-converter.js';
import { normalizeModelToolUseBlock } from '../protocol/provider/tool-input.js';
import { createUserAbortError } from '../utils/errors.js';

export interface ModelResponseToQueryEventInput {
  response: ModelStreamResponse;
  /** 请求 ID 来自宿主，不等同于模型消息 ID。 */
  requestId: string;
  signal?: AbortSignal;
  /** 交付位置记录，不保存增量正文或工具参数。 */
  delivery?: ModelResponseDelivery;
}

/** 仅记录消息外壳与消费边界，不保存块正文或拼接工具参数。 */
export interface ModelResponseDelivery {
  message: ModelMessage;
  readonly deliveredBlocks: Set<number>;
  readonly textLengths: Map<number, number>;
  readonly pendingTools: Map<
    number,
    { id: string; name: string; argumentLength: number }
  >;
  committedOutput: boolean;
  receivedUsage: boolean;
}

export function createModelResponseDelivery(): ModelResponseDelivery {
  return {
    message: { messageId: '', model: '', blocks: [] },
    deliveredBlocks: new Set(),
    textLengths: new Map(),
    pendingTools: new Map(),
    committedOutput: false,
    receivedUsage: false,
  };
}

/**
 * 将模型事件映射为 QueryEvent 的模型事件子集，最终返回标准模型消息。
 * 不聚合内容、不校验流完整性、不决定重试或恢复；错误原样向上抛出。
 * 调用方需读取生成器返回值；提前退出时由本函数取消底层响应。
 */
export async function* convertModelResponse({
  response,
  requestId,
  signal,
  delivery = createModelResponseDelivery(),
}: ModelResponseToQueryEventInput): AsyncGenerator<
  StreamEvent | AssistantBlockEvent,
  ModelMessage
> {
  let message = delivery.message;
  const { deliveredBlocks, textLengths, pendingTools } = delivery;
  // 提前观察拒绝，避免消费事件期间的未处理异常；末尾仍等待原 Promise。
  void response.completed.catch(() => undefined);
  let cancelTask: Promise<void> | undefined;
  const cancel = (reason: unknown): Promise<void> => {
    if (!cancelTask) {
      try {
        cancelTask = Promise.resolve(response.cancel?.(reason)).catch(
          () => undefined,
        );
      } catch {
        cancelTask = Promise.resolve();
      }
    }
    return cancelTask;
  };
  let rejectAbort!: (error: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  void aborted.catch(() => undefined);
  const onAbort = (): void => {
    const error = signal?.reason ?? createUserAbortError();
    rejectAbort(error);
    void cancel(error);
  };
  let iterator:
    | ReturnType<ModelStreamResponse['events'][typeof Symbol.asyncIterator]>
    | undefined;
  let eventsDone = false;
  let settled = false;
  let cleanupReason: unknown = createUserAbortError();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    signal?.throwIfAborted();
    iterator = response.events[Symbol.asyncIterator]();
    while (true) {
      signal?.throwIfAborted();
      const pendingNext = Promise.resolve(iterator.next());
      const next = await Promise.race([pendingNext, aborted]);
      signal?.throwIfAborted();
      if (next.done) {
        eventsDone = true;
        break;
      }
      const event = next.value;
      if (event.type === 'message_start') {
        deliveredBlocks.clear();
        textLengths.clear();
        pendingTools.clear();
        delivery.committedOutput = false;
        delivery.receivedUsage = false;
      }
      message = updateMessage(message, event);
      delivery.message = message;
      if (event.type === 'content_block_complete') {
        const blockMessage: ModelMessage = {
          ...structuredClone(message),
          blocks: [validateModelBlock(event.block)],
        };
        deliveredBlocks.add(event.index);
        if (event.block.type === 'tool_use') delivery.committedOutput = true;
        yield {
          type: 'assistant_block',
          index: event.index,
          requestId,
          message: blockMessage,
        };
      } else if (event.type !== 'message_complete') {
        switch (event.type) {
          case 'content_block_start':
            if (event.contentBlock.type === 'text') {
              textLengths.set(event.index, 0);
            } else if (event.contentBlock.type === 'tool_use') {
              delivery.committedOutput = true;
              pendingTools.set(event.index, {
                id: event.contentBlock.id,
                name: event.contentBlock.name,
                argumentLength: 0,
              });
            }
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              delivery.committedOutput = true;
              textLengths.set(
                event.index,
                (textLengths.get(event.index) ?? 0) + event.delta.text.length,
              );
            } else if (
              event.delta.type === 'input_json_delta' &&
              pendingTools.has(event.index)
            ) {
              pendingTools.get(event.index)!.argumentLength +=
                event.delta.partial_json.length;
            }
            break;
          case 'content_block_stop':
            textLengths.delete(event.index);
            pendingTools.delete(event.index);
            break;
          case 'message_delta':
            delivery.receivedUsage ||= event.usage !== undefined;
            break;
          default:
            break;
        }
        yield {
          type: 'stream_event',
          requestId,
          // 同请求用量按字段更新，协议字段只在 SDK／Transport 出口生成。
          event: structuredClone(
            event.type === 'message_delta' && event.usage
              ? { ...event, usage: message.usage }
              : event,
          ),
        };
      }
    }
    const result = await Promise.race([response.completed, aborted]);
    signal?.throwIfAborted();
    settled = true;
    return { ...result, usage: mergeUsage(message.usage, result.usage) };
  } catch (error) {
    cleanupReason = error;
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!settled) {
      await cancel(cleanupReason);
      // 某些迭代器的 return 会等未完成的 next；发起关闭但不让它阻塞中断返回。
      if (!eventsDone && iterator?.return) {
        try {
          void Promise.resolve(iterator.return()).catch(() => undefined);
        } catch {
          // 清理失败不能覆盖已记录的主因。
        }
      }
    }
  }
}

/** 从标准快照读取已交付内容，保留原始 index，不补交预读工具或未展示正文。 */
export function getDeliveredModelMessage(
  partial: ModelPartialMessage,
  delivery: ModelResponseDelivery,
): ModelMessage {
  const { deliveredBlocks, textLengths } = delivery;
  const blocks: ModelContentBlock[] = [];
  for (const index of deliveredBlocks) {
    const block = partial.blocks[index];
    if (block) blocks[index] = block;
  }
  for (const [index, textLength] of textLengths) {
    if (deliveredBlocks.has(index)) continue;
    const block = partial.blocks[index] ?? partial.openBlocks.get(index);
    if (block?.type === 'text') {
      blocks[index] = { type: 'text', text: block.text.slice(0, textLength) };
    }
  }
  // 停止原因与用量只取实际消费到的元数据；不修改上游终态快照。
  return { ...delivery.message, blocks };
}

/** 恢复事实只描述消费者见过但尚未交付完成块的工具，不包含参数正文。 */
export function getUndeliveredModelTools(delivery: ModelResponseDelivery) {
  return [...delivery.pendingTools]
    .filter(([index]) => !delivery.deliveredBlocks.has(index))
    .map(([, tool]) => ({ ...tool }));
}

/** 仅保存消息外壳；块正文由上游完成结果或终态快照提供。 */
function updateMessage(
  message: ModelMessage,
  event: ModelStreamEvent | ModelCompleteEvent,
): ModelMessage {
  switch (event.type) {
    case 'message_start':
      return {
        messageId: event.message.id,
        model: event.message.model,
        blocks: [],
        usage: event.message.usage,
      };
    case 'message_delta':
      return {
        ...message,
        stopReason: event.delta.stopReason,
        usage: mergeUsage(message.usage, event.usage),
      };
    case 'message_complete':
      return {
        ...event.result,
        blocks: [],
        usage: mergeUsage(message.usage, event.result.usage),
      };
    default:
      return message;
  }
}

/** 同请求按字段更新：未上报字段不覆盖，明确的零值保留。 */
function mergeUsage(
  previous: ModelStreamUsage = {},
  next: ModelStreamUsage = {},
): ModelStreamUsage {
  return {
    inputTokens: next.inputTokens ?? previous.inputTokens,
    outputTokens: next.outputTokens ?? previous.outputTokens,
    cacheReadInputTokens:
      next.cacheReadInputTokens ?? previous.cacheReadInputTokens,
    cacheCreationInputTokens:
      next.cacheCreationInputTokens ?? previous.cacheCreationInputTokens,
    reasoningTokens: next.reasoningTokens ?? previous.reasoningTokens,
  };
}

export function projectModelUsage(
  source: ModelStreamUsage = {},
  requestId: string,
) {
  const usage = cloneUsage();
  usage.input_tokens = source.inputTokens ?? 0;
  usage.output_tokens = source.outputTokens ?? 0;
  usage.cache_read_input_tokens = source.cacheReadInputTokens ?? 0;
  usage.cache_creation_input_tokens = source.cacheCreationInputTokens ?? 0;
  markCacheReadUsageAvailable(usage, source.cacheReadInputTokens !== undefined);
  markCacheWriteUsageAvailable(
    usage,
    source.cacheCreationInputTokens !== undefined,
  );
  attachThinkingTokenCount(usage, source.reasoningTokens);
  usage.request_id = requestId;
  return usage;
}

function validateModelBlock(block: ModelContentBlock): ModelContentBlock {
  if (block.type !== 'tool_use') return structuredClone(block);
  return normalizeModelToolUseBlock(block);
}
