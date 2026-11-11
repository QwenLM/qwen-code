/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Response,
  ResponseOutputItem,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import { ClientError } from '../../../../../client/clientError.js';
import type {
  ModelReasoningMetadata,
  ModelStopReason,
  ModelStreamEvent,
  ModelStreamUsage,
} from '../../../../event/modelStreamEvent.js';

/**
 * Responses SSE 事件流 → 中立流式事件工厂。
 *
 * 与 request/ 方向对称。Responses 事件粒度是输出项生命周期（output_item
 * added/done + 各类 delta），映射为按 output_index 对位的分块事件：
 *
 * - message_start：response.created / in_progress 携带 id/model；上游缺这两帧
 *   时由首个其他帧兜底发出。
 * - message 项：首个 output_text / refusal delta 懒开 text 块（中立契约无空
 *   message 块）；done 时若没收到过增量，以 item 全文补发。
 * - function_call 项：added 开 tool_use 块，id 取 call_id（工具结果回填用的
 *   关联键，不是项 id）；参数未流式到达时 done 以 item.arguments 补发。
 * - reasoning 项：首个 reasoning_text / reasoning_summary_text delta 懒开
 *   thinking 块（带 reasoning.id/type），多段摘要之间插入空行；done 时关块并
 *   附完整元数据（status/summary/content），未收到增量时以 item 可见文本补发；
 *   有 encrypted_content 时追加一个 redacted_thinking 块承载密文，供下一轮按
 *   reasoning.id 合并回放（对齐 RemoteChat 约定）。
 * - 收尾：response.completed / incomplete 关闭全部开启块 + message_delta +
 *   message_stop。stop_reason：incomplete max_output_tokens → max_tokens，
 *   content_filter 或出现 refusal → refusal，出现过 function_call → tool_use，
 *   其余 end_turn。usage 取 response.usage（含 cached_tokens / reasoning_tokens）。
 *   缺少终态的提前 EOF 不合成完成事件，由 Provider 判断断流。
 * - 错误：response.failed 与 error 事件直接抛出，不静默吞掉。
 * 契约留白未接：web_search 等服务端执行工具项、annotation、引用。
 */
export async function* buildResponsesStreamEvents(
  frames: AsyncIterable<ResponseStreamEvent>,
): AsyncGenerator<ModelStreamEvent, void, unknown> {
  const state = new ResponsesStreamState();
  for await (const frame of frames) {
    for (const event of state.consume(frame)) {
      yield event;
    }
  }
}

type ResponseUsage = NonNullable<Response['usage']>;

interface OpenBlock {
  readonly blockIndex: number;
  readonly kind: 'text' | 'thinking' | 'tool_use';
  /** 是否已收到过流式增量；done 时据此决定是否以 item 全量补发。 */
  streamed: boolean;
}

/** 单次流式调用的归一状态：message_start 已发标记、分块索引与开启块。 */
class ResponsesStreamState {
  private started = false;
  private finished = false;
  private nextBlockIndex = 0;
  private sawToolUse = false;
  private sawRefusal = false;
  /** output_index → 开启块。 */
  private readonly openBlocks = new Map<number, OpenBlock>();

  consume(frame: ResponseStreamEvent): ModelStreamEvent[] {
    if (frame.type === 'error') {
      throw new ClientError(
        `Responses 流内错误：${[frame.code, frame.message].filter(Boolean).join(': ')}`,
        { code: frame.code ?? undefined, responseBody: JSON.stringify(frame) },
      );
    }
    if (frame.type === 'response.failed') {
      const error = frame.response.error;
      throw new ClientError(
        `Responses 请求失败：${error ? `${error.code}: ${error.message}` : 'unknown error'}`,
        {
          code: error?.code ?? undefined,
          responseBody: JSON.stringify({ error }),
        },
      );
    }
    const events: ModelStreamEvent[] = this.ensureStarted(
      frame.type === 'response.created' ||
        frame.type === 'response.in_progress'
        ? frame.response
        : undefined,
    );
    switch (frame.type) {
      case 'response.output_item.added':
        events.push(...this.itemAdded(frame.output_index, frame.item));
        break;
      case 'response.output_text.delta':
        events.push(...this.textDelta(frame.output_index, frame.delta));
        break;
      case 'response.refusal.delta':
        this.sawRefusal = true;
        events.push(...this.textDelta(frame.output_index, frame.delta));
        break;
      case 'response.reasoning_summary_part.added':
        // 多段摘要之间以空行分隔，首段不加。
        if (frame.summary_index > 0) {
          events.push(...this.thinkingDelta(frame.output_index, frame.item_id, '\n\n'));
        }
        break;
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta':
        events.push(
          ...this.thinkingDelta(frame.output_index, frame.item_id, frame.delta),
        );
        break;
      case 'response.function_call_arguments.delta': {
        const block = this.openBlocks.get(frame.output_index);
        if (block?.kind === 'tool_use' && frame.delta) {
          block.streamed = true;
          events.push({
            type: 'content_block_delta',
            index: block.blockIndex,
            delta: { type: 'input_json_delta', partial_json: frame.delta },
          });
        }
        break;
      }
      case 'response.output_item.done':
        events.push(...this.itemDone(frame.output_index, frame.item));
        break;
      case 'response.completed':
      case 'response.incomplete':
        events.push(...this.finish(frame.response));
        break;
      default:
        break;
    }
    return events;
  }

  private ensureStarted(response: Response | undefined): ModelStreamEvent[] {
    if (this.started) return [];
    this.started = true;
    return [
      {
        type: 'message_start',
        message: {
          id: response?.id ?? '',
          role: 'assistant',
          model: response?.model ?? '',
        },
      },
    ];
  }

  private finish(response: Response | undefined): ModelStreamEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const usage = projectUsage(response?.usage);
    return [
      ...this.closeAll(),
      {
        type: 'message_delta',
        delta: { stopReason: this.stopReason(response) },
        ...(usage ? { usage } : {}),
      },
      { type: 'message_stop' },
    ];
  }

  private stopReason(response: Response | undefined): ModelStopReason {
    switch (response?.incomplete_details?.reason) {
      case 'max_output_tokens':
        return 'max_tokens';
      case 'content_filter':
        return 'refusal';
      default:
        break;
    }
    if (this.sawRefusal) return 'refusal';
    return this.sawToolUse ? 'tool_use' : 'end_turn';
  }

  private itemAdded(
    outputIndex: number,
    item: ResponseOutputItem,
  ): ModelStreamEvent[] {
    if (item.type !== 'function_call') {
      // message / reasoning 项等首个增量懒开，不发空块。
      return [];
    }
    this.sawToolUse = true;
    return this.openToolUse(outputIndex, item.call_id, item.name);
  }

  private itemDone(
    outputIndex: number,
    item: ResponseOutputItem,
  ): ModelStreamEvent[] {
    switch (item.type) {
      case 'message':
        return this.messageDone(outputIndex, item);
      case 'function_call':
        return this.functionCallDone(outputIndex, item);
      case 'reasoning':
        return this.reasoningDone(outputIndex, item);
      default:
        return this.close(outputIndex);
    }
  }

  private messageDone(
    outputIndex: number,
    item: Extract<ResponseOutputItem, { type: 'message' }>,
  ): ModelStreamEvent[] {
    const events: ModelStreamEvent[] = [];
    if (!this.openBlocks.get(outputIndex)?.streamed) {
      const text = item.content
        .map((part) => {
          if (part.type === 'refusal') {
            this.sawRefusal = true;
            return part.refusal;
          }
          return part.text;
        })
        .join('');
      if (text) events.push(...this.textDelta(outputIndex, text));
    }
    events.push(...this.close(outputIndex));
    return events;
  }

  private functionCallDone(
    outputIndex: number,
    item: Extract<ResponseOutputItem, { type: 'function_call' }>,
  ): ModelStreamEvent[] {
    this.sawToolUse = true;
    const events: ModelStreamEvent[] = [];
    let block = this.openBlocks.get(outputIndex);
    if (block?.kind !== 'tool_use') {
      events.push(...this.close(outputIndex));
      events.push(...this.openToolUse(outputIndex, item.call_id, item.name));
      block = this.openBlocks.get(outputIndex);
    }
    if (block && !block.streamed && item.arguments) {
      events.push({
        type: 'content_block_delta',
        index: block.blockIndex,
        delta: { type: 'input_json_delta', partial_json: item.arguments },
      });
    }
    events.push(...this.close(outputIndex));
    return events;
  }

  /** 关 thinking 块时附完整元数据；有密文时追加 redacted_thinking 块。 */
  private reasoningDone(
    outputIndex: number,
    item: ResponseReasoningItem,
  ): ModelStreamEvent[] {
    const events: ModelStreamEvent[] = [];
    if (!this.openBlocks.get(outputIndex)?.streamed) {
      const visible = visibleReasoningText(item);
      if (visible) {
        events.push(...this.thinkingDelta(outputIndex, item.id, visible));
      }
    }
    const metadata = reasoningMetadata(item);
    const block = this.openBlocks.get(outputIndex);
    if (block) {
      this.openBlocks.delete(outputIndex);
      events.push({
        type: 'content_block_stop',
        index: block.blockIndex,
        reasoning: metadata,
      });
    }
    if (item.encrypted_content) {
      const blockIndex = this.nextBlockIndex++;
      events.push(
        {
          type: 'content_block_start',
          index: blockIndex,
          contentBlock: {
            type: 'redacted_thinking',
            data: item.encrypted_content,
            reasoning: block ? { id: item.id, type: item.type } : metadata,
          },
        },
        { type: 'content_block_stop', index: blockIndex },
      );
    }
    return events;
  }

  private openToolUse(
    outputIndex: number,
    callId: string,
    name: string,
  ): ModelStreamEvent[] {
    const blockIndex = this.nextBlockIndex++;
    this.openBlocks.set(outputIndex, {
      blockIndex,
      kind: 'tool_use',
      streamed: false,
    });
    return [
      {
        type: 'content_block_start',
        index: blockIndex,
        contentBlock: { type: 'tool_use', id: callId, name, input: {} },
      },
    ];
  }

  private textDelta(outputIndex: number, text: string): ModelStreamEvent[] {
    if (!text) return [];
    const events: ModelStreamEvent[] = [];
    let block = this.openBlocks.get(outputIndex);
    if (block?.kind !== 'text') {
      events.push(...this.close(outputIndex));
      block = { blockIndex: this.nextBlockIndex++, kind: 'text', streamed: false };
      this.openBlocks.set(outputIndex, block);
      events.push({
        type: 'content_block_start',
        index: block.blockIndex,
        contentBlock: { type: 'text', text: '' },
      });
    }
    block.streamed = true;
    events.push({
      type: 'content_block_delta',
      index: block.blockIndex,
      delta: { type: 'text_delta', text },
    });
    return events;
  }

  private thinkingDelta(
    outputIndex: number,
    itemId: string,
    thinking: string,
  ): ModelStreamEvent[] {
    if (!thinking) return [];
    const events: ModelStreamEvent[] = [];
    let block = this.openBlocks.get(outputIndex);
    if (block?.kind !== 'thinking') {
      events.push(...this.close(outputIndex));
      block = {
        blockIndex: this.nextBlockIndex++,
        kind: 'thinking',
        streamed: false,
      };
      this.openBlocks.set(outputIndex, block);
      events.push({
        type: 'content_block_start',
        index: block.blockIndex,
        contentBlock: {
          type: 'thinking',
          thinking: '',
          reasoning: { id: itemId, type: 'reasoning' },
        },
      });
    }
    block.streamed = true;
    events.push({
      type: 'content_block_delta',
      index: block.blockIndex,
      delta: { type: 'thinking_delta', thinking },
    });
    return events;
  }

  private close(outputIndex: number): ModelStreamEvent[] {
    const block = this.openBlocks.get(outputIndex);
    if (!block) return [];
    this.openBlocks.delete(outputIndex);
    return [{ type: 'content_block_stop', index: block.blockIndex }];
  }

  private closeAll(): ModelStreamEvent[] {
    const events: ModelStreamEvent[] = [];
    for (const block of this.openBlocks.values()) {
      events.push({ type: 'content_block_stop', index: block.blockIndex });
    }
    this.openBlocks.clear();
    return events;
  }
}

/** 摘要优先，没有摘要时取原始推理文本；多段之间以空行分隔。 */
function visibleReasoningText(item: ResponseReasoningItem): string {
  const parts = item.summary.length > 0 ? item.summary : (item.content ?? []);
  return parts
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n\n');
}

function reasoningMetadata(item: ResponseReasoningItem): ModelReasoningMetadata {
  return {
    id: item.id,
    type: item.type,
    ...(item.status ? { status: item.status } : {}),
    summary: item.summary.map((part) => ({ type: part.type, text: part.text })),
    ...(item.content
      ? {
          content: item.content.map((part) => ({
            type: part.type,
            text: part.text,
          })),
        }
      : {}),
  };
}

function projectUsage(
  usage: ResponseUsage | undefined,
): ModelStreamUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.input_tokens_details?.cached_tokens != null
      ? { cacheReadInputTokens: usage.input_tokens_details.cached_tokens }
      : {}),
    ...(usage.output_tokens_details?.reasoning_tokens != null
      ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens }
      : {}),
  };
}
