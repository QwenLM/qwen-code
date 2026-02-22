/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  HookEventName,
  DefaultHookOutput,
  PreToolUseHookOutput,
  StopHookOutput,
} from './types.js';
import type { HookOutput, HookExecutionResult } from './types.js';

/**
 * Aggregated result from multiple hook executions
 */
export interface AggregatedHookResult {
  success: boolean;
  allOutputs: HookOutput[];
  errors: Error[];
  totalDuration: number;
  finalOutput?: HookOutput;
}

/**
 * HookAggregator merges multiple hook outputs using event-specific rules.
 *
 * Different events have different merging strategies:
 * - PreToolUse/PostToolUse: OR logic for decisions, concatenation for messages
 */
export class HookAggregator {
  /**
   * Aggregate results from multiple hook executions
   */
  aggregateResults(
    results: HookExecutionResult[],
    eventName: HookEventName,
  ): AggregatedHookResult {
    const allOutputs: HookOutput[] = [];
    const errors: Error[] = [];
    let totalDuration = 0;

    for (const result of results) {
      totalDuration += result.duration;

      if (!result.success && result.error) {
        errors.push(result.error);
      }

      if (result.output) {
        allOutputs.push(result.output);
      }
    }

    const success = errors.length === 0;
    const finalOutput = this.mergeOutputs(allOutputs, eventName);

    return {
      success,
      allOutputs,
      errors,
      totalDuration,
      finalOutput,
    };
  }

  /**
   * Merge multiple hook outputs based on event type
   */
  private mergeOutputs(
    outputs: HookOutput[],
    eventName: HookEventName,
  ): HookOutput | undefined {
    if (outputs.length === 0) {
      return undefined;
    }

    if (outputs.length === 1) {
      return this.createSpecificHookOutput(outputs[0], eventName);
    }

    let merged: HookOutput;

    switch (eventName) {
      case HookEventName.PreToolUse:
      case HookEventName.PostToolUse:
        merged = this.mergeWithOrLogic(outputs);
        break;

      default:
        merged = this.mergeSimple(outputs);
    }

    return this.createSpecificHookOutput(merged, eventName);
  }

  /**
   * Merge outputs using OR logic for decisions and concatenation for messages.
   *
   * Rules:
   * - Any "block" or "deny" decision results in blocking (most restrictive wins)
   * - Reasons are concatenated with newlines
   * - continue=false takes precedence over continue=true
   * - Additional context is concatenated
   */
  private mergeWithOrLogic(outputs: HookOutput[]): HookOutput {
    const merged: HookOutput = {};
    const reasons: string[] = [];
    const additionalContexts: string[] = [];
    let hasBlock = false;
    let hasContinueFalse = false;
    let stopReason: string | undefined;

    for (const output of outputs) {
      // Check for blocking decisions
      if (output.decision === 'block' || output.decision === 'deny') {
        hasBlock = true;
      }

      // Collect reasons
      if (output.reason) {
        reasons.push(output.reason);
      }

      // Check continue flag
      if (output.continue === false) {
        hasContinueFalse = true;
        if (output.stopReason) {
          stopReason = output.stopReason;
        }
      }

      // Extract additional context
      this.extractAdditionalContext(output, additionalContexts);

      // Copy other fields (later values win for simple fields)
      if (output.suppressOutput !== undefined) {
        merged.suppressOutput = output.suppressOutput;
      }
      if (output.systemMessage !== undefined) {
        merged.systemMessage = output.systemMessage;
      }
    }

    // Set merged decision
    if (hasBlock) {
      merged.decision = 'block';
    } else if (outputs.some((o) => o.decision === 'allow')) {
      merged.decision = 'allow';
    }

    // Set merged reason
    if (reasons.length > 0) {
      merged.reason = reasons.join('\n');
    }

    // Set continue flag
    if (hasContinueFalse) {
      merged.continue = false;
      if (stopReason) {
        merged.stopReason = stopReason;
      }
    }

    // Set additional context if any
    if (additionalContexts.length > 0) {
      merged.hookSpecificOutput = {
        ...merged.hookSpecificOutput,
        additionalContext: additionalContexts.join('\n'),
      };
    }

    return merged;
  }

  /**
   * Simple merge for events without special logic
   */
  private mergeSimple(outputs: HookOutput[]): HookOutput {
    let merged: HookOutput = {};

    for (const output of outputs) {
      merged = { ...merged, ...output };
    }

    return merged;
  }

  /**
   * Create the appropriate specific hook output class based on event type
   */
  private createSpecificHookOutput(
    output: HookOutput,
    eventName: HookEventName,
  ): DefaultHookOutput {
    switch (eventName) {
      case HookEventName.PreToolUse:
        return new PreToolUseHookOutput(output);
      case HookEventName.Stop:
        return new StopHookOutput(output);
      default:
        return new DefaultHookOutput(output);
    }
  }

  /**
   * Extract additional context from hook-specific outputs
   */
  private extractAdditionalContext(
    output: HookOutput,
    contexts: string[],
  ): void {
    const specific = output.hookSpecificOutput;
    if (!specific) {
      return;
    }

    // Extract additionalContext from various hook types
    if (
      'additionalContext' in specific &&
      typeof specific['additionalContext'] === 'string'
    ) {
      contexts.push(specific['additionalContext']);
    }
  }
}
