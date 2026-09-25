/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  HookEventName,
  DefaultHookOutput,
  PreToolUseHookOutput,
  PostToolUseHookOutput,
  PostToolUseFailureHookOutput,
  UserPromptExpansionHookOutput,
  PostToolBatchHookOutput,
  StopHookOutput,
  PermissionRequestHookOutput,
  isToolArtifactLike,
  isBlockingHookOutput,
} from './types.js';
import type { HookOutput, HookExecutionResult } from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('HOOK_AGGREGATOR');

const BLOCKING_REASON_FALLBACK = 'Hook exited with a blocking error';

const STOP_REQUEST_BLOCKS: ReadonlySet<HookEventName> = new Set([
  HookEventName.Stop,
  HookEventName.SubagentStop,
  HookEventName.PostToolBatch,
  HookEventName.PreToolUse,
]);

function isAskingForApproval(
  output: HookOutput,
  eventName: HookEventName,
): boolean {
  if (eventName !== HookEventName.PreToolUse) return false;
  return (
    output.hookSpecificOutput?.['permissionDecision'] === 'ask' ||
    output.decision === 'ask'
  );
}

function isStopRequestThatBlocks(
  output: HookOutput,
  eventName: HookEventName,
): boolean {
  if (output.continue !== false) return false;
  if (!STOP_REQUEST_BLOCKS.has(eventName)) return false;
  return !isAskingForApproval(output, eventName);
}

type DenyShapeFn = (output: HookOutput, reason: string) => HookOutput;

// The prompt lanes read a top-level deny decision only.
const denyDecision: DenyShapeFn = (output, reason) => ({
  ...output,
  decision: 'deny',
  reason,
});

// A blocking exit 2 has to land in the field the event's consumer reads, so
// every lane is either shaped or audited as decision-free (null). The record
// is total over HookEventName on purpose: a lane missing here fails to compile
// instead of silently failing open.
const DENY_SHAPE: Record<HookEventName, DenyShapeFn | null> = {
  PermissionRequest: (output, reason) => {
    const specific = { ...(output.hookSpecificOutput ?? {}) };
    const previous = specific['decision'];
    const decision =
      previous && typeof previous === 'object' && !Array.isArray(previous)
        ? { ...(previous as Record<string, unknown>) }
        : {};
    decision['behavior'] = 'deny';
    decision['message'] = reason;
    specific['decision'] = decision;
    return {
      ...output,
      decision: 'deny',
      reason,
      hookSpecificOutput: specific,
    };
  },
  PreToolUse: (output, reason) => {
    const specific = { ...(output.hookSpecificOutput ?? {}) };
    specific['permissionDecision'] = 'deny';
    specific['permissionDecisionReason'] = reason;
    return {
      ...output,
      decision: 'deny',
      reason,
      hookSpecificOutput: specific,
    };
  },
  TodoCreated: (output, reason) => ({ ...output, decision: 'block', reason }),
  TodoCompleted: (output, reason) => ({ ...output, decision: 'block', reason }),
  Stop: (output, reason) => ({
    ...output,
    continue: false,
    stopReason: reason,
  }),
  SubagentStop: (output, reason) => ({
    ...output,
    continue: false,
    stopReason: reason,
  }),
  PostToolBatch: (output, reason) => ({
    ...output,
    continue: false,
    stopReason: reason,
  }),
  UserPromptSubmit: denyDecision,
  UserPromptExpansion: denyDecision,
  PostToolUse: null,
  PostToolUseFailure: null,
  Notification: null,
  SessionStart: null,
  SessionEnd: null,
  SessionDelete: null,
  MessageDisplay: null,
  SubagentStart: null,
  PreCompact: null,
  PostCompact: null,
  PermissionDenied: null,
  StopFailure: null,
  InstructionsLoaded: null,
};

/**
 * Ranking for PreToolUse `hookSpecificOutput.permissionDecision` values.
 * Higher rank wins when multiple hooks match the same tool call, so a
 * `deny` can never be silently overridden by another hook's `allow`.
 */
const PERMISSION_DECISION_RANK: Record<'allow' | 'ask' | 'deny', number> = {
  allow: 1,
  ask: 2,
  deny: 3,
};

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
    // StopFailure special handling: fire-and-forget, ignore all outputs and errors
    if (eventName === HookEventName.StopFailure) {
      let totalDuration = 0;
      for (const result of results) {
        totalDuration += result.duration;
      }
      return {
        success: true, // Always return success
        allOutputs: [],
        errors: [], // Ignore errors
        totalDuration,
        finalOutput: undefined,
      };
    }

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
    let finalOutput = this.mergeOutputs(allOutputs, eventName);
    // A blocking outcome has to end in a decision the consumer acts on: a
    // payload with no decision, or with `allow`, runs the action, and `ask`
    // sends it to confirmation rather than the block the hook asked for.
    if (results.some((result) => result.outcome === 'blocking')) {
      finalOutput = this.enforceBlockingDeny(finalOutput, eventName);
    }

    return {
      success,
      allOutputs,
      errors,
      totalDuration,
      finalOutput,
    };
  }

  /**
   * Rewrite a blocking aggregation that carries no deny into one, in the
   * shape the event's consumers actually read.
   */
  private enforceBlockingDeny(
    output: HookOutput | undefined,
    eventName: HookEventName,
  ): HookOutput | undefined {
    if (!output) {
      const shape = DENY_SHAPE[eventName];
      return shape ? shape({}, BLOCKING_REASON_FALLBACK) : undefined;
    }
    if (isBlockingHookOutput(eventName, output)) {
      return output;
    }
    if (isStopRequestThatBlocks(output, eventName)) {
      return output;
    }
    const shape = DENY_SHAPE[eventName];
    if (!shape) return output;
    const reason =
      typeof output.reason === 'string' && output.reason
        ? output.reason
        : BLOCKING_REASON_FALLBACK;
    return shape(output, reason);
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
      case HookEventName.PostToolUseFailure:
      case HookEventName.PostToolBatch:
      case HookEventName.Stop:
      case HookEventName.UserPromptSubmit:
      case HookEventName.UserPromptExpansion:
      case HookEventName.SubagentStop:
      case HookEventName.TodoCreated:
      case HookEventName.TodoCompleted:
        merged = this.mergeWithOrLogic(outputs, eventName);
        break;
      case HookEventName.PermissionRequest:
        merged = this.mergePermissionRequestOutputs(outputs);
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
   * - For PostToolUse, decision and reason are required fields
   */
  private mergeWithOrLogic(
    outputs: HookOutput[],
    eventName?: HookEventName,
  ): HookOutput {
    const merged: HookOutput = {};
    const reasons: string[] = [];
    const additionalContexts: string[] = [];
    const artifacts: unknown[] = [];
    let hasBlock = false;
    let hasContinueFalse = false;
    let stopReason: string | undefined;
    const otherHookSpecificFields: Record<string, unknown> = {};
    const isPreToolUse = eventName === HookEventName.PreToolUse;
    let winningPermissionDecision: 'allow' | 'ask' | 'deny' | undefined;
    let winningPermissionRank = 0;
    const winningPermissionReasons: string[] = [];

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

      // Collect other hookSpecificOutput fields (later values win)
      if (output.hookSpecificOutput) {
        // PreToolUse permission decisions aggregate most-restrictive-first
        // (deny > ask > allow), independent of hook completion/config order.
        if (isPreToolUse) {
          const decision = output.hookSpecificOutput['permissionDecision'];
          if (
            decision === 'allow' ||
            decision === 'ask' ||
            decision === 'deny'
          ) {
            const rank = PERMISSION_DECISION_RANK[decision];
            if (rank > winningPermissionRank) {
              winningPermissionRank = rank;
              winningPermissionDecision = decision;
              winningPermissionReasons.length = 0;
            }
            if (rank === winningPermissionRank) {
              const reason =
                output.hookSpecificOutput['permissionDecisionReason'];
              if (typeof reason === 'string' && reason.length > 0) {
                winningPermissionReasons.push(reason);
              }
            }
          }
        }
        for (const [key, value] of Object.entries(output.hookSpecificOutput)) {
          if (key === 'artifacts' && Array.isArray(value)) {
            const validArtifacts = value.filter(isToolArtifactLike);
            artifacts.push(...validArtifacts);
            if (validArtifacts.length !== value.length) {
              debugLogger.warn(
                'Dropped malformed hookSpecificOutput.artifacts entries',
              );
            }
          } else if (key === 'artifacts') {
            debugLogger.warn(
              'Dropped malformed hookSpecificOutput.artifacts; expected array',
            );
          } else if (
            isPreToolUse &&
            (key === 'permissionDecision' || key === 'permissionDecisionReason')
          ) {
            // Handled by the ranking logic above, not last-wins.
          } else if (key !== 'additionalContext' && key !== 'artifacts') {
            otherHookSpecificFields[key] = value;
          }
        }
      }

      // Copy other fields (later values win for simple fields)
      if (output.suppressOutput !== undefined) {
        merged.suppressOutput = output.suppressOutput;
      }
      if (output.systemMessage !== undefined) {
        merged.systemMessage = output.systemMessage;
      }
    }

    // Concatenate terminal sequences from all outputs
    this.mergeTerminalSequences(outputs, merged);

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

    // Build hookSpecificOutput
    const hookSpecificOutput: Record<string, unknown> = {
      ...otherHookSpecificFields,
    };
    if (winningPermissionDecision !== undefined) {
      hookSpecificOutput['permissionDecision'] = winningPermissionDecision;
      if (winningPermissionReasons.length > 0) {
        hookSpecificOutput['permissionDecisionReason'] =
          winningPermissionReasons.join('\n');
      }
    }
    if (additionalContexts.length > 0) {
      hookSpecificOutput['additionalContext'] = additionalContexts.join('\n');
    }
    if (artifacts.length > 0) {
      hookSpecificOutput['artifacts'] = artifacts;
    }

    if (Object.keys(hookSpecificOutput).length > 0) {
      merged.hookSpecificOutput = hookSpecificOutput;
    }

    return merged;
  }

  /**
   * Merge outputs for mergePermissionRequestOutputs events.
   *
   * Rules:
   * - behavior: deny wins over allow (security priority)
   * - message: concatenated with newlines
   * - updatedInput: later values win
   * - updatedPermissions: concatenated
   * - interrupt: true wins over false
   */
  private mergePermissionRequestOutputs(outputs: HookOutput[]): HookOutput {
    const merged: HookOutput = {};
    const messages: string[] = [];
    let hasDeny = false;
    let hasAllow = false;
    let interrupt = false;
    let updatedInput: Record<string, unknown> | undefined;
    const allUpdatedPermissions: Array<{ type: string; tool?: string }> = [];

    for (const output of outputs) {
      const specific = output.hookSpecificOutput;
      if (!specific) continue;

      const decision = specific['decision'] as
        | {
            behavior?: string;
            message?: string;
            updatedInput?: Record<string, unknown>;
            updatedPermissions?: Array<{ type: string; tool?: string }>;
            interrupt?: boolean;
          }
        | undefined;

      if (!decision) continue;

      // Check behavior
      if (decision['behavior'] === 'deny') {
        hasDeny = true;
      } else if (decision['behavior'] === 'allow') {
        hasAllow = true;
      }

      // Collect message
      if (decision['message']) {
        messages.push(decision['message'] as string);
      }

      // Check interrupt - true wins
      if (decision['interrupt'] === true) {
        interrupt = true;
      }

      // Collect updatedInput - use last non-empty
      if (decision['updatedInput']) {
        updatedInput = decision['updatedInput'] as Record<string, unknown>;
      }

      // Collect updatedPermissions
      if (decision['updatedPermissions']) {
        allUpdatedPermissions.push(
          ...(decision['updatedPermissions'] as Array<{
            type: string;
            tool?: string;
          }>),
        );
      }

      // Copy other fields
      if (output.continue !== undefined) {
        merged.continue = output.continue;
      }
      if (output.reason !== undefined) {
        merged.reason = output.reason;
      }
    }

    // Build merged decision
    const mergedDecision: Record<string, unknown> = {};

    if (hasDeny) {
      mergedDecision['behavior'] = 'deny';
    } else if (hasAllow) {
      mergedDecision['behavior'] = 'allow';
    }

    if (messages.length > 0) {
      mergedDecision['message'] = messages.join('\n');
    }

    if (interrupt) {
      mergedDecision['interrupt'] = true;
    }

    if (updatedInput) {
      mergedDecision['updatedInput'] = updatedInput;
    }

    if (allUpdatedPermissions.length > 0) {
      mergedDecision['updatedPermissions'] = allUpdatedPermissions;
    }

    merged.hookSpecificOutput = {
      ...merged.hookSpecificOutput,
      decision: mergedDecision,
    };

    this.mergeTerminalSequences(outputs, merged);

    return merged;
  }

  /**
   * Simple merge for events without special logic
   */
  private mergeSimple(outputs: HookOutput[]): HookOutput {
    const additionalContexts: string[] = [];
    let merged: HookOutput = {};

    for (const output of outputs) {
      // Collect additionalContext for concatenation
      this.extractAdditionalContext(output, additionalContexts);
      // Exclude terminalSequence from spread — it is concatenated below
      const { terminalSequence: _ts, ...rest } = output;
      void _ts;
      merged = { ...merged, ...rest };
    }

    // Merge additionalContext with concatenation
    if (additionalContexts.length > 0) {
      merged.hookSpecificOutput = {
        ...merged.hookSpecificOutput,
        additionalContext: additionalContexts.join('\n'),
      };
    }

    // Concatenate all terminalSequence values
    this.mergeTerminalSequences(outputs, merged);

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
      case HookEventName.PostToolUseFailure:
        return new PostToolUseFailureHookOutput(output);
      case HookEventName.UserPromptExpansion:
        return new UserPromptExpansionHookOutput(output);
      case HookEventName.PostToolBatch:
        return new PostToolBatchHookOutput(output);
      case HookEventName.Stop:
      case HookEventName.SubagentStop:
        return new StopHookOutput(output);
      case HookEventName.PermissionRequest:
        return new PermissionRequestHookOutput(output);
      default:
        return new DefaultHookOutput(output);
    }
  }

  /**
   * Concatenate terminalSequence values from all outputs into merged.
   */
  private mergeTerminalSequences(
    outputs: HookOutput[],
    merged: HookOutput,
  ): void {
    const sequences = outputs
      .map((o) => o.terminalSequence)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (sequences.length > 0) {
      merged.terminalSequence = sequences.join('');
    } else {
      delete merged.terminalSequence;
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
