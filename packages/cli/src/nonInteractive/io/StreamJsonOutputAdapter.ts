/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type {
  Config,
  ServerGeminiStreamEvent,
  ToolCallRequestInfo,
  ToolCallResponseInfo,
} from '@qwen-code/qwen-code-core';
import { GeminiEventType } from '@qwen-code/qwen-code-core';
import type { Part, GenerateContentResponseUsageMetadata } from '@google/genai';
import type {
  CLIAssistantMessage,
  CLIPartialAssistantMessage,
  CLIResultMessage,
  CLIResultMessageError,
  CLIResultMessageSuccess,
  CLIUserMessage,
  ContentBlock,
  ExtendedUsage,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from '../types.js';
import type {
  JsonOutputAdapterInterface,
  ResultOptions,
} from './JsonOutputAdapter.js';

/**
 * Stream JSON output adapter that emits messages immediately
 * as they are completed during the streaming process.
 */
export class StreamJsonOutputAdapter implements JsonOutputAdapterInterface {
  lastAssistantMessage: CLIAssistantMessage | null = null;

  // Assistant message building state
  private messageId: string | null = null;
  private blocks: ContentBlock[] = [];
  private openBlocks = new Set<number>();
  private usage: Usage = this.createUsage();
  private messageStarted = false;
  private finalized = false;
  private currentBlockType: ContentBlock['type'] | null = null;

  constructor(
    private readonly config: Config,
    private readonly includePartialMessages: boolean,
  ) {}

  private createUsage(
    metadata?: GenerateContentResponseUsageMetadata | null,
  ): Usage {
    const usage: Usage = {
      input_tokens: 0,
      output_tokens: 0,
    };

    if (!metadata) {
      return usage;
    }

    if (typeof metadata.promptTokenCount === 'number') {
      usage.input_tokens = metadata.promptTokenCount;
    }
    if (typeof metadata.candidatesTokenCount === 'number') {
      usage.output_tokens = metadata.candidatesTokenCount;
    }
    if (typeof metadata.cachedContentTokenCount === 'number') {
      usage.cache_read_input_tokens = metadata.cachedContentTokenCount;
    }
    if (typeof metadata.totalTokenCount === 'number') {
      usage.total_tokens = metadata.totalTokenCount;
    }

    return usage;
  }

  private buildMessage(): CLIAssistantMessage {
    if (!this.messageId) {
      throw new Error('Message not started');
    }

    // Enforce constraint: assistant message must contain only a single type of ContentBlock
    if (this.blocks.length > 0) {
      const blockTypes = new Set(this.blocks.map((block) => block.type));
      if (blockTypes.size > 1) {
        throw new Error(
          `Assistant message must contain only one type of ContentBlock, found: ${Array.from(blockTypes).join(', ')}`,
        );
      }
    }

    // Determine stop_reason based on content block types
    // If the message contains only tool_use blocks, set stop_reason to 'tool_use'
    const stopReason =
      this.blocks.length > 0 &&
      this.blocks.every((block) => block.type === 'tool_use')
        ? 'tool_use'
        : null;

    return {
      type: 'assistant',
      uuid: this.messageId,
      session_id: this.config.getSessionId(),
      parent_tool_use_id: null,
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.config.getModel(),
        content: this.blocks,
        stop_reason: stopReason,
        usage: this.usage,
      },
    };
  }

  private appendText(fragment: string): void {
    if (fragment.length === 0) {
      return;
    }

    this.ensureBlockTypeConsistency('text');
    this.ensureMessageStarted();

    let current = this.blocks[this.blocks.length - 1];
    if (!current || current.type !== 'text') {
      current = { type: 'text', text: '' } satisfies TextBlock;
      const index = this.blocks.length;
      this.blocks.push(current);
      this.openBlock(index, current);
    }

    current.text += fragment;
    const index = this.blocks.length - 1;
    this.emitStreamEvent({
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text: fragment },
    });
  }

  private appendThinking(subject?: string, description?: string): void {
    const fragment = [subject?.trim(), description?.trim()]
      .filter((value) => value && value.length > 0)
      .join(': ');
    if (!fragment) {
      return;
    }

    this.ensureBlockTypeConsistency('thinking');
    this.ensureMessageStarted();

    let current = this.blocks[this.blocks.length - 1];
    if (!current || current.type !== 'thinking') {
      current = {
        type: 'thinking',
        thinking: '',
        signature: subject,
      } satisfies ThinkingBlock;
      const index = this.blocks.length;
      this.blocks.push(current);
      this.openBlock(index, current);
    }

    current.thinking = `${current.thinking ?? ''}${fragment}`;
    const index = this.blocks.length - 1;
    this.emitStreamEvent({
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking: fragment },
    });
  }

  private appendToolUse(request: ToolCallRequestInfo): void {
    this.ensureBlockTypeConsistency('tool_use');
    this.ensureMessageStarted();
    this.finalizePendingBlocks();

    const index = this.blocks.length;
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: request.callId,
      name: request.name,
      input: request.args,
    };
    this.blocks.push(block);
    this.openBlock(index, block);
    this.emitStreamEvent({
      type: 'content_block_delta',
      index,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(request.args ?? {}),
      },
    });
    this.closeBlock(index);
  }

  private ensureMessageStarted(): void {
    if (this.messageStarted) {
      return;
    }
    this.messageStarted = true;
    this.emitStreamEvent({
      type: 'message_start',
      message: {
        id: this.messageId!,
        role: 'assistant',
        model: this.config.getModel(),
      },
    });
  }

  private finalizePendingBlocks(): void {
    const lastBlock = this.blocks[this.blocks.length - 1];
    if (!lastBlock) {
      return;
    }

    if (lastBlock.type === 'text') {
      const index = this.blocks.length - 1;
      this.closeBlock(index);
    } else if (lastBlock.type === 'thinking') {
      const index = this.blocks.length - 1;
      this.closeBlock(index);
    }
  }

  private openBlock(index: number, block: ContentBlock): void {
    this.openBlocks.add(index);
    this.emitStreamEvent({
      type: 'content_block_start',
      index,
      content_block: block,
    });
  }

  private closeBlock(index: number): void {
    if (!this.openBlocks.has(index)) {
      return;
    }
    this.openBlocks.delete(index);
    this.emitStreamEvent({
      type: 'content_block_stop',
      index,
    });
  }

  private emitStreamEvent(event: StreamEvent): void {
    if (!this.includePartialMessages) {
      return;
    }
    const enrichedEvent = this.messageStarted
      ? ({ ...event, message_id: this.messageId } as StreamEvent & {
          message_id: string;
        })
      : event;
    const partial: CLIPartialAssistantMessage = {
      type: 'stream_event',
      uuid: randomUUID(),
      session_id: this.config.getSessionId(),
      parent_tool_use_id: null,
      event: enrichedEvent,
    };
    this.emitMessage(partial);
  }

  startAssistantMessage(): void {
    // Reset state for new message
    this.messageId = randomUUID();
    this.blocks = [];
    this.openBlocks = new Set<number>();
    this.usage = this.createUsage();
    this.messageStarted = false;
    this.finalized = false;
    this.currentBlockType = null;
  }

  processEvent(event: ServerGeminiStreamEvent): void {
    if (this.finalized) {
      return;
    }

    switch (event.type) {
      case GeminiEventType.Content:
        this.appendText(event.value);
        break;
      case GeminiEventType.Citation:
        if (typeof event.value === 'string') {
          this.appendText(`\n${event.value}`);
        }
        break;
      case GeminiEventType.Thought:
        this.appendThinking(event.value.subject, event.value.description);
        break;
      case GeminiEventType.ToolCallRequest:
        this.appendToolUse(event.value);
        break;
      case GeminiEventType.Finished:
        if (event.value?.usageMetadata) {
          this.usage = this.createUsage(event.value.usageMetadata);
        }
        this.finalizePendingBlocks();
        break;
      default:
        break;
    }
  }

  finalizeAssistantMessage(): CLIAssistantMessage {
    if (this.finalized) {
      return this.buildMessage();
    }
    this.finalized = true;

    this.finalizePendingBlocks();
    const orderedOpenBlocks = Array.from(this.openBlocks).sort((a, b) => a - b);
    for (const index of orderedOpenBlocks) {
      this.closeBlock(index);
    }

    if (this.messageStarted && this.includePartialMessages) {
      this.emitStreamEvent({ type: 'message_stop' });
    }

    const message = this.buildMessage();
    this.lastAssistantMessage = message;
    this.emitMessage(message);
    return message;
  }

  emitResult(options: ResultOptions): void {
    const baseUuid = randomUUID();
    const baseSessionId = this.getSessionId();
    const usage = options.usage ?? createExtendedUsage();
    const resultText =
      options.summary ??
      (this.lastAssistantMessage
        ? extractTextFromBlocks(this.lastAssistantMessage.message.content)
        : '');

    let message: CLIResultMessage;
    if (options.isError) {
      const errorMessage = options.errorMessage ?? 'Unknown error';
      const errorResult: CLIResultMessageError = {
        type: 'result',
        subtype:
          (options.subtype as CLIResultMessageError['subtype']) ??
          'error_during_execution',
        uuid: baseUuid,
        session_id: baseSessionId,
        is_error: true,
        duration_ms: options.durationMs,
        duration_api_ms: options.apiDurationMs,
        num_turns: options.numTurns,
        total_cost_usd: options.totalCostUsd ?? 0,
        usage,
        permission_denials: [],
        error: { message: errorMessage },
      };
      message = errorResult;
    } else {
      const success: CLIResultMessageSuccess = {
        type: 'result',
        subtype:
          (options.subtype as CLIResultMessageSuccess['subtype']) ?? 'success',
        uuid: baseUuid,
        session_id: baseSessionId,
        is_error: false,
        duration_ms: options.durationMs,
        duration_api_ms: options.apiDurationMs,
        num_turns: options.numTurns,
        result: resultText,
        total_cost_usd: options.totalCostUsd ?? 0,
        usage,
        permission_denials: [],
      };
      message = success;
    }

    this.emitMessage(message);
  }

  emitMessage(message: unknown): void {
    // Track assistant messages for result generation
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'assistant'
    ) {
      this.lastAssistantMessage = message as CLIAssistantMessage;
    }

    // Emit messages immediately in stream mode
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  emitUserMessage(parts: Part[], parentToolUseId: string | null = null): void {
    const content = partsToString(parts);
    const message: CLIUserMessage = {
      type: 'user',
      uuid: randomUUID(),
      session_id: this.getSessionId(),
      parent_tool_use_id: parentToolUseId,
      message: {
        role: 'user',
        content,
      },
    };
    this.emitMessage(message);
  }

  emitToolResult(
    request: ToolCallRequestInfo,
    response: ToolCallResponseInfo,
  ): void {
    const block: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: request.callId,
      is_error: Boolean(response.error),
    };
    const content = toolResultContent(response);
    if (content !== undefined) {
      block.content = content;
    }

    const message: CLIUserMessage = {
      type: 'user',
      uuid: randomUUID(),
      session_id: this.getSessionId(),
      parent_tool_use_id: request.callId,
      message: {
        role: 'user',
        content: [block],
      },
    };
    this.emitMessage(message);
  }

  emitSystemMessage(subtype: string, data?: unknown): void {
    const systemMessage = {
      type: 'system',
      subtype,
      uuid: randomUUID(),
      session_id: this.getSessionId(),
      data,
    } as const;
    this.emitMessage(systemMessage);
  }

  getSessionId(): string {
    return this.config.getSessionId();
  }

  getModel(): string {
    return this.config.getModel();
  }

  // Legacy methods for backward compatibility
  send(message: unknown): void {
    this.emitMessage(message);
  }

  /**
   * Keeps the assistant message scoped to a single content block type.
   * If the requested block type differs from the current message type,
   * the existing message is finalized and a fresh assistant message is started
   * so that every emitted assistant message contains exactly one block category.
   */
  private ensureBlockTypeConsistency(targetType: ContentBlock['type']): void {
    if (this.currentBlockType === targetType) {
      return;
    }

    if (this.currentBlockType === null) {
      this.currentBlockType = targetType;
      return;
    }

    this.finalizeAssistantMessage();
    this.startAssistantMessage();
    this.currentBlockType = targetType;
  }
}

function partsToString(parts: Part[]): string {
  return parts
    .map((part) => {
      if ('text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return JSON.stringify(part);
    })
    .join('');
}

function toolResultContent(response: ToolCallResponseInfo): string | undefined {
  if (
    typeof response.resultDisplay === 'string' &&
    response.resultDisplay.trim().length > 0
  ) {
    return response.resultDisplay;
  }
  if (response.responseParts && response.responseParts.length > 0) {
    return partsToString(response.responseParts);
  }
  if (response.error) {
    return response.error.message;
  }
  return undefined;
}

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

function createExtendedUsage(): ExtendedUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}
