/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '@qwen-code/qwen-code-core';
import type {
  CLIAssistantMessage,
  CLIMessage,
  CLIPartialAssistantMessage,
  ControlMessage,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
} from '../types.js';
import {
  BaseJsonOutputAdapter,
  type MessageState,
  type ResultOptions,
  type JsonOutputAdapterInterface,
} from './BaseJsonOutputAdapter.js';

/**
 * Stream JSON output adapter that emits messages immediately
 * as they are completed during the streaming process.
 * Supports both main agent and subagent messages through distinct APIs.
 */
export class StreamJsonOutputAdapter
  extends BaseJsonOutputAdapter
  implements JsonOutputAdapterInterface
{
  constructor(
    config: Config,
    private readonly includePartialMessages: boolean,
  ) {
    super(config);
  }

  /**
   * Emits message immediately to stdout (stream mode).
   */
  protected emitMessageImpl(message: CLIMessage | ControlMessage): void {
    // Track assistant messages for result generation
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'assistant'
    ) {
      this.updateLastAssistantMessage(message as CLIAssistantMessage);
    }

    // Emit messages immediately in stream mode
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * Stream mode emits stream events when includePartialMessages is enabled.
   */
  protected shouldEmitStreamEvents(): boolean {
    return this.includePartialMessages;
  }

  finalizeAssistantMessage(): CLIAssistantMessage {
    const state = this.mainAgentMessageState;
    if (state.finalized) {
      return this.buildMessage(null);
    }
    state.finalized = true;

    this.finalizePendingBlocks(state, null);
    const orderedOpenBlocks = Array.from(state.openBlocks).sort(
      (a, b) => a - b,
    );
    for (const index of orderedOpenBlocks) {
      this.onBlockClosed(state, index, null);
      this.closeBlock(state, index);
    }

    if (state.messageStarted && this.includePartialMessages) {
      this.emitStreamEventIfEnabled({ type: 'message_stop' }, null);
    }

    const message = this.buildMessage(null);
    this.updateLastAssistantMessage(message);
    this.emitMessageImpl(message);
    return message;
  }

  emitResult(options: ResultOptions): void {
    const resultMessage = this.buildResultMessage(
      options,
      this.lastAssistantMessage,
    );
    this.emitMessageImpl(resultMessage);
  }

  emitMessage(message: CLIMessage | ControlMessage): void {
    // In stream mode, emit immediately
    this.emitMessageImpl(message);
  }

  send(message: CLIMessage | ControlMessage): void {
    this.emitMessage(message);
  }

  /**
   * Overrides base class hook to emit stream event when text block is created.
   */
  protected override onTextBlockCreated(
    state: MessageState,
    index: number,
    block: TextBlock,
    parentToolUseId: string | null,
  ): void {
    this.emitStreamEventIfEnabled(
      {
        type: 'content_block_start',
        index,
        content_block: block,
      },
      parentToolUseId,
    );
  }

  /**
   * Overrides base class hook to emit stream event when text is appended.
   */
  protected override onTextAppended(
    state: MessageState,
    index: number,
    fragment: string,
    parentToolUseId: string | null,
  ): void {
    this.emitStreamEventIfEnabled(
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: fragment },
      },
      parentToolUseId,
    );
  }

  /**
   * Overrides base class hook to emit stream event when thinking block is created.
   */
  protected override onThinkingBlockCreated(
    state: MessageState,
    index: number,
    block: ThinkingBlock,
    parentToolUseId: string | null,
  ): void {
    this.emitStreamEventIfEnabled(
      {
        type: 'content_block_start',
        index,
        content_block: block,
      },
      parentToolUseId,
    );
  }

  /**
   * Overrides base class hook to emit stream event when thinking is appended.
   */
  protected override onThinkingAppended(
    state: MessageState,
    index: number,
    fragment: string,
    parentToolUseId: string | null,
  ): void {
    this.emitStreamEventIfEnabled(
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: fragment },
      },
      parentToolUseId,
    );
  }

  /**
   * Overrides base class hook to emit stream event when tool_use block is created.
   */
  protected override onToolUseBlockCreated(
    state: MessageState,
    index: number,
    block: ToolUseBlock,
    parentToolUseId: string | null,
  ): void {
    this.emitStreamEventIfEnabled(
      {
        type: 'content_block_start',
        index,
        content_block: block,
      },
      parentToolUseId,
    );
  }

  /**
   * Overrides base class hook to emit stream event when tool_use input is set.
   */
  protected override onToolUseInputSet(
    state: MessageState,
    index: number,
    input: unknown,
    parentToolUseId: string | null,
  ): void {
    this.emitStreamEventIfEnabled(
      {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(input),
        },
      },
      parentToolUseId,
    );
  }

  /**
   * Overrides base class hook to emit stream event when block is closed.
   */
  protected override onBlockClosed(
    state: MessageState,
    index: number,
    parentToolUseId: string | null,
  ): void {
    if (this.includePartialMessages) {
      this.emitStreamEventIfEnabled(
        {
          type: 'content_block_stop',
          index,
        },
        parentToolUseId,
      );
    }
  }

  /**
   * Overrides base class hook to emit message_start event when message is started.
   * Only emits for main agent, not for subagents.
   */
  protected override onEnsureMessageStarted(
    state: MessageState,
    parentToolUseId: string | null,
  ): void {
    // Only emit message_start for main agent, not for subagents
    if (parentToolUseId === null) {
      this.emitStreamEventIfEnabled(
        {
          type: 'message_start',
          message: {
            id: state.messageId!,
            role: 'assistant',
            model: this.config.getModel(),
          },
        },
        null,
      );
    }
  }

  /**
   * Emits stream events when partial messages are enabled.
   * This is a private method specific to StreamJsonOutputAdapter.
   * @param event - Stream event to emit
   * @param parentToolUseId - null for main agent, string for subagent
   */
  private emitStreamEventIfEnabled(
    event: StreamEvent,
    parentToolUseId: string | null,
  ): void {
    if (!this.includePartialMessages) {
      return;
    }

    const state = this.getMessageState(parentToolUseId);
    const enrichedEvent = state.messageStarted
      ? ({ ...event, message_id: state.messageId } as StreamEvent & {
          message_id: string;
        })
      : event;

    const partial: CLIPartialAssistantMessage = {
      type: 'stream_event',
      uuid: randomUUID(),
      session_id: this.getSessionId(),
      parent_tool_use_id: parentToolUseId,
      event: enrichedEvent,
    };
    this.emitMessageImpl(partial);
  }
}
