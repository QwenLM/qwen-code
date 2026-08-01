/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseEmitter } from './base-emitter.js';
import type { TodoPlanSnapshot } from '../types.js';
import {
  createTranscriptPlanUpdate,
  extractTranscriptTodoPlan,
} from '@qwen-code/acp-bridge/transcriptReplay';

/**
 * Handles emission of plan/todo updates.
 *
 * This emitter is responsible for converting todo items to ACP plan entries
 * and sending plan updates to the client. It also provides utilities for
 * extracting todos from various sources (tool result displays, args, etc.).
 */
export class PlanEmitter extends BaseEmitter {
  /**
   * Emits a plan update with the given todo items.
   *
   * @param plan - Plan identity and todo items to send as plan entries
   */
  async emitPlan(plan: TodoPlanSnapshot, sourceCallId?: string): Promise<void> {
    // Snapshot the running cumulative usage as a per-snapshot baseline. The
    // web-shell diffs consecutive snapshots to attribute tokens/API time to the
    // task that ran between two todo updates. Copied so later accumulation
    // doesn't mutate this snapshot.
    //
    // ORDERING INVARIANT: the turn's usage must have been folded into
    // cumulativeUsage (MessageEmitter.emitUsageMetadata) before this snapshot —
    // emitting a plan ahead of its turn's usage would record a stale baseline
    // and zero out that task's stats.
    const cumulative = this.ctx.cumulativeUsage;
    await this.sendUpdate(
      createTranscriptPlanUpdate(plan.todos, cumulative, {
        planToolCallId: sourceCallId,
        todoPlanId: plan.planId,
      }),
    );
  }

  /**
   * Extracts todos from tool result display or args.
   * Tries multiple sources in priority order:
   * 1. Result display object with type 'todo_list'
   * 2. Result display as JSON string
   * 3. Args with 'todos' array when no result display is available
   *
   * @param resultDisplay - The tool result display (object, string, or undefined)
   * @param args - The tool call arguments (fallback source)
   * @returns Plan snapshot if found, null otherwise
   */
  extractPlan(
    resultDisplay: unknown,
    args?: Record<string, unknown>,
  ): TodoPlanSnapshot | null {
    const plan = extractTranscriptTodoPlan(resultDisplay, args);
    if (!plan) return null;
    return {
      ...(plan.planId ? { planId: plan.planId } : {}),
      todos: plan.todos.map((todo, index) => ({
        id: todo.id ?? String(index),
        content: todo.content,
        status: todo.status,
        ...(todo.blockedBy ? { blockedBy: [...todo.blockedBy] } : {}),
      })),
    };
  }
}
