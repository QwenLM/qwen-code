/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type { CLIAssistantMessage, CLIMessage } from '../types.js';
import {
  BaseJsonOutputAdapter,
  type JsonOutputAdapterInterface,
  type ResultOptions,
} from './BaseJsonOutputAdapter.js';

/**
 * JSON output adapter that collects all messages and emits them
 * as a single JSON array at the end of the turn.
 * Supports both main agent and subagent messages through distinct APIs.
 */
export class JsonOutputAdapter
  extends BaseJsonOutputAdapter
  implements JsonOutputAdapterInterface
{
  private readonly messages: CLIMessage[] = [];

  constructor(config: Config) {
    super(config);
  }

  /**
   * Emits message to the messages array (batch mode).
   * Tracks the last assistant message for efficient result text extraction.
   */
  protected emitMessageImpl(message: CLIMessage): void {
    this.messages.push(message);
    // Track assistant messages for result generation
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'assistant'
    ) {
      this.updateLastAssistantMessage(message as CLIAssistantMessage);
    }
  }

  /**
   * JSON mode does not emit stream events.
   */
  protected shouldEmitStreamEvents(): boolean {
    return false;
  }

  finalizeAssistantMessage(): CLIAssistantMessage {
    const message = this.finalizeAssistantMessageInternal(
      this.mainAgentMessageState,
      null,
    );
    this.updateLastAssistantMessage(message);
    return message;
  }

  emitResult(options: ResultOptions): void {
    const resultMessage = this.buildResultMessage(
      options,
      this.lastAssistantMessage,
    );
    this.messages.push(resultMessage);

    // Emit the entire messages array as JSON (includes all main agent + subagent messages)
    const json = JSON.stringify(this.messages);
    process.stdout.write(`${json}\n`);
  }

  emitMessage(message: CLIMessage): void {
    // In JSON mode, messages are collected in the messages array
    // This is called by the base class's finalizeAssistantMessageInternal
    // but can also be called directly for user/tool/system messages
    this.messages.push(message);
  }
}
