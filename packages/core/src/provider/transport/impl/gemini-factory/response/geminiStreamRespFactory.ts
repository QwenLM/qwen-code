/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponse, Part } from '@google/genai';
import type {
  ModelStopReason,
  ModelStreamEvent,
  ModelStreamUsage,
} from '../../../../event/modelStreamEvent.js';

/**
 * Gemini `streamGenerateContent` 帧 → 中立流式事件工厂。
 *
 * Gemini 帧与 Chat Completions 类似是扁平增量：text/thought part 直接追加，
 * functionCall 整块到达。中立事件流仍按分块生命周期输出：
 * - 首帧合成 message_start；text part 懒开 text 块，thought part 懒开
 *   thinking 块，类型切换先关旧块。
 * - functionCall 立即输出 tool_use 的开块、input_json_delta（完整参数）和
 *   关块；Gemini 不提供调用 id，由本工厂生成稳定序号 id。
 * - finishReason 映射到 ModelStopReason；出现过工具调用时以 tool_use 收口。
 * - usageMetadata 取最后一次到达的值，在 message_delta 统一下发。
 */
export async function* buildGeminiStreamEvents(
  frames: AsyncIterable<GenerateContentResponse>,
  fallbackModel = '',
): AsyncGenerator<ModelStreamEvent, void, unknown> {
  const state = new GeminiStreamState(fallbackModel);
  for await (const frame of frames) {
    for (const event of state.consume(frame)) {
      yield event;
    }
  }
  for (const event of state.flush()) {
    yield event;
  }
}

class GeminiStreamState {
  private started = false;
  private nextBlockIndex = 0;
  private stopReason: ModelStopReason | undefined;
  private usage: ModelStreamUsage | undefined;
  private openTextBlock: number | undefined;
  private openThinkingBlock: number | undefined;
  private emittedToolCall = false;

  constructor(private readonly fallbackModel: string) {}

  consume(frame: GenerateContentResponse): ModelStreamEvent[] {
    const events: ModelStreamEvent[] = [];
    const usage = projectUsage(frame.usageMetadata);
    if (usage) this.usage = usage;
    if (!this.started) {
      this.started = true;
      events.push({
        type: 'message_start',
        message: {
          id: '',
          role: 'assistant',
          model: frame.modelVersion ?? this.fallbackModel,
          ...(usage ? { usage } : {}),
        },
      });
    }

    const candidate = frame.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      events.push(...this.consumePart(part));
    }
    if (candidate?.finishReason) {
      events.push(...this.closeAll());
      this.stopReason = this.emittedToolCall
        ? 'tool_use'
        : mapStopReason(candidate.finishReason);
    }
    return events;
  }

  /** 只有收到 finishReason 才收尾；提前 EOF 留给 Provider 判断断流。 */
  flush(): ModelStreamEvent[] {
    if (!this.started || !this.stopReason) return [];
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

  private consumePart(part: Part): ModelStreamEvent[] {
    if (part.functionCall) {
      return this.consumeFunctionCall(part.functionCall, part.thoughtSignature);
    }
    if (typeof part.text !== 'string' || part.text.length === 0) {
      return [];
    }
    return part.thought === true
      ? this.appendThinking(part.text, part.thoughtSignature)
      : this.appendText(part.text);
  }

  private appendText(text: string): ModelStreamEvent[] {
    const events = this.closeThinking();
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
    return events;
  }

  private appendThinking(
    thinking: string,
    thoughtSignature?: string,
  ): ModelStreamEvent[] {
    const events = this.closeText();
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
    if (thoughtSignature !== undefined) {
      events.push({
        type: 'content_block_delta',
        index: this.openThinkingBlock,
        delta: { type: 'signature_delta', signature: thoughtSignature },
      });
    }
    return events;
  }

  private consumeFunctionCall(
    call: NonNullable<Part['functionCall']>,
    thoughtSignature?: string,
  ): ModelStreamEvent[] {
    const events = [...this.closeThinking(), ...this.closeText()];
    const index = this.nextBlockIndex++;
    this.emittedToolCall = true;
    events.push(
      {
        type: 'content_block_start',
        index,
        contentBlock: {
          type: 'tool_use',
          id: `gemini-tool-${index}`,
          name: call.name ?? '',
          input: {},
          ...(thoughtSignature !== undefined ? { thoughtSignature } : {}),
        },
      },
      {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(call.args ?? {}),
        },
      },
      { type: 'content_block_stop', index },
    );
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

  private closeAll(): ModelStreamEvent[] {
    return [...this.closeThinking(), ...this.closeText()];
  }
}

function mapStopReason(finishReason: string): ModelStopReason {
  switch (finishReason) {
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function projectUsage(
  usage: GenerateContentResponse['usageMetadata'],
): ModelStreamUsage | undefined {
  if (!usage) return undefined;
  return {
    ...(usage.promptTokenCount !== undefined
      ? { inputTokens: usage.promptTokenCount }
      : {}),
    ...(usage.candidatesTokenCount !== undefined
      ? { outputTokens: usage.candidatesTokenCount }
      : {}),
    ...(usage.thoughtsTokenCount !== undefined
      ? { reasoningTokens: usage.thoughtsTokenCount }
      : {}),
    ...(usage.cachedContentTokenCount !== undefined
      ? { cacheReadInputTokens: usage.cachedContentTokenCount }
      : {}),
  };
}
