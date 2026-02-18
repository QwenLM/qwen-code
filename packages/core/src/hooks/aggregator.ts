/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookExecutionResult, HookOutput, HookDecision } from './types.js';
import {
  HookEventName,
  DefaultHookOutput,
  PreToolUseHookOutput,
  createHookOutput,
} from './types.js';

// Type guard for outputs with getAdditionalContext method
function hasGetAdditionalContext(
  output: HookOutput,
): output is DefaultHookOutput {
  return output instanceof DefaultHookOutput;
}

/**
 * Aggregation result for multiple hook execution results
 */
export interface HookAggregationResult {
  /** Whether all hooks executed successfully */
  success: boolean;
  /** Aggregated output combining all hook outputs */
  output: HookOutput;
  /** Individual results from each hook */
  individualResults: HookExecutionResult[];
  /** Whether the aggregated decision is blocking */
  isBlocking: boolean;
  /** Reasons collected from all hooks */
  reasons: string[];
}

/**
 * Strategy for merging decisions from multiple hooks
 */
export type DecisionMergeStrategy =
  | 'block-priority' // Any block/deny results in block
  | 'allow-priority' // Any allow/approve results in allow
  | 'first-wins' // First non-undefined decision wins
  | 'last-wins'; // Last non-undefined decision wins

/**
 * Strategy for merging messages/context from multiple hooks
 */
export type MessageMergeStrategy =
  | 'concatenate' // Join with newlines
  | 'first-only' // Take first non-empty message
  | 'last-only'; // Take last non-empty message

/**
 * Configuration for hook aggregation
 */
export interface AggregationConfig {
  /** Strategy for merging decisions */
  decisionStrategy: DecisionMergeStrategy;
  /** Strategy for merging system messages */
  systemMessageStrategy: MessageMergeStrategy;
  /** Strategy for merging reasons */
  reasonStrategy: MessageMergeStrategy;
  /** Strategy for merging additional context */
  contextStrategy: MessageMergeStrategy;
  /** Whether to merge updated tool inputs (for PreToolUse/PermissionRequest) */
  mergeUpdatedInputs: boolean;
  /** Separator for concatenation strategies */
  separator: string;
}

/**
 * Default aggregation configuration
 */
export const DEFAULT_AGGREGATION_CONFIG: AggregationConfig = {
  decisionStrategy: 'block-priority',
  systemMessageStrategy: 'concatenate',
  reasonStrategy: 'concatenate',
  contextStrategy: 'concatenate',
  mergeUpdatedInputs: true,
  separator: '\n\n',
};

/**
 * Event-specific aggregation configurations
 */
export const EVENT_AGGREGATION_CONFIGS: Partial<
  Record<HookEventName, Partial<AggregationConfig>>
> = {
  [HookEventName.PreToolUse]: {
    decisionStrategy: 'block-priority',
    mergeUpdatedInputs: true,
  },
  [HookEventName.PermissionRequest]: {
    decisionStrategy: 'block-priority',
    mergeUpdatedInputs: true,
  },
  [HookEventName.PostToolUse]: {
    contextStrategy: 'concatenate',
  },
  [HookEventName.UserPromptSubmit]: {
    contextStrategy: 'concatenate',
  },
  [HookEventName.Stop]: {
    decisionStrategy: 'block-priority',
  },
  [HookEventName.SubagentStop]: {
    decisionStrategy: 'block-priority',
  },
};

/**
 * HookAggregator handles merging results from multiple hooks
 * executed for the same event.
 */
export class HookAggregator {
  private config: AggregationConfig;

  constructor(
    private eventName: HookEventName,
    config?: Partial<AggregationConfig>,
  ) {
    const eventConfig = EVENT_AGGREGATION_CONFIGS[eventName] || {};
    this.config = {
      ...DEFAULT_AGGREGATION_CONFIG,
      ...eventConfig,
      ...config,
    };
  }

  /**
   * Aggregate multiple hook execution results into a single result
   */
  aggregate(results: HookExecutionResult[]): HookAggregationResult {
    if (results.length === 0) {
      return {
        success: true,
        output: new DefaultHookOutput(),
        individualResults: [],
        isBlocking: false,
        reasons: [],
      };
    }

    if (results.length === 1) {
      const result = results[0];
      const output = result.output || new DefaultHookOutput();
      return {
        success: result.success,
        output,
        individualResults: results,
        isBlocking: this.isBlockingOutput(output),
        reasons: this.extractReasons(output),
      };
    }

    // Filter successful results with outputs
    const successfulResults = results.filter(
      (r): r is HookExecutionResult & { output: HookOutput } =>
        r.success && r.output !== undefined,
    );

    const outputs = successfulResults.map((r) => r.output);
    const aggregatedOutput = this.mergeOutputs(outputs);

    return {
      success: results.every((r) => r.success),
      output: aggregatedOutput,
      individualResults: results,
      isBlocking: this.isBlockingOutput(aggregatedOutput),
      reasons: this.extractAllReasons(outputs),
    };
  }

  /**
   * Merge multiple hook outputs into a single output
   */
  private mergeOutputs(outputs: HookOutput[]): HookOutput {
    if (outputs.length === 0) {
      return new DefaultHookOutput();
    }

    if (outputs.length === 1) {
      return outputs[0];
    }

    // Create appropriate output type based on event
    const mergedData: Partial<HookOutput> = {
      decision: this.mergeDecisions(outputs),
      reason: this.mergeReasons(outputs),
      systemMessage: this.mergeSystemMessages(outputs),
      continue: this.mergeContinue(outputs),
      suppressOutput: this.mergeSuppressOutput(outputs),
      stopReason: this.mergeStopReasons(outputs),
      hookSpecificOutput: this.mergeHookSpecificOutputs(outputs),
    };

    return createHookOutput(this.eventName, mergedData);
  }

  /**
   * Extract effective decision from an output, considering both
   * top-level decision field and hook-specific outputs
   */
  private extractEffectiveDecision(output: HookOutput): HookDecision {
    // First check top-level decision
    if (output.decision) {
      return output.decision;
    }

    // Check hook-specific outputs
    if (output.hookSpecificOutput) {
      // Check permissionDecision (PreToolUse style)
      if ('permissionDecision' in output.hookSpecificOutput) {
        const pd = output.hookSpecificOutput['permissionDecision'];
        if (pd === 'allow' || pd === 'deny' || pd === 'ask') {
          return pd === 'deny' ? 'block' : pd;
        }
      }

      // Check decision.behavior (PermissionRequest style)
      if ('decision' in output.hookSpecificOutput) {
        const decision = output.hookSpecificOutput['decision'] as Record<
          string,
          unknown
        >;
        if (decision?.['behavior'] === 'deny') {
          return 'block';
        }
        if (decision?.['behavior'] === 'allow') {
          return 'allow';
        }
      }
    }

    return undefined;
  }

  /**
   * Merge decisions from multiple outputs based on strategy
   *
   * Block-priority strategy (default):
   * - Any 'block' or 'deny' → 'block'
   * - Any 'ask' → 'ask'
   * - All 'allow' or 'approve' → 'allow'
   */
  private mergeDecisions(outputs: HookOutput[]): HookDecision {
    const decisions = outputs
      .map((o) => this.extractEffectiveDecision(o))
      .filter((d): d is Exclude<HookDecision, undefined> => d !== undefined);

    if (decisions.length === 0) {
      return undefined;
    }

    switch (this.config.decisionStrategy) {
      case 'block-priority':
        return this.mergeDecisionsBlockPriority(decisions);
      case 'allow-priority':
        return this.mergeDecisionsAllowPriority(decisions);
      case 'first-wins':
        return decisions[0];
      case 'last-wins':
        return decisions[decisions.length - 1];
      default:
        return this.mergeDecisionsBlockPriority(decisions);
    }
  }

  /**
   * Block-priority decision merge: any block/deny results in block
   */
  private mergeDecisionsBlockPriority(
    decisions: Array<Exclude<HookDecision, undefined>>,
  ): HookDecision {
    // Check for blocking decisions first
    if (decisions.some((d) => d === 'block' || d === 'deny')) {
      return 'block';
    }

    // Check for ask decisions
    if (decisions.some((d) => d === 'ask')) {
      return 'ask';
    }

    // All remaining are allow/approve
    if (decisions.every((d) => d === 'allow' || d === 'approve')) {
      return 'allow';
    }

    return undefined;
  }

  /**
   * Allow-priority decision merge: any allow/approve results in allow
   */
  private mergeDecisionsAllowPriority(
    decisions: Array<Exclude<HookDecision, undefined>>,
  ): HookDecision {
    if (decisions.some((d) => d === 'allow' || d === 'approve')) {
      return 'allow';
    }

    if (decisions.some((d) => d === 'ask')) {
      return 'ask';
    }

    if (decisions.some((d) => d === 'block' || d === 'deny')) {
      return 'block';
    }

    return undefined;
  }

  /**
   * Merge reasons from multiple outputs
   */
  private mergeReasons(outputs: HookOutput[]): string | undefined {
    const reasons = this.extractAllReasons(outputs);
    return this.mergeStrings(reasons, this.config.reasonStrategy);
  }

  /**
   * Merge system messages from multiple outputs
   */
  private mergeSystemMessages(outputs: HookOutput[]): string | undefined {
    const messages = outputs
      .map((o) => o.systemMessage)
      .filter((m): m is string => m !== undefined && m.length > 0);

    return this.mergeStrings(messages, this.config.systemMessageStrategy);
  }

  /**
   * Merge strings based on strategy
   */
  private mergeStrings(
    strings: string[],
    strategy: MessageMergeStrategy,
  ): string | undefined {
    if (strings.length === 0) {
      return undefined;
    }

    switch (strategy) {
      case 'concatenate':
        return strings.join(this.config.separator);
      case 'first-only':
        return strings[0];
      case 'last-only':
        return strings[strings.length - 1];
      default:
        return strings.join(this.config.separator);
    }
  }

  /**
   * Merge continue flags - if any wants to stop (continue=false), respect it
   */
  private mergeContinue(outputs: HookOutput[]): boolean | undefined {
    const continues = outputs
      .map((o) => o.continue)
      .filter((c): c is boolean => c !== undefined);

    if (continues.length === 0) {
      return undefined;
    }

    // If any hook says continue=false, we stop
    return continues.every((c) => c === true);
  }

  /**
   * Merge suppressOutput flags - if any wants to suppress, respect it
   */
  private mergeSuppressOutput(outputs: HookOutput[]): boolean | undefined {
    const suppresses = outputs
      .map((o) => o.suppressOutput)
      .filter((s): s is boolean => s !== undefined);

    if (suppresses.length === 0) {
      return undefined;
    }

    // If any hook wants to suppress, we suppress
    return suppresses.some((s) => s === true);
  }

  /**
   * Merge stop reasons from multiple outputs
   */
  private mergeStopReasons(outputs: HookOutput[]): string | undefined {
    const reasons = outputs
      .map((o) => o.stopReason)
      .filter((r): r is string => r !== undefined && r.length > 0);

    return this.mergeStrings(reasons, this.config.reasonStrategy);
  }

  /**
   * Merge hook-specific outputs (updatedInput, additionalContext, etc.)
   */
  private mergeHookSpecificOutputs(
    outputs: HookOutput[],
  ): Record<string, unknown> | undefined {
    if (outputs.length === 0) {
      return undefined;
    }

    const merged: Record<string, unknown> = {};
    const shouldMergeUpdatedInput =
      this.config.mergeUpdatedInputs && this.shouldMergeUpdatedInputs();

    for (const output of outputs) {
      if (output.hookSpecificOutput) {
        // Copy all fields except updatedInput (which is handled separately if needed)
        for (const [key, value] of Object.entries(output.hookSpecificOutput)) {
          if (key !== 'updatedInput' || shouldMergeUpdatedInput) {
            merged[key] = value;
          }
        }
      }
    }

    // Handle special merging for updatedInput
    if (shouldMergeUpdatedInput) {
      const updatedInputs = outputs
        .map((o) => {
          if (o instanceof PreToolUseHookOutput) {
            return o.getUpdatedToolInput();
          }
          // Check hookSpecificOutput for updatedInput
          if (o.hookSpecificOutput) {
            // PreToolUse style
            if ('updatedInput' in o.hookSpecificOutput) {
              return o.hookSpecificOutput['updatedInput'] as Record<
                string,
                unknown
              >;
            }
            // PermissionRequest style
            if ('decision' in o.hookSpecificOutput) {
              const decision = o.hookSpecificOutput['decision'] as Record<
                string,
                unknown
              >;
              if (decision?.['updatedInput']) {
                return decision['updatedInput'] as Record<string, unknown>;
              }
            }
          }
          return undefined;
        })
        .filter((i): i is Record<string, unknown> => i !== undefined);

      if (updatedInputs.length > 0) {
        // Deep merge all updated inputs
        merged['updatedInput'] = this.deepMergeObjects(updatedInputs);
      }
    }

    // Handle additionalContext merging
    const contexts = outputs
      .map((o) =>
        hasGetAdditionalContext(o) ? o.getAdditionalContext() : undefined,
      )
      .filter((c): c is string => c !== undefined && c.length > 0);

    if (contexts.length > 0) {
      const mergedContext = this.mergeStrings(
        contexts,
        this.config.contextStrategy,
      );
      if (mergedContext) {
        merged['additionalContext'] = mergedContext;
      }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Check if we should merge updated inputs for this event type
   */
  private shouldMergeUpdatedInputs(): boolean {
    return (
      this.eventName === HookEventName.PreToolUse ||
      this.eventName === HookEventName.PermissionRequest
    );
  }

  /**
   * Deep merge multiple objects
   */
  private deepMergeObjects(
    objects: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const obj of objects) {
      for (const [key, value] of Object.entries(obj)) {
        if (
          key in result &&
          typeof result[key] === 'object' &&
          result[key] !== null &&
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value)
        ) {
          // Deep merge nested objects
          result[key] = this.deepMergeObjects([
            result[key] as Record<string, unknown>,
            value as Record<string, unknown>,
          ]);
        } else {
          // Last value wins for non-objects
          result[key] = value;
        }
      }
    }

    return result;
  }

  /**
   * Check if an output represents a blocking decision
   */
  private isBlockingOutput(output: HookOutput): boolean {
    if (output.decision === 'block' || output.decision === 'deny') {
      return true;
    }

    // Check hook-specific outputs for blocking decisions
    if (output.hookSpecificOutput) {
      // Check permissionDecision (PreToolUse style)
      if (
        'permissionDecision' in output.hookSpecificOutput &&
        (output.hookSpecificOutput['permissionDecision'] === 'block' ||
          output.hookSpecificOutput['permissionDecision'] === 'deny')
      ) {
        return true;
      }

      // Check decision.behavior (PermissionRequest style)
      if ('decision' in output.hookSpecificOutput) {
        const decision = output.hookSpecificOutput['decision'] as Record<
          string,
          unknown
        >;
        if (decision?.['behavior'] === 'deny') {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Extract reasons from a single output
   */
  private extractReasons(output: HookOutput): string[] {
    const reasons: string[] = [];

    if (output.reason) {
      reasons.push(output.reason);
    }

    if (output.stopReason) {
      reasons.push(output.stopReason);
    }

    // Check hook-specific outputs
    if (output.hookSpecificOutput) {
      if (
        typeof output.hookSpecificOutput['permissionDecisionReason'] ===
        'string'
      ) {
        reasons.push(output.hookSpecificOutput['permissionDecisionReason']);
      }

      if (
        'decision' in output.hookSpecificOutput &&
        typeof (
          output.hookSpecificOutput['decision'] as Record<string, unknown>
        )?.['message'] === 'string'
      ) {
        reasons.push(
          (output.hookSpecificOutput['decision'] as Record<string, unknown>)[
            'message'
          ] as string,
        );
      }
    }

    return reasons;
  }

  /**
   * Extract all reasons from multiple outputs
   */
  private extractAllReasons(outputs: HookOutput[]): string[] {
    const allReasons: string[] = [];
    for (const output of outputs) {
      allReasons.push(...this.extractReasons(output));
    }
    return [...new Set(allReasons)]; // Remove duplicates
  }
}

/**
 * Convenience function to aggregate hook results
 */
export function aggregateHookResults(
  eventName: HookEventName,
  results: HookExecutionResult[],
  config?: Partial<AggregationConfig>,
): HookAggregationResult {
  const aggregator = new HookAggregator(eventName, config);
  return aggregator.aggregate(results);
}
