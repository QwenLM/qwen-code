/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ContentBlock,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { ClientError } from '../../../../../client/clientError.js';
import type {
  ModelStreamEvent,
  ModelStopReason,
  ModelStreamUsage,
} from '../../../../event/modelStreamEvent.js';

/**
 * Anthropic Messages SSE 事件流 → 中立流式事件工厂。
 *
 * 与 request/ 方向对称。中立事件流即以 Anthropic 事件为语义骨架改造而来，
 * 本工厂是近 1:1 投影，只做以下收敛：
 *
 * - 块索引：服务端工具等中立契约不承载的块整块忽略（含其 delta / stop），
 *   保留块按出现顺序重排为连续的中立 index，聚合器不出现空洞。
 * - 块起始：start 帧自带的初始内容（text / thinking / signature / 非空
 *   tool input）补发为 delta，不依赖服务端一定走增量。
 * - usage：message_start 的 usage 与 message_delta 的 usage 合并后下发
 *   （聚合器整体替换 usage，delta 只带输出计数时不能覆盖掉输入计数）；
 *   计数为 0 同样保留，null / 缺省不落键。
 * - stop_reason：end_turn / max_tokens / tool_use / refusal 直传；
 *   model_context_window_exceeded（兼容服务端）→ max_tokens；stop_sequence /
 *   pause_turn 等其余值收敛为 end_turn。
 * - error 事件（SDK 类型未收录，但 SSE 会下发）直接抛出，不静默吞掉。
 * - 其余未知事件类型忽略（SDK 后续新增事件不致中断归一流）。
 */
export async function* buildMessagesStreamEvents(
  frames: AsyncIterable<RawMessageStreamEvent>,
): AsyncGenerator<ModelStreamEvent, void, unknown> {
  /** wire index → 中立 index；未登记的 wire 块即被忽略的块。 */
  const indexMap = new Map<number, number>();
  let nextIndex = 0;
  let usage: ModelStreamUsage | undefined;

  for await (const frame of frames) {
    switch (frame.type) {
      case 'message_start': {
        usage = projectUsage(frame.message.usage);
        yield {
          type: 'message_start',
          message: {
            id: frame.message.id ?? '',
            role: 'assistant',
            model: frame.message.model ?? '',
            usage,
          },
        };
        break;
      }
      case 'content_block_start': {
        const index = nextIndex;
        const events = projectBlockStart(frame.content_block, index);
        if (events.length > 0) {
          indexMap.set(frame.index, index);
          nextIndex += 1;
          yield* events;
        }
        break;
      }
      case 'content_block_delta': {
        const index = indexMap.get(frame.index);
        if (index === undefined) break;
        // citations_delta 等中立契约不承载的增量型忽略。
        const delta = frame.delta;
        if (delta.type === 'text_delta') {
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: delta.text },
          };
        } else if (delta.type === 'thinking_delta') {
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: delta.thinking },
          };
        } else if (delta.type === 'signature_delta') {
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'signature_delta', signature: delta.signature },
          };
        } else if (delta.type === 'input_json_delta') {
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: delta.partial_json },
          };
        }
        break;
      }
      case 'content_block_stop': {
        const index = indexMap.get(frame.index);
        if (index === undefined) break;
        indexMap.delete(frame.index);
        yield { type: 'content_block_stop', index };
        break;
      }
      case 'message_delta': {
        const deltaUsage = projectUsage(frame.usage);
        if (deltaUsage) {
          usage = { ...usage, ...deltaUsage };
        }
        yield {
          type: 'message_delta',
          delta: {
            stopReason: mapStopReason(frame.delta.stop_reason),
          },
          ...(usage ? { usage } : {}),
        };
        break;
      }
      case 'message_stop': {
        yield { type: 'message_stop' };
        break;
      }
      default:
        throwIfErrorFrame(frame);
        break;
    }
  }
}

/** 块起始投影；不承载的块型返回空表，调用方据此不登记索引。 */
function projectBlockStart(
  block: ContentBlock,
  index: number,
): ModelStreamEvent[] {
  switch (block.type) {
    case 'text': {
      const events: ModelStreamEvent[] = [
        {
          type: 'content_block_start',
          index,
          contentBlock: { type: 'text', text: '' },
        },
      ];
      if (block.text) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        });
      }
      return events;
    }
    case 'thinking': {
      const events: ModelStreamEvent[] = [
        {
          type: 'content_block_start',
          index,
          contentBlock: { type: 'thinking', thinking: '' },
        },
      ];
      if (block.thinking) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: block.thinking },
        });
      }
      if (block.signature) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: block.signature },
        });
      }
      return events;
    }
    case 'redacted_thinking':
      return [
        {
          type: 'content_block_start',
          index,
          contentBlock: { type: 'redacted_thinking', data: block.data },
        },
      ];
    case 'tool_use': {
      const events: ModelStreamEvent[] = [
        {
          type: 'content_block_start',
          index,
          contentBlock: {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: {},
          },
        },
      ];
      // 流式下 start 帧的 input 恒为 {}，参数随 input_json_delta 到达；非空
      // 时才补发，避免与后续增量拼成非法 JSON。
      const input = block.input;
      if (
        input !== null &&
        typeof input === 'object' &&
        Object.keys(input).length > 0
      ) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
        });
      }
      return events;
    }
    default:
      return [];
  }
}

/** SSE 的 error 事件不在 SDK 联合类型里，按运行时形状识别后抛出。 */
function throwIfErrorFrame(frame: { type: string }): void {
  if (frame.type !== 'error') return;
  const error = (frame as { error?: { type?: string; message?: string } })
    .error;
  const detail = [error?.type, error?.message].filter(Boolean).join(': ');
  throw new ClientError(`Messages 流内错误：${detail || 'unknown error'}`, {
    code: error?.type,
    responseBody: JSON.stringify(frame),
  });
}

/** 'stop_sequence' 等不在中立值域的值收敛为 'end_turn'。 */
function mapStopReason(
  stopReason: string | null | undefined,
): ModelStopReason {
  switch (stopReason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'tool_use':
      return 'tool_use';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function projectUsage(
  usage:
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      }
    | null
    | undefined,
): ModelStreamUsage | undefined {
  if (!usage) return undefined;
  return {
    ...(usage.input_tokens != null ? { inputTokens: usage.input_tokens } : {}),
    ...(usage.output_tokens != null
      ? { outputTokens: usage.output_tokens }
      : {}),
    ...(usage.cache_creation_input_tokens != null
      ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
      : {}),
    ...(usage.cache_read_input_tokens != null
      ? { cacheReadInputTokens: usage.cache_read_input_tokens }
      : {}),
  };
}
