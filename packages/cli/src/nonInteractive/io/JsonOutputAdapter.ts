/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type {
  Config,
  ServerGeminiStreamEvent,
  SessionMetrics,
  ToolCallRequestInfo,
  ToolCallResponseInfo,
} from '@qwen-code/qwen-code-core';
import { GeminiEventType } from '@qwen-code/qwen-code-core';
import type { Part, GenerateContentResponseUsageMetadata } from '@google/genai';
import type {
  CLIAssistantMessage,
  CLIResultMessage,
  CLIResultMessageError,
  CLIResultMessageSuccess,
  CLIUserMessage,
  ContentBlock,
  ExtendedUsage,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from '../types.js';

export interface ResultOptions {
  readonly isError: boolean;
  readonly errorMessage?: string;
  readonly durationMs: number;
  readonly apiDurationMs: number;
  readonly numTurns: number;
  readonly usage?: ExtendedUsage;
  readonly totalCostUsd?: number;
  readonly stats?: SessionMetrics;
  readonly summary?: string;
  readonly subtype?: string;
}

/**
 * Interface for message emission strategies.
 * Implementations decide whether to emit messages immediately (streaming)
 * or collect them for batch emission (non-streaming).
 */
export interface MessageEmitter {
  emitMessage(message: unknown): void;
  emitUserMessage(parts: Part[], parentToolUseId?: string | null): void;
  emitToolResult(
    request: ToolCallRequestInfo,
    response: ToolCallResponseInfo,
  ): void;
  emitSystemMessage(subtype: string, data?: unknown): void;
}

/**
 * JSON-focused output adapter interface.
 * Handles structured JSON output for both streaming and non-streaming modes.
 */
export interface JsonOutputAdapterInterface extends MessageEmitter {
  startAssistantMessage(): void;
  processEvent(event: ServerGeminiStreamEvent): void;
  finalizeAssistantMessage(): CLIAssistantMessage;
  emitResult(options: ResultOptions): void;
  getSessionId(): string;
  getModel(): string;
}

/**
 * JSON output adapter that collects all messages and emits them
 * as a single JSON array at the end of the turn.
 */
export class JsonOutputAdapter implements JsonOutputAdapterInterface {
  private readonly messages: unknown[] = [];

  // Assistant message building state
  private messageId: string | null = null;
  private blocks: ContentBlock[] = [];
  private openBlocks = new Set<number>();
  private usage: Usage = this.createUsage();
  private messageStarted = false;
  private finalized = false;
  private currentBlockType: ContentBlock['type'] | null = null;

  constructor(private readonly config: Config) {}

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
    // JSON mode doesn't emit partial messages, so we skip emitStreamEvent
  }

  private appendThinking(subject?: string, description?: string): void {
    this.ensureMessageStarted();

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
    // JSON mode doesn't emit partial messages, so we skip emitStreamEvent
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
    // JSON mode doesn't emit partial messages, so we skip emitStreamEvent
    this.closeBlock(index);
  }

  private ensureMessageStarted(): void {
    if (this.messageStarted) {
      return;
    }
    this.messageStarted = true;
    // JSON mode doesn't emit partial messages, so we skip emitStreamEvent
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

  private openBlock(index: number, _block: ContentBlock): void {
    this.openBlocks.add(index);
    // JSON mode doesn't emit partial messages, so we skip emitStreamEvent
  }

  private closeBlock(index: number): void {
    if (!this.openBlocks.has(index)) {
      return;
    }
    this.openBlocks.delete(index);
    // JSON mode doesn't emit partial messages, so we skip emitStreamEvent
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

    const message = this.buildMessage();
    this.emitMessage(message);
    return message;
  }

  emitResult(options: ResultOptions): void {
    const usage = options.usage ?? createExtendedUsage();
    const resultText = options.summary ?? this.extractResponseText();

    // Create the final result message to append to the messages array
    const baseUuid = randomUUID();
    const baseSessionId = this.getSessionId();

    let resultMessage: CLIResultMessage;
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
      resultMessage = errorResult;
    } else {
      const success: CLIResultMessageSuccess & { stats?: SessionMetrics } = {
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

      // Include stats if available
      if (options.stats) {
        success.stats = options.stats;
      }

      resultMessage = success;
    }

    // Add the result message to the messages array
    this.messages.push(resultMessage);

    // Emit the entire messages array as JSON
    const json = JSON.stringify(this.messages);
    process.stdout.write(`${json}\n`);
  }

  emitMessage(message: unknown): void {
    // Stash messages instead of emitting immediately
    this.messages.push(message);
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

  private extractResponseText(): string {
    const assistantMessages = this.messages.filter(
      (msg): msg is CLIAssistantMessage =>
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'assistant',
    );

    return assistantMessages
      .map((msg) => extractTextFromBlocks(msg.message.content))
      .filter((text) => text.length > 0)
      .join('\n');
  }

  /**
   * Guarantees that a single assistant message aggregates only one
   * content block category (text, thinking, or tool use). When a new
   * block type is requested, the current message is finalized and a fresh
   * assistant message is started to honour the single-type constraint.
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
