/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DefaultHookOutput,
  PreToolUseHookOutput,
  PostToolUseHookOutput,
  SubagentStopHookOutput,
  StopHookOutput,
  UserPromptSubmitHookOutput,
  ElicitationHookOutput,
  ElicitationResultHookOutput,
  PermissionRequestHookOutput,
  PermissionDeniedHookOutput,
  HookEventName,
  type HookDecision,
  type HookOutput,
  type HookExecutionResult,
} from './types.js';
import { runLogger } from '../utils/runLogger.js';
import type { HookAttachment } from '../attachments/types.js';

export interface AggregatedHookResult {
  success: boolean;
  /** True only when no synchronous or background hooks were dispatched. */
  hooksSkipped?: boolean;
  /** Number of hook processes that completed successfully. */
  successfulHookCount?: number;
  finalOutput?: DefaultHookOutput;
  allOutputs: HookOutput[];
  errors: Error[];
  totalDuration: number;
  /**
   * Prebuilt hook attachments produced by hookResultsToAttachments(). Call
   * sites push these into attachmentCtx.pendingHookAttachments so the
   * attachment pipeline can handle transcript rendering and provider
   * normalization consistently.
   */
  pendingAttachments?: HookAttachment[];
}

/** Sentinel returned when a hook fire-method fails unexpectedly. */
export const EMPTY_FAILED_HOOK_RESULT: AggregatedHookResult = Object.freeze({
  success: false,
  successfulHookCount: 0,
  allOutputs: [],
  errors: [],
  totalDuration: 0,
});

/** Sentinel returned when no hooks are registered or the hook system is disabled. */
export const EMPTY_SUCCESS_HOOK_RESULT: AggregatedHookResult = Object.freeze({
  success: true,
  hooksSkipped: true,
  successfulHookCount: 0,
  allOutputs: [],
  errors: [],
  totalDuration: 0,
});

/**
 * Build a deny result for PreToolUse fail-closed scenarios (system exceptions).
 * The finalOutput carries a 'deny' decision so that upstream evaluatePreToolUseHook
 * treats it as a blocking error.
 */
export function buildPreToolUseDenyResult(
  reason: string,
): AggregatedHookResult {
  const denyOutput = new PreToolUseHookOutput({ decision: 'deny', reason });
  return {
    success: false,
    successfulHookCount: 0,
    finalOutput: denyOutput,
    allOutputs: [{ decision: 'deny', reason }],
    errors: [new Error(reason)],
    totalDuration: 0,
  };
}

/**
 * Check if an aggregated hook result contains a blocking decision.
 * Used by ConfigChange callers to decide whether to apply or skip a change.
 */
export function hasBlockingResult(result: AggregatedHookResult): boolean {
  if (result.finalOutput?.isBlockingDecision()) {
    return true;
  }
  return result.allOutputs.some((o) =>
    new DefaultHookOutput(o).isBlockingDecision(),
  );
}

/**
 * Whether a hook execution should count as having done its job.
 *
 * `outcome` takes precedence over `success` (see `HookExecutionResult`): agent
 * hooks report `success: true` alongside a `cancelled` or `blocking` outcome, and
 * callers that own a resource must not read those as work completed.
 */
function countsAsSuccessfulHook(result: HookExecutionResult): boolean {
  return result.outcome ? result.outcome === 'success' : result.success;
}

/**
 * Hook aggregator that merges results from multiple hooks using event-specific strategies
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

    // Collect all outputs and errors
    for (const result of results) {
      totalDuration += result.duration;

      if (result.error) {
        errors.push(result.error);
      }

      if (result.output) {
        allOutputs.push(result.output);
      }
    }

    // Merge outputs using OR-decision strategy
    const mergedOutput =
      allOutputs.length > 0
        ? this.mergeWithOrDecision(allOutputs, eventName)
        : undefined;
    const finalOutput = mergedOutput
      ? this.createSpecificHookOutput(mergedOutput, eventName)
      : undefined;

    return {
      success: errors.length === 0,
      successfulHookCount: results.filter(countsAsSuccessfulHook).length,
      finalOutput,
      allOutputs,
      errors,
      totalDuration,
    };
  }

  /**
   * Merge outputs with OR decision logic and message concatenation
   */
  private mergeWithOrDecision(
    outputs: HookOutput[],
    eventName?: HookEventName,
  ): HookOutput {
    const merged: HookOutput = {
      continue: true,
      suppressOutput: false,
    };

    const messages: string[] = [];
    const reasons: string[] = [];
    const systemMessages: string[] = [];
    const stdoutContents: string[] = [];
    const additionalContexts: string[] = [];
    const modelInjections: string[] = [];

    let hasBlockDecision = false;

    for (const output of outputs) {
      if (output.continue === false) {
        merged.continue = false;
        if (output.stopReason) {
          messages.push(output.stopReason);
        }
      }

      // permissionDecision always overrides the top-level decision within the
      // same hook output, then participates in the cross-hook priority merge.
      // This only applies to PreToolUse events.
      let effectiveDecision: HookDecision = output.decision;
      if (eventName === HookEventName.PreToolUse && output.hookSpecificOutput) {
        const pd = output.hookSpecificOutput['permissionDecision'];
        if (pd === 'allow' || pd === 'deny' || pd === 'ask') {
          effectiveDecision = pd;
        }
      }

      // Decision priority: deny > ask > allow > undefined
      if (effectiveDecision === 'deny') {
        hasBlockDecision = true;
        merged.decision = 'deny';
        // Preserve attribution from the blocking hook
        merged.hookName = output.hookName;
        merged.hookCommand = output.hookCommand;
      } else if (effectiveDecision === 'ask') {
        // Ask decision is only set if no blocking decision was found so far
        if (!hasBlockDecision) {
          merged.decision = effectiveDecision;
        }
      } else if (effectiveDecision === 'allow') {
        // Weakest signal — does not override deny or ask.
        if (!merged.decision) {
          merged.decision = 'allow';
          merged.hookName = output.hookName;
          merged.hookCommand = output.hookCommand;
        }
      }

      if (output.reason) {
        reasons.push(output.reason);
      }

      if (output.modelInjection) {
        modelInjections.push(output.modelInjection);
      }

      // permissionDecisionReason supplements the reason when the top-level
      // decision field wasn't the source of the effective decision.
      // This fallback only applies to PreToolUse events.
      if (
        !output.reason &&
        eventName === HookEventName.PreToolUse &&
        effectiveDecision !== output.decision &&
        output.hookSpecificOutput
      ) {
        const pdr = output.hookSpecificOutput['permissionDecisionReason'];
        if (typeof pdr === 'string') {
          reasons.push(pdr);
        }
      }

      if (output.systemMessage) {
        if (output.suppressOutput) {
          // suppressOutput prevents systemMessage from reaching the UI feed.
          runLogger.debug(
            `Hook systemMessage suppressed (suppressOutput=true): ${output.systemMessage}`,
          );
        } else {
          systemMessages.push(output.systemMessage);
        }
      }

      // Collect stdoutContent (shell hook raw stdout)
      if (output.stdoutContent) {
        if (output.suppressOutput) {
          runLogger.debug(
            `Hook stdoutContent suppressed (suppressOutput=true): ${output.stdoutContent.slice(0, 100)}`,
          );
        } else {
          stdoutContents.push(output.stdoutContent);
        }
      }

      // suppressOutput: any true wins
      if (output.suppressOutput) {
        merged.suppressOutput = true;
      }

      // Handle clearContext (any true wins) - for SubagentStop hooks
      if (output.hookSpecificOutput?.['clearContext'] === true) {
        merged.hookSpecificOutput = {
          ...(merged.hookSpecificOutput || {}),
          clearContext: true,
        };
      }

      // Merge hookSpecificOutput (excluding clearContext which is handled above)
      if (output.hookSpecificOutput) {
        const { clearContext: _clearContext, ...restSpecificOutput } =
          output.hookSpecificOutput;
        merged.hookSpecificOutput = {
          ...(merged.hookSpecificOutput || {}),
          ...restSpecificOutput,
        };
      }

      // Collect additional context from hook-specific outputs
      this.extractAdditionalContext(output, additionalContexts);
    }

    // Strip permissionDecision from merged hookSpecificOutput — it was already
    // promoted to effectiveDecision during the priority merge above. Leaving it
    // would cause PreToolUseHookOutput's constructor to re-override the merged
    // top-level decision, breaking deny > allow priority.
    if (merged.hookSpecificOutput) {
      delete merged.hookSpecificOutput['permissionDecision'];
      delete merged.hookSpecificOutput['permissionDecisionReason'];
    }

    // Merge messages
    if (messages.length > 0) {
      merged.stopReason = messages.join('\n');
    }

    if (reasons.length > 0) {
      merged.reason = reasons.join('\n');
    }

    if (systemMessages.length > 0) {
      merged.systemMessage = systemMessages.join('\n');
    }

    if (stdoutContents.length > 0) {
      merged.stdoutContent = stdoutContents.join('\n');
    }

    if (modelInjections.length > 0) {
      merged.modelInjection = modelInjections.join('\n');
    }

    // Add merged additional context
    if (additionalContexts.length > 0) {
      merged.hookSpecificOutput = {
        ...(merged.hookSpecificOutput || {}),
        additionalContext: additionalContexts.join('\n'),
      };
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
      case HookEventName.PostToolUse:
        return new PostToolUseHookOutput(output);
      case HookEventName.SubagentStop:
        return new SubagentStopHookOutput(output);
      case HookEventName.Stop:
        return new StopHookOutput(output);
      case HookEventName.UserPromptSubmit:
        return new UserPromptSubmitHookOutput(output);
      case HookEventName.Elicitation:
        return new ElicitationHookOutput(output);
      case HookEventName.ElicitationResult:
        return new ElicitationResultHookOutput(output);
      case HookEventName.PermissionRequest:
        return new PermissionRequestHookOutput(output);
      case HookEventName.PermissionDenied:
        return new PermissionDeniedHookOutput(output);
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
      // eslint-disable-next-line eslint-js/no-restricted-syntax
      typeof specific['additionalContext'] === 'string'
    ) {
      contexts.push(specific['additionalContext']);
    }
  }
}
