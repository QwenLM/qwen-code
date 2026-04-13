/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { Config } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { MessageRewriteConfig } from './types.js';
import { TurnBuffer } from './TurnBuffer.js';
import { LlmRewriter } from './LlmRewriter.js';

const debugLogger = createDebugLogger('MESSAGE_REWRITE');

/**
 * Middleware that intercepts ACP messages and appends LLM-rewritten
 * versions with _meta.rewritten=true.
 *
 * Original messages are sent as-is (no modification).
 * At the end of each turn, a rewritten message is appended.
 *
 * Flow:
 *   1. Original chunks pass through unmodified
 *   2. Chunks are accumulated in TurnBuffer
 *   3. When a turn ends (tool_call starts, or session ends),
 *      LlmRewriter rewrites the accumulated content
 *   4. Rewritten text is emitted as agent_message_chunk with _meta.rewritten=true
 */
export class MessageRewriteMiddleware {
  private readonly turnBuffer: TurnBuffer;
  private readonly rewriter: LlmRewriter;
  private readonly target: MessageRewriteConfig['target'];
  private turnIndex = 0;

  constructor(
    config: Config,
    rewriteConfig: MessageRewriteConfig,
    private readonly sendUpdate: (update: SessionUpdate) => Promise<void>,
  ) {
    this.turnBuffer = new TurnBuffer();
    this.rewriter = new LlmRewriter(config, rewriteConfig);
    this.target = rewriteConfig.target;
  }

  /**
   * Intercept an ACP update. Original messages pass through,
   * thought/message chunks are also accumulated for turn-end rewriting.
   */
  async interceptUpdate(
    update: SessionUpdate,
    signal?: AbortSignal,
  ): Promise<void> {
    const updateRecord = update as Record<string, unknown>;
    const updateType = updateRecord['sessionUpdate'] as string;

    // tool_call signals turn boundary — flush before passing through
    if (updateType === 'tool_call') {
      await this.flushTurn(signal);
      this.turnBuffer.markToolCall();
      return this.sendUpdate(update);
    }

    // tool_call_update, plan, available_commands, etc. → pass through
    if (
      updateType !== 'agent_thought_chunk' &&
      updateType !== 'agent_message_chunk'
    ) {
      return this.sendUpdate(update);
    }

    const content = updateRecord['content'] as
      | Record<string, string>
      | undefined;
    const text = content?.['text'] ?? '';

    // Always send original message as-is
    await this.sendUpdate(update);

    // Accumulate for turn-end rewriting
    if (updateType === 'agent_thought_chunk') {
      if (this.target === 'thought' || this.target === 'both') {
        this.turnBuffer.appendThought(text);
      }
    } else if (updateType === 'agent_message_chunk') {
      if (this.target === 'message' || this.target === 'both') {
        this.turnBuffer.appendMessage(text);
      }
    }
  }

  /**
   * Flush the turn buffer: rewrite accumulated content and emit
   * a rewritten message with _meta.rewritten=true.
   *
   * Called when:
   * - A tool_call is about to be emitted (turn boundary)
   * - Usage metadata is emitted (end of model response)
   * - Session prompt ends
   */
  async flushTurn(signal?: AbortSignal): Promise<void> {
    const content = this.turnBuffer.flush();
    if (!content) return;

    this.turnIndex++;

    try {
      const rewritten = await this.rewriter.rewrite(content, signal);
      if (!rewritten) {
        debugLogger.info(`Turn ${this.turnIndex}: no rewrite output`);
        return;
      }

      debugLogger.info(
        `Turn ${this.turnIndex}: rewritten ${rewritten.length} chars`,
      );

      // Emit rewritten message with special _meta
      await this.sendUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: rewritten },
        _meta: {
          rewritten: true,
          turnIndex: this.turnIndex,
        },
      } as SessionUpdate);
    } catch (error) {
      debugLogger.warn(
        `Turn ${this.turnIndex}: rewrite failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // On failure, original messages already sent — just skip rewrite
    }
  }
}
