/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import type { SubagentMeta } from '../types.js';
import {
  createTranscriptMessageUpdate,
  createTranscriptUsageUpdate,
} from '@qwen-code/acp-bridge/transcriptReplay';
import {
  getActiveGoal,
  type GoalTerminalEvent,
} from '@qwen-code/qwen-code-core';
import { BaseEmitter } from './base-emitter.js';
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
    options: { source?: string } = {},
  ): Promise<void> {
    await this.sendUpdate(
      createTranscriptMessageUpdate({
        role: 'user',
        text,
        timestamp,
        ...(options.source ? { extra: { source: options.source } } : {}),
      }),
    );
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
    await this.sendUpdate(
      createTranscriptMessageUpdate({
        role: 'assistant',
        thought: true,
        text,
        timestamp,
        ...(subagentMeta ? { extra: { ...subagentMeta } } : {}),
      }),
    );
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
    await this.sendUpdate(
      createTranscriptMessageUpdate({
        role: 'assistant',
        text,
        timestamp,
        ...(subagentMeta ? { extra: { ...subagentMeta } } : {}),
      }),
    );
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
    // ORDERING INVARIANT: this runs before PlanEmitter.emitPlan within a turn —
    // usage advances the cumulative accumulator, then the plan update snapshots
    // it. Reordering or batching emissions so a plan is sent before its turn's
    // usage would zero out that task's per-task stats.
    //
    // Only fold in finite values: a NaN/Infinity from a provider (or a NaN that
    // slips through `?? 0`, since `NaN ?? 0 === NaN`) would poison the running
    // total forever (`NaN + x === NaN`), so every later snapshot would fail
    // extractTodoStats's Number.isFinite check and silently show "not captured"
    // for the rest of the session. apiTimeMs only advances on the live path
    // (a per-turn duration is present), keeping API time live-only on replay.
    const cumulative = this.ctx.cumulativeUsage;
    if (cumulative) {
      const addFinite = (
        total: number,
        value: number | null | undefined,
      ): number =>
        typeof value === 'number' && Number.isFinite(value)
          ? total + value
          : total;
      cumulative.promptTokens = addFinite(
        cumulative.promptTokens,
        usageMetadata.promptTokenCount,
      );
      cumulative.candidateTokens = addFinite(
        cumulative.candidateTokens,
        usageMetadata.candidatesTokenCount,
      );
      cumulative.cachedTokens = addFinite(
        cumulative.cachedTokens,
        usageMetadata.cachedContentTokenCount,
      );
      cumulative.apiTimeMs = addFinite(cumulative.apiTimeMs, durationMs);
    }

    await this.sendUpdate(
      createTranscriptUsageUpdate(usageMetadata, {
        text,
        extra: {
          ...(typeof durationMs === 'number' ? { durationMs } : {}),
          ...subagentMeta,
        },
      }),
    );
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
}
