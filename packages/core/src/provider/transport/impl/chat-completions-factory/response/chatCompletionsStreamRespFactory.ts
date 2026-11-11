/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { ClientError } from '../../../../../client/clientError.js';
import type {
  ModelStreamEvent,
  ModelStopReason,
  ModelStreamUsage,
} from '../../../../event/modelStreamEvent.js';

/**
 * Chat Completions chunk 流 → 中立流式事件工厂。
 *
 * 与 request/ 方向对称。OpenAI chunk 是扁平增量（每帧独立携带 delta 内容），
 * 中立事件流是 Anthropic 形状的分块生命周期（content_block_start/delta/stop），
 * 因此本工厂是有状态的归一器：
 *
 * - 首个 chunk 合成 message_start（id/model 取自该 chunk，usage 若同帧已带
 *   则一并下发）。
 * - 内容分块按类型懒开块：delta.content → text 块；delta.reasoning_content
 *   （DeepSeek 系非标准扩展，SDK 类型不承载，按未知键窄化读取）→ thinking 块；
 *   tool_calls 按 wire 的 tool index 各占一个 tool_use 块。同一时刻至多一个
 *   文本/thinking 块处于开启态，类型切换或工具块开启时先补 content_block_stop。
 * - finish_reason → ModelStopReason 映射：stop→end_turn、length→max_tokens、
 *   tool_calls/function→tool_use、content_filter→refusal。finish_reason 帧只关闭全部
 *   开启块并记下停止原因；include_usage 的 usage 在其后的空 choices 尾帧才到，
 *   message_delta（stopReason + usage）与 message_stop 统一在流结束时下发。
 * - usage：prompt_tokens→inputTokens、completion_tokens→outputTokens、
 *   prompt_tokens_details.cached_tokens→cacheReadInputTokens、
 *   completion_tokens_details.reasoning_tokens→reasoningTokens；取最后一次到达的值。
 * - 帧内 error 对象（兼容服务端在 SSE 中下发的错误）按迭代器失败抛出。
 */
export async function* buildChatCompletionsStreamEvents(
  frames: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<ModelStreamEvent, void, unknown> {
  const state = new ChatCompletionsStreamState();
  for await (const chunk of frames) {
    for (const event of state.consume(chunk)) {
      yield event;
    }
  }
  for (const event of state.flush()) {
    yield event;
  }
}

/** 单次流式调用的归一状态：分块索引、开启块、工具块映射与收尾信息。 */
class ChatCompletionsStreamState {
  private started = false;
  private nextBlockIndex = 0;
  private stopReason: ModelStopReason | undefined;
  private usage: ModelStreamUsage | undefined;
  private openTextBlock: number | undefined;
  private openThinkingBlock: number | undefined;
  private readonly toolBlocks = new Map<
    number,
    { blockIndex: number; closed: boolean }
  >();

  consume(chunk: ChatCompletionChunk): ModelStreamEvent[] {
    throwIfErrorChunk(chunk);
    const events: ModelStreamEvent[] = [];
    const usage = projectUsage(chunk.usage);
    if (usage) {
      this.usage = usage;
    }
    if (!this.started) {
      this.started = true;
      events.push({
        type: 'message_start',
        message: {
          id: chunk.id ?? '',
          role: 'assistant',
          model: chunk.model ?? '',
          ...(usage ? { usage } : {}),
        },
      });
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (!delta) {
      return events;
    }
    // thinking 块切换（reasoning_content → content 视为两段分块）。
    const thinking = readReasoningContent(delta);
    if (thinking !== undefined && thinking.length > 0) {
      if (this.openTextBlock !== undefined) {
        events.push(...this.closeText());
      }
      if (this.openThinkingBlock === undefined) {
        this.openThinkingBlock = this.nextBlockIndex++;
        events.push({
          type: 'content_block_start',
          index: this.openThinkingBlock,
          contentBlock: { type: 'thinking', thinking: '' },
        });
      }
      events.push({
        type: 'content_block_delta',
        index: this.openThinkingBlock,
        delta: { type: 'thinking_delta', thinking },
      });
    }
    const text = typeof delta.content === 'string' ? delta.content : undefined;
    if (text !== undefined && text.length > 0) {
      if (this.openThinkingBlock !== undefined) {
        events.push(...this.closeThinking());
      }
      if (this.openTextBlock === undefined) {
        this.openTextBlock = this.nextBlockIndex++;
        events.push({
          type: 'content_block_start',
          index: this.openTextBlock,
          contentBlock: { type: 'text', text: '' },
        });
      }
      events.push({
        type: 'content_block_delta',
        index: this.openTextBlock,
        delta: { type: 'text_delta', text },
      });
    }
    events.push(...this.consumeToolCalls(delta));
    if (choice?.finish_reason) {
      events.push(...this.closeAll());
      this.stopReason = mapStopReason(choice.finish_reason);
    }
    return events;
  }

  /** 只有收到 finish_reason 才收尾；提前 EOF 留给 Provider 判断断流。 */
  flush(): ModelStreamEvent[] {
    if (!this.started || !this.stopReason) {
      return [];
    }
    return [
      ...this.closeAll(),
      {
        type: 'message_delta',
        delta: { stopReason: this.stopReason },
        ...(this.usage ? { usage: this.usage } : {}),
      },
      { type: 'message_stop' },
    ];
  }

  private consumeToolCalls(
    delta: ChatCompletionChunk['choices'][number]['delta'],
  ): ModelStreamEvent[] {
    const events: ModelStreamEvent[] = [];
    for (const toolCall of delta.tool_calls ?? []) {
      const wireIndex = toolCall.index ?? 0;
      let block = this.toolBlocks.get(wireIndex);
      if (block?.closed) {
        // wire 补发已关闭块的增量属异常形态，丢弃保流内一致性。
        continue;
      }
      if (!block) {
        events.push(...this.closeThinking(), ...this.closeText());
        const blockIndex = this.nextBlockIndex++;
        this.toolBlocks.set(wireIndex, (block = { blockIndex, closed: false }));
        events.push({
          type: 'content_block_start',
          index: blockIndex,
          contentBlock: {
            type: 'tool_use',
            id: toolCall.id ?? '',
            name: toolCall.function?.name ?? '',
            input: {},
          },
        });
      }
      const args = toolCall.function?.arguments;
      if (args !== undefined && args.length > 0) {
        events.push({
          type: 'content_block_delta',
          index: block.blockIndex,
          delta: { type: 'input_json_delta', partial_json: args },
        });
      }
    }
    return events;
  }

  private closeText(): ModelStreamEvent[] {
    if (this.openTextBlock === undefined) return [];
    const events: ModelStreamEvent[] = [
      { type: 'content_block_stop', index: this.openTextBlock },
    ];
    this.openTextBlock = undefined;
    return events;
  }

  private closeThinking(): ModelStreamEvent[] {
    if (this.openThinkingBlock === undefined) return [];
    const events: ModelStreamEvent[] = [
      { type: 'content_block_stop', index: this.openThinkingBlock },
    ];
    this.openThinkingBlock = undefined;
    return events;
  }

  /** 关闭全部开启块；usage 与停止原因留到 flush 的 message_delta 下发。 */
  private closeAll(): ModelStreamEvent[] {
    return [...this.closeThinking(), ...this.closeText(), ...this.closeTools()];
  }

  private closeTools(): ModelStreamEvent[] {
    const events: ModelStreamEvent[] = [];
    for (const block of this.toolBlocks.values()) {
      if (!block.closed) {
        block.closed = true;
        events.push({ type: 'content_block_stop', index: block.blockIndex });
      }
    }
    return events;
  }
}

/** 兼容服务端可能在 SSE 帧里下发 {error:{message}}，SDK 类型不承载，窄化读取。 */
function throwIfErrorChunk(chunk: ChatCompletionChunk): void {
  const error = (chunk as unknown as Record<string, unknown>)['error'];
  if (error === undefined || error === null) return;
  const message = isErrorWithMessage(error)
    ? error.message
    : JSON.stringify(error);
  const code = (error as Record<string, unknown>)['code'];
  throw new ClientError(`Chat Completions 流内错误：${message}`, {
    code:
      typeof code === 'string' || typeof code === 'number'
        ? String(code)
        : undefined,
    responseBody: JSON.stringify({ error }),
  });
}

interface ErrorWithMessage {
  readonly message: string;
}

function isErrorWithMessage(value: unknown): value is ErrorWithMessage {
  if (value === null || typeof value !== 'object' || !('message' in value)) {
    return false;
  }
  return typeof value.message === 'string';
}

/** finish_reason → ModelStopReason；未知值保守按 end_turn 处理。 */
function mapStopReason(finishReason: string): ModelStopReason {
  switch (finishReason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/** reasoning_content 是 DeepSeek 系非标准扩展，SDK 类型不承载，窄化读取。 */
function readReasoningContent(
  delta: object,
): string | undefined {
  const value = (delta as unknown as Record<string, unknown>)[
    'reasoning_content'
  ];
  return typeof value === 'string' ? value : undefined;
}

function projectUsage(
  usage: ChatCompletionChunk['usage'],
): ModelStreamUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(usage.prompt_tokens_details?.cached_tokens !== undefined
      ? { cacheReadInputTokens: usage.prompt_tokens_details.cached_tokens }
      : {}),
    ...(usage.completion_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
      : {}),
  };
}
