/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import type { SubagentMeta } from '../types.js';
import type { Usage } from '@agentclientprotocol/sdk';
import {
  getActiveGoal,
  type GoalTerminalEvent,
} from '@qwen-code/qwen-code-core';
import { BaseEmitter } from './BaseEmitter.js';
import type { HistoryItemGoalStatus } from '../../../ui/types.js';

/**
 * Handles emission of text message chunks (user, agent, thought).
 *
 * This emitter is responsible for sending message content to the ACP client
 * in a consistent format, regardless of whether the message comes from
 * normal flow, history replay, or other sources.
 */
export class MessageEmitter extends BaseEmitter {
  /**
   * Emits a StopHookLoop event when Stop hooks create a loop.
   * This informs the client that Stop hooks have been executed multiple times.
   *
   * @param iterationCount - The current iteration count
   * @param reasons - Array of reasons from each Stop hook execution
   * @param stopHookCount - Number of Stop hooks that were executed
   */
  async emitStopHookLoop(
    iterationCount: number,
    reasons: string[],
    stopHookCount: number,
  ): Promise<void> {
    const activeGoal = getActiveGoal(this.sessionId);
    await this.sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: {
        stopHookLoop: {
          iterationCount,
          reasons,
          stopHookCount,
          ...(activeGoal
            ? {
                goal: {
                  condition: activeGoal.condition,
                  iterations: activeGoal.iterations,
                  setAt: activeGoal.setAt,
                  lastReason: activeGoal.lastReason,
                },
              }
            : {}),
        },
      },
    });
  }

  async emitGoalTerminal(event: GoalTerminalEvent): Promise<void> {
    await this.sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: {
        goalTerminal: event,
      },
    });
  }

  async emitGoalStatus(
    status: Omit<HistoryItemGoalStatus, 'id' | 'type'>,
  ): Promise<void> {
    await this.sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: {
        goalStatus: status,
      },
    });
  }

  /**
   * Emits a user message chunk.
   *
   * @param text - The user message text content
   * @param timestamp - Optional server-side timestamp (ISO string or ms) for message ordering
   */
  async emitUserMessage(
    text: string,
    timestamp?: string | number,
  ): Promise<void> {
    const epochMs = BaseEmitter.toEpochMs(timestamp);
    await this.sendUpdate({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
      ...(epochMs != null && { _meta: { timestamp: epochMs } }),
    });
  }

  /**
   * Emits an agent thought chunk.
   *
   * @param text - The thought text content
   * @param timestamp - Optional server-side timestamp (ISO string or ms) for message ordering
   */
  async emitAgentThought(
    text: string,
    timestamp?: string | number,
    subagentMeta?: SubagentMeta,
  ): Promise<void> {
    const _meta = this.buildChunkMeta(
      BaseEmitter.toEpochMs(timestamp),
      subagentMeta,
    );
    await this.sendUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text },
      ...(_meta ? { _meta } : {}),
    });
  }

  /**
   * Emits an agent message chunk.
   *
   * @param text - The agent message text content
   * @param timestamp - Optional server-side timestamp (ISO string or ms) for message ordering
   */
  async emitAgentMessage(
    text: string,
    timestamp?: string | number,
    subagentMeta?: SubagentMeta,
  ): Promise<void> {
    const _meta = this.buildChunkMeta(
      BaseEmitter.toEpochMs(timestamp),
      subagentMeta,
    );
    await this.sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      ...(_meta ? { _meta } : {}),
    });
  }

  /**
   * Emits usage metadata.
   */
  async emitUsageMetadata(
    usageMetadata: GenerateContentResponseUsageMetadata,
    text: string = '',
    durationMs?: number,
    subagentMeta?: SubagentMeta,
  ): Promise<void> {
    const usage: Usage = {
      inputTokens: usageMetadata.promptTokenCount ?? 0,
      outputTokens: usageMetadata.candidatesTokenCount ?? 0,
      totalTokens: usageMetadata.totalTokenCount ?? 0,
      thoughtTokens: usageMetadata.thoughtsTokenCount,
      cachedReadTokens: usageMetadata.cachedContentTokenCount,
    };

    const meta =
      typeof durationMs === 'number'
        ? { usage, durationMs, ...subagentMeta }
        : { usage, ...subagentMeta };

    await this.sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      _meta: meta,
    });
  }

  /**
   * Emits a message chunk based on role and thought flag.
   * This is the unified method that handles all message types.
   *
   * @param text - The message text content
   * @param role - Whether this is a user or assistant message
   * @param isThought - Whether this is an assistant thought (only applies to assistant role)
   * @param timestamp - Optional server-side timestamp (ISO string or ms) for message ordering
   */
  async emitMessage(
    text: string,
    role: 'user' | 'assistant',
    isThought: boolean = false,
    timestamp?: string | number,
    subagentMeta?: SubagentMeta,
  ): Promise<void> {
    if (role === 'user') {
      return this.emitUserMessage(text, timestamp);
    }
    return isThought
      ? this.emitAgentThought(text, timestamp, subagentMeta)
      : this.emitAgentMessage(text, timestamp, subagentMeta);
  }

  private buildChunkMeta(
    epochMs: number | undefined,
    subagentMeta?: SubagentMeta,
  ): Record<string, unknown> | undefined {
    const meta: Record<string, unknown> = {
      ...(subagentMeta?.parentToolCallId
        ? { parentToolCallId: subagentMeta.parentToolCallId }
        : {}),
      ...(subagentMeta?.subagentType
        ? { subagentType: subagentMeta.subagentType }
        : {}),
      ...(epochMs != null ? { timestamp: epochMs } : {}),
    };
    return Object.keys(meta).length > 0 ? meta : undefined;
  }
}
