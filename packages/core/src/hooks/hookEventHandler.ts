/**
 * @license
 * Copyright 2026 Qwen Team
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
  UserPromptSubmitInput,
  StopInput,
} from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { logHookCall } from '../telemetry/loggers.js';
import { HookCallEvent } from '../telemetry/types.js';

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
   * Fire a Stop event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async fireStopEvent(
    stopHookActive: boolean = false,
    lastAssistantMessage: string = '',
  ): Promise<AggregatedHookResult> {
    const input: StopInput = {
      ...this.createBaseInput(HookEventName.Stop),
      stop_hook_active: stopHookActive,
      last_assistant_message: lastAssistantMessage,
    };

    return this.executeHooks(HookEventName.Stop, input);
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

      const onHookStart = (config: HookConfig, index: number) => {
        // Hook start event
        debugLogger.debug(
          `Hook ${this.getHookName(config)} started for event ${eventName} (${index + 1}/${plan.hookConfigs.length})`,
        );
      };

      const onHookEnd = (config: HookConfig, result: HookExecutionResult) => {
        // Hook end event
        debugLogger.debug(
          `Hook ${this.getHookName(config)} ended for event ${eventName}: ${result.success ? 'success' : 'failed'}`,
        );
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

      // Log hook execution for telemetry
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

    // Handle continue=false - this should stop the entire agent execution
    if (aggregated.finalOutput.continue === false) {
      const stopReason =
        aggregated.finalOutput.stopReason ||
        aggregated.finalOutput.reason ||
        'No reason provided';
      debugLogger.debug(`Hook requested to stop execution: ${stopReason}`);
    }
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
        // Emit feedback event for failed hooks
        debugLogger.warn(
          `Hook(s) [${failedNames}] failed for event ${eventName}. Check debug logs for more details.\n`,
        );
      }
    } else {
      debugLogger.debug(
        `Hook execution for ${eventName}: ${successCount} hooks executed successfully, ` +
          `total duration: ${aggregated.totalDuration}ms`,
      );
    }

    // Log individual hook calls to telemetry
    for (const result of results) {
      // Determine hook name and type for telemetry
      const hookName = this.getHookNameFromResult(result);
      const hookType = this.getHookTypeFromResult(result);

      const hookCallEvent = new HookCallEvent(
        eventName,
        hookType,
        hookName,
        { ...input },
        result.duration,
        result.success,
        result.output ? { ...result.output } : undefined,
        result.exitCode,
        result.stdout,
        result.stderr,
        result.error?.message,
      );

      logHookCall(this.config, hookCallEvent);
    }

    // Log individual errors
    for (const error of aggregated.errors) {
      debugLogger.warn(`Hook execution error: ${error.message}`);
    }
  }

  /**
   * Get hook name from config for display or telemetry
   */
  private getHookName(config: HookConfig): string {
    if (config.type === 'command') {
      return config.name || config.command || 'unknown-command';
    }
    return config.name || 'unknown-hook';
  }

  /**
   * Get hook name from execution result for telemetry
   */
  private getHookNameFromResult(result: HookExecutionResult): string {
    return this.getHookName(result.hookConfig);
  }

  /**
   * Get hook type from execution result for telemetry
   */
  private getHookTypeFromResult(result: HookExecutionResult): 'command' {
    return result.hookConfig.type as 'command';
  }
}
