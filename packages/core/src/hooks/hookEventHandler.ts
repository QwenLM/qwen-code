/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { HookPlanner, HookEventContext } from './hookPlanner.js';
import type { HookRunner } from './hookRunner.js';
import type { HookAggregator, AggregatedHookResult } from './hookAggregator.js';
import { HookEventName, PermissionMode } from './types.js';
import type {
  HookConfig,
  HookInput,
  HookExecutionResult,
  UserPromptSubmitInput,
  StopInput,
  PreToolUseInput,
  PostToolUseInput,
  PostToolUseFailureInput,
  NotificationInput,
  McpToolContext,
  SessionStartInput,
  SessionEndInput,
  PreCompactInput,
  SubagentStartInput,
  SubagentStopInput,
  PermissionRequestInput,
  PermissionSuggestion,
  SessionStartSource,
  SessionEndReason,
  PreCompactTrigger,
  AgentType,
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
   * Fire a PreToolUse event
   * Called before tool execution begins
   */
  async firePreToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
  ): Promise<AggregatedHookResult> {
    const input: PreToolUseInput = {
      ...this.createBaseInput(HookEventName.PreToolUse),
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
    };

    return this.executeHooks(HookEventName.PreToolUse, input);
  }

  /**
   * Fire a PostToolUse event
   * Called after successful tool execution
   */
  async firePostToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown>,
    toolUseId: string, // Added: tool_use_id parameter
    mcpContext?: McpToolContext,
    originalRequestName?: string,
  ): Promise<AggregatedHookResult> {
    const input: PostToolUseInput = {
      ...this.createBaseInput(HookEventName.PostToolUse),
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      tool_use_id: toolUseId, // Added: include tool_use_id in input
      mcp_context: mcpContext,
      original_request_name: originalRequestName,
    };

    return this.executeHooks(HookEventName.PostToolUse, input);
  }

  /**
   * Fire a PostToolUseFailure event
   * Called when tool execution fails
   */
  async firePostToolUseFailureEvent(
    toolUseId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    errorMessage: string,
    errorType?: string,
    isInterrupt?: boolean,
  ): Promise<AggregatedHookResult> {
    const input: PostToolUseFailureInput = {
      ...this.createBaseInput(HookEventName.PostToolUseFailure),
      tool_use_id: toolUseId,
      tool_name: toolName,
      tool_input: toolInput,
      error: errorMessage,
      error_type: errorType,
      is_interrupt: isInterrupt,
    };

    return this.executeHooks(HookEventName.PostToolUseFailure, input);
  }

  /**
   * Fire a Notification event
   * Called when a notification is generated
   */
  async fireNotificationEvent(
    notificationType: string, // Changed: string instead of NotificationType enum
    message: string,
    title?: string,
  ): Promise<AggregatedHookResult> {
    const input: NotificationInput = {
      ...this.createBaseInput(HookEventName.Notification),
      notification_type: notificationType,
      message,
      title,
      // Removed: details parameter (not in Claude's definition)
    };

    return this.executeHooks(HookEventName.Notification, input);
  }

  /**
   * Fire a SessionStart event
   * Called when a new session starts or is resumed
   */
  async fireSessionStartEvent(
    source: SessionStartSource,
    model?: string,
  ): Promise<AggregatedHookResult> {
    const input: SessionStartInput = {
      ...this.createBaseInput(HookEventName.SessionStart),
      source,
      model,
    };

    return this.executeHooks(HookEventName.SessionStart, input);
  }

  /**
   * Fire a SessionEnd event
   * Called when a session is ending
   */
  async fireSessionEndEvent(
    reason: SessionEndReason,
  ): Promise<AggregatedHookResult> {
    const input: SessionEndInput = {
      ...this.createBaseInput(HookEventName.SessionEnd),
      reason,
    };

    return this.executeHooks(HookEventName.SessionEnd, input);
  }

  /**
   * Fire a PreCompact event
   * Called before context compaction
   */
  async firePreCompactEvent(
    trigger: PreCompactTrigger,
    customInstructions?: string,
  ): Promise<AggregatedHookResult> {
    const input: PreCompactInput = {
      ...this.createBaseInput(HookEventName.PreCompact),
      trigger,
      custom_instructions: customInstructions,
    };

    return this.executeHooks(HookEventName.PreCompact, input);
  }

  /**
   * Fire a SubagentStart event
   * Called when a subagent (Task tool call) is started
   */
  async fireSubagentStartEvent(
    agentId: string,
    agentType: AgentType,
  ): Promise<AggregatedHookResult> {
    const input: SubagentStartInput = {
      ...this.createBaseInput(HookEventName.SubagentStart),
      agent_id: agentId,
      agent_type: agentType,
    };

    return this.executeHooks(HookEventName.SubagentStart, input);
  }

  /**
   * Fire a SubagentStop event
   * Called right before a subagent (Task tool call) concludes its response
   */
  async fireSubagentStopEvent(
    agentId: string,
    agentType: AgentType,
    agentTranscriptPath: string,
    lastAssistantMessage: string,
    stopHookActive: boolean = false,
  ): Promise<AggregatedHookResult> {
    const input: SubagentStopInput = {
      ...this.createBaseInput(HookEventName.SubagentStop),
      stop_hook_active: stopHookActive,
      agent_id: agentId,
      agent_type: agentType,
      agent_transcript_path: agentTranscriptPath,
      last_assistant_message: lastAssistantMessage,
    };

    return this.executeHooks(HookEventName.SubagentStop, input);
  }

  /**
   * Fire a PermissionRequest event
   * Called when a permission dialog is displayed
   */
  async firePermissionRequestEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    permissionSuggestions?: PermissionSuggestion[],
  ): Promise<AggregatedHookResult> {
    const input: PermissionRequestInput = {
      ...this.createBaseInput(HookEventName.PermissionRequest),
      permission_mode: this.convertApprovalModeToPermissionMode(
        this.config.getApprovalMode(),
      ),
      tool_name: toolName,
      tool_input: toolInput,
      permission_suggestions: permissionSuggestions,
    };

    return this.executeHooks(HookEventName.PermissionRequest, input);
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
   * Convert ApprovalMode to PermissionMode
   */
  private convertApprovalModeToPermissionMode(
    approvalMode: string,
  ): PermissionMode {
    switch (approvalMode) {
      case 'plan':
        return PermissionMode.Plan;
      case 'auto-edit':
        return PermissionMode.AcceptEdit;
      case 'yolo':
        return PermissionMode.DontAsk;
      default:
        return PermissionMode.Default;
    }
  }

  /**
   * Create base hook input with common fields
   */
  private createBaseInput(eventName: HookEventName): HookInput {
    // Get the transcript path from the Config
    const transcriptPath = this.config.getTranscriptPath();
    const approvalMode = this.config.getApprovalMode();

    return {
      session_id: this.config.getSessionId(),
      transcript_path: transcriptPath,
      cwd: this.config.getWorkingDir(),
      permission_mode: this.convertApprovalModeToPermissionMode(approvalMode),
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
