/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  HookEventName,
  HookInput,
  HookOutput,
  HookExecutionResult,
  HookExecutionPlan,
  PreToolUseInput,
  PostToolUseInput,
  PermissionRequestInput,
  UserPromptSubmitInput,
  StopInput,
  SubagentStopInput,
  NotificationInput,
  SessionStartInput,
  PreCompactInput,
} from './types.js';
import type { HookPlanner } from './planner.js';
import type { HookRegistry } from './registry.js';
import type { HookAggregationResult } from './aggregator.js';
import { HookAggregator } from './aggregator.js';

/**
 * Event handler function type
 */
export type HookEventHandlerFn = (
  input: HookInput,
) => Promise<HookOutput> | HookOutput;

/**
 * Event context for hook execution
 */
export interface HookEventContext {
  /** Event name */
  eventName: HookEventName;
  /** Session ID */
  sessionId: string;
  /** Current working directory */
  cwd: string;
  /** Transcript path */
  transcriptPath: string;
  /** Timestamp */
  timestamp: string;
  /** Additional event-specific data */
  data?: Record<string, unknown>;
}

/**
 * Hook execution request
 */
export interface HookExecutionRequest {
  /** Event context */
  context: HookEventContext;
  /** Event-specific input data */
  input: HookInput;
  /** Tool name (for tool events) */
  toolName?: string;
  /** Display name (for matching) */
  displayName?: string;
}

/**
 * Hook execution response
 */
export interface HookExecutionResponse {
  /** Execution success */
  success: boolean;
  /** Aggregated output */
  output: HookOutput;
  /** Individual hook results */
  results: HookExecutionResult[];
  /** Whether execution was blocked */
  isBlocking: boolean;
  /** Reasons from hooks */
  reasons: string[];
  /** Execution duration in ms */
  duration: number;
}

/**
 * Options for HookEventHandler
 */
export interface HookEventHandlerOptions {
  /** Hook registry */
  registry: HookRegistry;
  /** Hook planner */
  planner: HookPlanner;
  /** Hook runner function */
  runHook: (config: unknown, input: HookInput) => Promise<HookExecutionResult>;
  /** Enable telemetry */
  telemetry?: boolean;
}

/**
 * HookEventHandler is the central coordinator for hook execution.
 * It handles the complete execution pipeline:
 * Planning → Execution → Aggregation → Telemetry
 */
export class HookEventHandler {
  constructor(private options: HookEventHandlerOptions) {}

  /**
   * Handle a hook execution request
   */
  async handle(request: HookExecutionRequest): Promise<HookExecutionResponse> {
    const startTime = Date.now();

    try {
      // Step 1: Create execution plan using planner
      const plan = this.createExecutionPlan(request);

      // If no hooks to execute, return empty success
      if (plan.hookConfigs.length === 0) {
        return {
          success: true,
          output: {},
          results: [],
          isBlocking: false,
          reasons: [],
          duration: Date.now() - startTime,
        };
      }

      // Step 2: Execute hooks (sequential or parallel)
      const results = await this.executeHooks(plan, request.input);

      // Step 3: Aggregate results
      const aggregationResult = this.aggregateResults(
        request.context.eventName,
        results,
      );

      const duration = Date.now() - startTime;

      // Step 4: Report telemetry if enabled
      if (this.options.telemetry) {
        this.reportTelemetry(request, results, duration);
      }

      return {
        success: aggregationResult.success,
        output: aggregationResult.output,
        results: aggregationResult.individualResults,
        isBlocking: aggregationResult.isBlocking,
        reasons: aggregationResult.reasons,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      return {
        success: false,
        output: {},
        results: [],
        isBlocking: true,
        reasons: [
          error instanceof Error
            ? error.message
            : 'Unknown error during hook execution',
        ],
        duration,
      };
    }
  }

  /**
   * Create execution plan for the request
   */
  private createExecutionPlan(
    request: HookExecutionRequest,
  ): HookExecutionPlan {
    const { context, toolName, displayName } = request;

    return this.options.planner.createPlan({
      eventName: context.eventName,
      toolName: toolName ?? displayName,
      hookDefinitions: this.options.registry.getAllDefinitions(),
      deduplicate: true,
    });
  }

  /**
   * Execute hooks according to the plan
   */
  private async executeHooks(
    plan: HookExecutionPlan,
    input: HookInput,
  ): Promise<HookExecutionResult[]> {
    const results: HookExecutionResult[] = [];

    if (plan.sequential) {
      // Sequential execution - hooks run one by one
      for (const hookConfig of plan.hookConfigs) {
        const result = await this.options.runHook(hookConfig, input);
        results.push(result);

        // If a hook blocks, stop execution
        if (
          result.output?.decision === 'block' ||
          result.output?.decision === 'deny'
        ) {
          break;
        }
      }
    } else {
      // Parallel execution - all hooks run concurrently
      const promises = plan.hookConfigs.map((hookConfig) =>
        this.options.runHook(hookConfig, input),
      );
      const parallelResults = await Promise.all(promises);
      results.push(...parallelResults);
    }

    return results;
  }

  /**
   * Aggregate hook execution results
   */
  private aggregateResults(
    eventName: HookEventName,
    results: HookExecutionResult[],
  ): HookAggregationResult {
    const aggregator = new HookAggregator(eventName);
    return aggregator.aggregate(results);
  }

  /**
   * Report telemetry data
   */
  private reportTelemetry(
    _request: HookExecutionRequest,
    _results: HookExecutionResult[],
    _duration: number,
  ): void {
    // Telemetry implementation would go here
    // Placeholder for future telemetry integration
    void _request;
    void _results;
    void _duration;
  }

  /**
   * Create hook input from event context
   */
  createHookInput(context: HookEventContext): HookInput {
    return {
      session_id: context.sessionId,
      transcript_path: context.transcriptPath,
      cwd: context.cwd,
      hook_event_name: context.eventName,
      timestamp: context.timestamp,
    };
  }

  /**
   * Create PreToolUse hook input
   */
  createPreToolUseInput(
    context: HookEventContext,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
  ): PreToolUseInput {
    return {
      ...this.createHookInput(context),
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
    };
  }

  /**
   * Create PostToolUse hook input
   */
  createPostToolUseInput(
    context: HookEventContext,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown>,
    toolUseId: string,
  ): PostToolUseInput {
    return {
      ...this.createHookInput(context),
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      tool_use_id: toolUseId,
    };
  }

  /**
   * Create PermissionRequest hook input
   */
  createPermissionRequestInput(
    context: HookEventContext,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
  ): PermissionRequestInput {
    return {
      ...this.createHookInput(context),
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
    };
  }

  /**
   * Create UserPromptSubmit hook input
   */
  createUserPromptSubmitInput(
    context: HookEventContext,
    prompt: string,
  ): UserPromptSubmitInput {
    return {
      ...this.createHookInput(context),
      prompt,
    };
  }

  /**
   * Create Stop hook input
   */
  createStopInput(
    context: HookEventContext,
    stopHookActive: boolean,
  ): StopInput {
    return {
      ...this.createHookInput(context),
      stop_hook_active: stopHookActive,
    };
  }

  /**
   * Create SubagentStop hook input
   */
  createSubagentStopInput(
    context: HookEventContext,
    stopHookActive: boolean,
  ): SubagentStopInput {
    return {
      ...this.createHookInput(context),
      stop_hook_active: stopHookActive,
    };
  }

  /**
   * Create Notification hook input
   */
  createNotificationInput(
    context: HookEventContext,
    notificationType: string,
    message: string,
  ): NotificationInput {
    return {
      ...this.createHookInput(context),
      notification_type:
        notificationType as unknown as import('./types.js').NotificationType,
      message,
    };
  }

  /**
   * Create SessionStart hook input
   */
  createSessionStartInput(
    context: HookEventContext,
    source: string,
  ): SessionStartInput {
    return {
      ...this.createHookInput(context),
      source: source as unknown as import('./types.js').SessionStartSource,
    };
  }

  /**
   * Create SessionEnd hook input
   */
  createSessionEndInput(
    context: HookEventContext,
    reason: string,
  ): import('./types.js').SessionEndInput {
    return {
      ...this.createHookInput(context),
      reason: reason as unknown as import('./types.js').SessionEndReason,
    };
  }

  /**
   * Create PreCompact hook input
   */
  createPreCompactInput(
    context: HookEventContext,
    trigger: string,
    customInstructions: string,
  ): PreCompactInput {
    return {
      ...this.createHookInput(context),
      trigger: trigger as unknown as import('./types.js').PreCompactTrigger,
      custom_instructions: customInstructions,
    };
  }
}

/**
 * Create a hook event handler
 */
export function createHookEventHandler(
  options: HookEventHandlerOptions,
): HookEventHandler {
  return new HookEventHandler(options);
}
