/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ToolCallRequestInfo } from '@qwen-code/qwen-code-core';
import type { CLIAssistantMessage, CLIMessage } from '../types.js';
import {
  BaseJsonOutputAdapter,
  type JsonOutputAdapterInterface,
  type ResultOptions,
} from './BaseJsonOutputAdapter.js';
import { observeHeadlessJsonToolResultWire } from '../tool-result-boundary-diagnostics.js';

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
  private attemptMessageCheckpoint = 0;
  private lastAssistantMessageAtAttemptStart: CLIAssistantMessage | null = null;

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

  override startAssistantMessage(): void {
    this.attemptMessageCheckpoint = this.messages.length;
    this.lastAssistantMessageAtAttemptStart = this.lastAssistantMessage;
    super.startAssistantMessage();
  }

  override restartAttempt(
    preserveText: boolean,
    discardedToolCalls: ToolCallRequestInfo[],
  ): void {
    if (preserveText) {
      const discardedIds = new Set(
        discardedToolCalls.map((request) => request.callId),
      );
      if (discardedIds.size > 0) {
        const retained = this.messages
          .slice(this.attemptMessageCheckpoint)
          .filter(
            (message) =>
              message.type !== 'assistant' ||
              !message.message.content.some(
                (block) =>
                  block.type === 'tool_use' && discardedIds.has(block.id),
              ),
          );
        this.messages.splice(
          this.attemptMessageCheckpoint,
          this.messages.length - this.attemptMessageCheckpoint,
          ...retained,
        );
        this.lastAssistantMessage =
          this.messages.findLast(
            (message): message is CLIAssistantMessage =>
              message.type === 'assistant',
          ) ?? this.lastAssistantMessageAtAttemptStart;
      }
    } else {
      // Keep system/control metadata (notably model_fallback), but retract
      // assistant messages produced by the abandoned provider attempt.
      const retained = this.messages
        .slice(this.attemptMessageCheckpoint)
        .filter((message) => message.type !== 'assistant');
      this.messages.splice(
        this.attemptMessageCheckpoint,
        this.messages.length - this.attemptMessageCheckpoint,
        ...retained,
      );
      this.lastAssistantMessage = this.lastAssistantMessageAtAttemptStart;
    }
    super.restartAttempt(preserveText, discardedToolCalls);
  }

  finalizeAssistantMessage(): CLIAssistantMessage {
    return this.finalizeAssistantMessageInternal(
      this.mainAgentMessageState,
      null,
    );
  }

  emitResult(options: ResultOptions): void {
    const resultMessage = this.buildResultMessage(
      options,
      this.lastAssistantMessage,
    );
    this.messages.push(resultMessage);

    if (this.config.getOutputFormat() === 'text') {
      if (resultMessage.is_error) {
        process.stderr.write(`${resultMessage.error?.message || ''}\n`);
      } else {
        process.stdout.write(`${resultMessage.result}\n`);
      }
    } else {
      // Emit the entire messages array as JSON (includes all main agent + subagent messages)
      const json = JSON.stringify(this.messages);
      const frame = `${json}\n`;
      observeHeadlessJsonToolResultWire(this.messages, frame);
      process.stdout.write(frame);
    }
  }

  emitMessage(message: CLIMessage): void {
    // In JSON mode, messages are collected in the messages array
    // This is called by the base class's finalizeAssistantMessageInternal
    // but can also be called directly for user/tool/system messages
    this.messages.push(message);
  }
}
