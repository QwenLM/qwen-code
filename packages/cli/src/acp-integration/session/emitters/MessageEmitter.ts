/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseEmitter } from './BaseEmitter.js';

/**
 * Handles emission of text message chunks (user, agent, thought).
 *
 * This emitter is responsible for sending message content to the ACP client
 * in a consistent format, regardless of whether the message comes from
 * normal flow, history replay, or other sources.
 */
export class MessageEmitter extends BaseEmitter {
  /**
   * Emits a user message chunk.
   */
  async emitUserMessage(text: string): Promise<void> {
    await this.sendUpdate({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
    });
  }

  /**
   * Emits an agent message chunk.
   */
  async emitAgentMessage(text: string): Promise<void> {
    await this.sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
  }

  /**
   * Emits an agent thought chunk.
   */
  async emitAgentThought(text: string): Promise<void> {
    await this.sendUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text },
    });
  }

  /**
   * Emits a message chunk based on role and thought flag.
   * This is the unified method that handles all message types.
   *
   * @param text - The message text content
   * @param role - Whether this is a user or assistant message
   * @param isThought - Whether this is an assistant thought (only applies to assistant role)
   */
  async emitMessage(
    text: string,
    role: 'user' | 'assistant',
    isThought: boolean = false,
  ): Promise<void> {
    if (role === 'user') {
      return this.emitUserMessage(text);
    }
    return isThought
      ? this.emitAgentThought(text)
      : this.emitAgentMessage(text);
  }
}
