/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { HookPlanner, HookEventContext } from './hookPlanner.js';
import type { HookRunner } from './hookRunner.js';
import type { HookAggregator, AggregatedHookResult } from './hookAggregator.js';
import { HookEventName } from './types.js';
import type {
  HookConfig,
  HookInput,
  HookExecutionResult,
  PreToolUseInput,
  PostToolUseInput,
  UserPromptSubmitInput,
  NotificationInput,
  StopInput,
  SessionStartInput,
  SessionEndInput,
  PreCompactInput,
  NotificationType,
  SessionStartSource,
  SessionEndReason,
  PreCompactTrigger,
  McpToolContext,
} from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('TRUSTED_HOOKS');

/**
 * Hook event bus that coordinates hook execution across the system
 */
export class HookEventHandler {
  private readonly config: Config;
  private readonly hookPlanner: HookPlanner;
  private readonly hookRunner: HookRunner;
  private readonly hookAggregator: HookAggregator;

  /**
   * Track reported failures to suppress duplicate warnings during streaming.
   * Uses a WeakMap with the original request object as a key to ensure
   * failures are only reported once per logical model interaction.
   */
  private readonly reportedFailures = new WeakMap<object, Set<string>>();

  constructor(
    config: Config,
    hookPlanner: HookPlanner,
    hookRunner: HookRunner,
    hookAggregator: HookAggregator,
  ) {
    this.config = config;
    this.hookPlanner = hookPlanner;
    this.hookRunner = hookRunner;
    this.hookAggregator = hookAggregator;
  }

  /**
   * Fire a PreToolUse event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async firePreToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    mcpContext?: McpToolContext,
  ): Promise<AggregatedHookResult> {
    const input: PreToolUseInput = {
      ...this.createBaseInput(HookEventName.PreToolUse),
      tool_name: toolName,
      tool_input: toolInput,
      ...(mcpContext && { mcp_context: mcpContext }),
    };

    const context: HookEventContext = { toolName };
    return this.executeHooks(HookEventName.PreToolUse, input, context);
  }

  /**
   * Fire a PostToolUse event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async firePostToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown>,
    mcpContext?: McpToolContext,
  ): Promise<AggregatedHookResult> {
    const input: PostToolUseInput = {
      ...this.createBaseInput(HookEventName.PostToolUse),
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      ...(mcpContext && { mcp_context: mcpContext }),
    };

    const context: HookEventContext = { toolName };
    return this.executeHooks(HookEventName.PostToolUse, input, context);
  }

  /**
   * Fire a UserPromptSubmit event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async fireUserPromptSubmitEvent(
    prompt: string,
  ): Promise<AggregatedHookResult> {
    const input: UserPromptSubmitInput = {
      ...this.createBaseInput(HookEventName.UserPromptSubmit),
      prompt,
    };

    return this.executeHooks(HookEventName.UserPromptSubmit, input);
  }

  /**
   * Fire a Notification event
   */
  async fireNotificationEvent(
    type: NotificationType,
    message: string,
    details: Record<string, unknown>,
  ): Promise<AggregatedHookResult> {
    const input: NotificationInput = {
      ...this.createBaseInput(HookEventName.Notification),
      notification_type: type,
      message,
      details,
    };

    return this.executeHooks(HookEventName.Notification, input);
  }

  /**
   * Fire a Stop event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async fireStopEvent(
    prompt: string,
    promptResponse: string,
    stopHookActive: boolean = false,
  ): Promise<AggregatedHookResult> {
    const input: StopInput = {
      ...this.createBaseInput(HookEventName.Stop),
      prompt,
      prompt_response: promptResponse,
      stop_hook_active: stopHookActive,
    };

    return this.executeHooks(HookEventName.Stop, input);
  }

  /**
   * Fire a SessionStart event
   */
  async fireSessionStartEvent(
    source: SessionStartSource,
  ): Promise<AggregatedHookResult> {
    const input: SessionStartInput = {
      ...this.createBaseInput(HookEventName.SessionStart),
      source,
    };

    const context: HookEventContext = { trigger: source };
    return this.executeHooks(HookEventName.SessionStart, input, context);
  }

  /**
   * Fire a SessionEnd event
   */
  async fireSessionEndEvent(
    reason: SessionEndReason,
  ): Promise<AggregatedHookResult> {
    const input: SessionEndInput = {
      ...this.createBaseInput(HookEventName.SessionEnd),
      reason,
    };

    const context: HookEventContext = { trigger: reason };
    return this.executeHooks(HookEventName.SessionEnd, input, context);
  }

  /**
   * Fire a PreCompact event
   */
  async firePreCompactEvent(
    trigger: PreCompactTrigger,
  ): Promise<AggregatedHookResult> {
    const input: PreCompactInput = {
      ...this.createBaseInput(HookEventName.PreCompact),
      trigger,
    };

    const context: HookEventContext = { trigger };
    return this.executeHooks(HookEventName.PreCompact, input, context);
  }

  /**
   * Execute hooks for a specific event (direct execution without MessageBus)
   * Used as fallback when MessageBus is not available
   */
  private async executeHooks(
    eventName: HookEventName,
    input: HookInput,
    context?: HookEventContext,
    requestContext?: object,
  ): Promise<AggregatedHookResult> {
    try {
      // Create execution plan
      const plan = this.hookPlanner.createExecutionPlan(eventName, context);

      if (!plan || plan.hookConfigs.length === 0) {
        return {
          success: true,
          allOutputs: [],
          errors: [],
          totalDuration: 0,
        };
      }

      const onHookStart = (_config: HookConfig, _index: number) => {
        // Hook start event (telemetry removed)
      };

      const onHookEnd = (_config: HookConfig, _result: HookExecutionResult) => {
        // Hook end event (telemetry removed)
      };

      // Execute hooks according to the plan's strategy
      const results = plan.sequential
        ? await this.hookRunner.executeHooksSequential(
            plan.hookConfigs,
            eventName,
            input,
            onHookStart,
            onHookEnd,
          )
        : await this.hookRunner.executeHooksParallel(
            plan.hookConfigs,
            eventName,
            input,
            onHookStart,
            onHookEnd,
          );

      // Aggregate results
      const aggregated = this.hookAggregator.aggregateResults(
        results,
        eventName,
      );

      // Process common hook output fields centrally
      this.processCommonHookOutputFields(aggregated);

      // Log hook execution
      this.logHookExecution(
        eventName,
        input,
        results,
        aggregated,
        requestContext,
      );

      return aggregated;
    } catch (error) {
      debugLogger.error(`Hook event bus error for ${eventName}: ${error}`);

      return {
        success: false,
        allOutputs: [],
        errors: [error instanceof Error ? error : new Error(String(error))],
        totalDuration: 0,
      };
    }
  }

  /**
   * Create base hook input with common fields
   */
  private createBaseInput(eventName: HookEventName): HookInput {
    // Get the transcript path from the Config
    const transcriptPath = this.config.getTranscriptPath();

    return {
      session_id: this.config.getSessionId(),
      transcript_path: transcriptPath,
      cwd: this.config.getWorkingDir(),
      hook_event_name: eventName,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Log hook execution for observability
   */
  private logHookExecution(
    eventName: HookEventName,
    input: HookInput,
    results: HookExecutionResult[],
    aggregated: AggregatedHookResult,
    requestContext?: object,
  ): void {
    const failedHooks = results.filter((r) => !r.success);
    const successCount = results.length - failedHooks.length;
    const errorCount = failedHooks.length;

    if (errorCount > 0) {
      const failedNames = failedHooks
        .map((r) => this.getHookNameFromResult(r))
        .join(', ');

      let shouldEmit = true;
      if (requestContext) {
        let reportedSet = this.reportedFailures.get(requestContext);
        if (!reportedSet) {
          reportedSet = new Set<string>();
          this.reportedFailures.set(requestContext, reportedSet);
        }

        const failureKey = `${eventName}:${failedNames}`;
        if (reportedSet.has(failureKey)) {
          shouldEmit = false;
        } else {
          reportedSet.add(failureKey);
        }
      }

      debugLogger.warn(
        `Hook execution for ${eventName}: ${successCount} succeeded, ${errorCount} failed (${failedNames}), ` +
          `total duration: ${aggregated.totalDuration}ms`,
      );

      if (shouldEmit) {
        debugLogger.warn(
          `Hook(s) [${failedNames}] failed for event ${eventName}. Check debug logs for more details.`,
        );
      }
    } else {
      debugLogger.debug(
        `Hook execution for ${eventName}: ${successCount} hooks executed successfully, ` +
          `total duration: ${aggregated.totalDuration}ms`,
      );
    }

    // Log individual errors
    for (const error of aggregated.errors) {
      debugLogger.warn(`Hook execution error: ${error.message}`);
    }
  }

  /**
   * Process common hook output fields centrally
   */
  private processCommonHookOutputFields(
    aggregated: AggregatedHookResult,
  ): void {
    if (!aggregated.finalOutput) {
      return;
    }

    // Handle systemMessage - show to user in transcript mode (not to agent)
    const systemMessage = aggregated.finalOutput.systemMessage;
    if (systemMessage && !aggregated.finalOutput.suppressOutput) {
      debugLogger.warn(`Hook system message: ${systemMessage}`);
    }

    // Handle suppressOutput - already handled by not logging above when true

    // Handle continue=false - this should stop the entire agent execution
    if (aggregated.finalOutput.continue === false) {
      const stopReason =
        aggregated.finalOutput.stopReason ||
        aggregated.finalOutput.reason ||
        'No reason provided';
      debugLogger.debug(`Hook requested to stop execution: ${stopReason}`);

      // Note: The actual stopping of execution must be handled by integration points
      // as they need to interpret this signal in the context of their specific workflow
      // This is just logging the request centrally
    }

    // Other common fields like decision/reason are handled by specific hook output classes
  }

  /**
   * Get hook name from config for display or telemetry
   */
  private getHookName(config: HookConfig): string {
    return config.name || config.command || 'unknown-command';
  }

  /**
   * Get hook name from execution result for telemetry
   */
  private getHookNameFromResult(result: HookExecutionResult): string {
    return this.getHookName(result.hookConfig);
  }
}
