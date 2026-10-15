/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionCall, GenerateContentResponse } from '@google/genai';
import { getToolCallPreparations } from '@qwen-code/qwen-code-core';
import type { ToolCallEmitter } from './emitters/tool-call-emitter.js';

/**
 * Tracks preparations exposed to ACP before their complete function calls are
 * parsed. Each model stream gets its own instance so retries, fallbacks, and
 * cancellation cannot leak pending calls into a later attempt.
 */
export class ToolCallPreparationTracker {
  /** Contains only calls whose start frame was emitted successfully. */
  private readonly pending = new Map<string, string>();
  /** Contains calls whose start frame was intentionally suppressed. */
  private readonly suppressed = new Set<string>();
  /** Calls parsed completely but not yet handed to tool execution. */
  private readonly resolved = new Set<string>();
  private sawToolCall = false;

  constructor(private readonly emitter: ToolCallEmitter) {}

  /** Whether this response has started or produced any tool call. */
  get hasToolCall(): boolean {
    return this.sawToolCall;
  }

  /**
   * Emits at most one preparing frame per call ID before the full call arrives.
   */
  async observe(response: GenerateContentResponse): Promise<void> {
    const preparations = getToolCallPreparations(response);
    // Set before the first await, so no reader sees the response without a
    // tool call while its frame is being emitted.
    if (preparations.length > 0 || (response.functionCalls?.length ?? 0) > 0) {
      this.sawToolCall = true;
    }
    for (const preparation of preparations) {
      if (
        this.pending.has(preparation.callId) ||
        this.suppressed.has(preparation.callId)
      ) {
        continue;
      }

      const emitted = await this.emitter.emitStart({
        callId: preparation.callId,
        toolName: preparation.toolName,
        args: {},
        status: 'pending',
        phase: 'preparing',
      });
      if (emitted) {
        this.pending.set(preparation.callId, preparation.toolName);
      } else {
        this.suppressed.add(preparation.callId);
      }
    }
  }

  /** Resolves preparations once their complete function calls arrive. */
  resolve(functionCalls: readonly FunctionCall[]): void {
    for (const functionCall of functionCalls) {
      if (functionCall.id && this.pending.has(functionCall.id)) {
        this.resolved.add(functionCall.id);
      }
    }
  }

  /**
   * Terminates unresolved preparations. The map is cleared first so repeated
   * cleanup, including re-entry after an emission failure, cannot emit twice.
   */
  async discard(includeResolved = false): Promise<void> {
    // Discarding resolved calls abandons the whole attempt, tool calls and all.
    if (includeResolved) this.sawToolCall = false;
    const pending = [...this.pending.entries()];
    this.pending.clear();
    const resolved = new Set(this.resolved);
    this.resolved.clear();
    let firstError: unknown;
    let hasError = false;

    for (const [callId, toolName] of pending) {
      if (!includeResolved && resolved.has(callId)) continue;

      try {
        await this.emitter.emitPreparationDiscarded(callId, toolName);
      } catch (error) {
        // One failed ACP update must not prevent the remaining calls from being
        // finalized. Preserve the first failure and throw it after all attempts.
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
      }
    }

    if (hasError) {
      throw firstError;
    }
  }
}
