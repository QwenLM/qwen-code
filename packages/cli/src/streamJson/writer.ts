/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type {
  Config,
  ToolCallRequestInfo,
  ToolCallResponseInfo,
} from '@qwen-code/qwen-code-core';
import type { Part } from '@google/genai';
import {
  type StreamJsonAssistantEnvelope,
  type StreamJsonContentBlock,
  type StreamJsonMessageStreamEvent,
  type StreamJsonOutputEnvelope,
  type StreamJsonStreamEventEnvelope,
  type StreamJsonUsage,
  type StreamJsonToolResultBlock,
} from './types.js';
import { writeStreamJsonEnvelope } from './io.js';

export interface StreamJsonResultOptions {
  readonly isError: boolean;
  readonly errorMessage?: string;
  readonly durationMs?: number;
  readonly apiDurationMs?: number;
  readonly numTurns: number;
  readonly usage?: StreamJsonUsage;
  readonly totalCostUsd?: number;
  readonly summary?: string;
  readonly subtype?: string;
}

export class StreamJsonWriter {
  private readonly includePartialMessages: boolean;
  private readonly sessionId: string;
  private readonly model: string;

  constructor(config: Config, includePartialMessages: boolean) {
    this.includePartialMessages = includePartialMessages;
    this.sessionId = config.getSessionId();
    this.model = config.getModel();
  }

  createAssistantBuilder(): StreamJsonAssistantMessageBuilder {
    return new StreamJsonAssistantMessageBuilder(
      this,
      this.includePartialMessages,
      this.sessionId,
      this.model,
    );
  }

  emitUserMessageFromParts(parts: Part[], parentToolUseId?: string): void {
    const envelope: StreamJsonOutputEnvelope = {
      type: 'user',
      message: {
        role: 'user',
        content: this.partsToString(parts),
      },
      parent_tool_use_id: parentToolUseId,
    };
    this.writeEnvelope(envelope);
  }

  emitToolResult(
    request: ToolCallRequestInfo,
    response: ToolCallResponseInfo,
  ): void {
    const block: StreamJsonToolResultBlock = {
      type: 'tool_result',
      tool_use_id: request.callId,
      is_error: Boolean(response.error),
    };
    const content = this.toolResultContent(response);
    if (content !== undefined) {
      block.content = content;
    }

    const envelope: StreamJsonOutputEnvelope = {
      type: 'user',
      message: {
        content: [block],
      },
      parent_tool_use_id: request.callId,
    };
    this.writeEnvelope(envelope);
  }

  emitResult(options: StreamJsonResultOptions): void {
    const envelope: StreamJsonOutputEnvelope = {
      type: 'result',
      subtype:
        options.subtype ?? (options.isError ? 'error' : 'session_summary'),
      is_error: options.isError,
      session_id: this.sessionId,
      num_turns: options.numTurns,
    };

    if (typeof options.durationMs === 'number') {
      envelope.duration_ms = options.durationMs;
    }
    if (typeof options.apiDurationMs === 'number') {
      envelope.duration_api_ms = options.apiDurationMs;
    }
    if (options.summary) {
      envelope.summary = options.summary;
    }
    if (options.usage) {
      envelope.usage = options.usage;
    }
    if (typeof options.totalCostUsd === 'number') {
      envelope.total_cost_usd = options.totalCostUsd;
    }
    if (options.errorMessage) {
      envelope.error = { message: options.errorMessage };
    }

    this.writeEnvelope(envelope);
  }

  emitSystemMessage(subtype: string, data?: unknown): void {
    const envelope: StreamJsonOutputEnvelope = {
      type: 'system',
      subtype,
      session_id: this.sessionId,
      data,
    };
    this.writeEnvelope(envelope);
  }

  emitStreamEvent(event: StreamJsonMessageStreamEvent): void {
    if (!this.includePartialMessages) {
      return;
    }
    const envelope: StreamJsonStreamEventEnvelope = {
      type: 'stream_event',
      uuid: randomUUID(),
      session_id: this.sessionId,
      event,
    };
    this.writeEnvelope(envelope);
  }

  writeEnvelope(envelope: StreamJsonOutputEnvelope): void {
    writeStreamJsonEnvelope(envelope);
  }

  private toolResultContent(
    response: ToolCallResponseInfo,
  ): string | undefined {
    if (typeof response.resultDisplay === 'string') {
      return response.resultDisplay;
    }
    if (response.responseParts && response.responseParts.length > 0) {
      return this.partsToString(response.responseParts);
    }
    if (response.error) {
      return response.error.message;
    }
    return undefined;
  }

  private partsToString(parts: Part[]): string {
    return parts
      .map((part) => {
        if ('text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .join('');
  }
}

class StreamJsonAssistantMessageBuilder {
  private readonly blocks: StreamJsonContentBlock[] = [];
  private readonly openBlocks = new Set<number>();
  private started = false;
  private finalized = false;
  private messageId: string | null = null;

  constructor(
    private readonly writer: StreamJsonWriter,
    private readonly includePartialMessages: boolean,
    private readonly sessionId: string,
    private readonly model: string,
  ) {}

  appendText(fragment: string): void {
    if (this.finalized) {
      return;
    }
    this.ensureMessageStarted();

    let currentBlock = this.blocks[this.blocks.length - 1];
    if (!currentBlock || currentBlock.type !== 'text') {
      currentBlock = { type: 'text', text: '' };
      const index = this.blocks.length;
      this.blocks.push(currentBlock);
      this.openBlock(index, currentBlock);
    }

    currentBlock.text += fragment;
    const index = this.blocks.length - 1;
    this.emitEvent({
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text: fragment },
    });
  }

  appendThinking(fragment: string): void {
    if (this.finalized) {
      return;
    }
    this.ensureMessageStarted();

    let currentBlock = this.blocks[this.blocks.length - 1];
    if (!currentBlock || currentBlock.type !== 'thinking') {
      currentBlock = { type: 'thinking', thinking: '' };
      const index = this.blocks.length;
      this.blocks.push(currentBlock);
      this.openBlock(index, currentBlock);
    }

    currentBlock.thinking = `${currentBlock.thinking ?? ''}${fragment}`;
    const index = this.blocks.length - 1;
    this.emitEvent({
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking: fragment },
    });
  }

  appendToolUse(request: ToolCallRequestInfo): void {
    if (this.finalized) {
      return;
    }
    this.ensureMessageStarted();
    const index = this.blocks.length;
    const block: StreamJsonContentBlock = {
      type: 'tool_use',
      id: request.callId,
      name: request.name,
      input: request.args,
    };
    this.blocks.push(block);
    this.openBlock(index, block);
    this.emitEvent({
      type: 'content_block_delta',
      index,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(request.args ?? {}),
      },
    });
    this.closeBlock(index);
  }

  finalize(): StreamJsonAssistantEnvelope {
    if (this.finalized) {
      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: this.model,
          content: this.blocks,
        },
      };
    }
    this.finalized = true;

    const orderedOpenBlocks = [...this.openBlocks].sort((a, b) => a - b);
    for (const index of orderedOpenBlocks) {
      this.closeBlock(index);
    }

    if (this.includePartialMessages && this.started) {
      this.emitEvent({
        type: 'message_stop',
        message: {
          type: 'assistant',
          role: 'assistant',
          model: this.model,
          session_id: this.sessionId,
          id: this.messageId ?? undefined,
        },
      });
    }

    const envelope: StreamJsonAssistantEnvelope = {
      type: 'assistant',
      message: {
        role: 'assistant',
        model: this.model,
        content: this.blocks,
      },
    };
    this.writer.writeEnvelope(envelope);
    return envelope;
  }

  private ensureMessageStarted(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    if (!this.messageId) {
      this.messageId = randomUUID();
    }
    this.emitEvent({
      type: 'message_start',
      message: {
        type: 'assistant',
        role: 'assistant',
        model: this.model,
        session_id: this.sessionId,
        id: this.messageId,
      },
    });
  }

  private openBlock(index: number, block: StreamJsonContentBlock): void {
    this.openBlocks.add(index);
    this.emitEvent({
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
    this.emitEvent({
      type: 'content_block_stop',
      index,
    });
  }

  private emitEvent(event: StreamJsonMessageStreamEvent): void {
    if (!this.includePartialMessages) {
      return;
    }
    const enriched = this.messageId
      ? { ...event, message_id: this.messageId }
      : event;
    this.writer.emitStreamEvent(enriched);
  }
}
