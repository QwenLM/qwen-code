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

const debugLogger = createDebugLogger('TRUSTED_HOOKS');

/**
 * Hook event bus that coordinates hook execution across the system
 */
export class HookEventHandler {
  private readonly config: Config;
  private readonly hookPlanner: HookPlanner;
  private readonly hookRunner: HookRunner;
  private readonly hookAggregator: HookAggregator;

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
  }
}
