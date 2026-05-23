/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { HookPlanner, HookEventContext } from './hookPlanner.js';
import type { HookRunner } from './hookRunner.js';
import type { HookAggregator, AggregatedHookResult } from './hookAggregator.js';
import type { SessionHooksManager } from './sessionHooksManager.js';
import { HookEventName } from './types.js';
import type {
  HookConfig,
  HookInput,
  HookExecutionResult,
  UserPromptSubmitInput,
  StopInput,
  SessionStartInput,
  SessionEndInput,
  SessionStartSource,
  SessionEndReason,
  AgentType,
  PreToolUseInput,
  PostToolUseInput,
  PostToolUseFailureInput,
  PreCompactInput,
  PreCompactTrigger,
  PostCompactInput,
  PostCompactTrigger,
  NotificationInput,
  NotificationType,
  PermissionRequestInput,
  PermissionSuggestion,
  SubagentStartInput,
  SubagentStopInput,
  MessagesProvider,
  FunctionHookContext,
  StopFailureInput,
  StopFailureErrorType,
  TodoCreatedInput,
  TodoCompletedInput,
  TodoItem,
  TodoStatus,
} from './types.js';
import { HookPhase, PermissionMode } from './types.js';
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
  private readonly sessionHooksManager: SessionHooksManager;
  /** Optional provider for conversation history */
  private messagesProvider?: MessagesProvider;

  constructor(
    config: Config,
    hookPlanner: HookPlanner,
    hookRunner: HookRunner,
    hookAggregator: HookAggregator,
    sessionHooksManager: SessionHooksManager,
    messagesProvider?: MessagesProvider,
  ) {
    this.config = config;
    this.hookPlanner = hookPlanner;
    this.hookRunner = hookRunner;
    this.hookAggregator = hookAggregator;
    this.sessionHooksManager = sessionHooksManager;
    this.messagesProvider = messagesProvider;
  }

  /**
   * Set the messages provider for automatic conversation history passing
   */
  setMessagesProvider(provider: MessagesProvider): void {
    this.messagesProvider = provider;
  }

  /**
   * Get the current messages provider
   */
  getMessagesProvider(): MessagesProvider | undefined {
    return this.messagesProvider;
  }

  /**
   * Fire a UserPromptSubmit event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async fireUserPromptSubmitEvent(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: UserPromptSubmitInput = {
      ...this.createBaseInput(HookEventName.UserPromptSubmit),
      prompt,
    };

    return this.executeHooks(
      HookEventName.UserPromptSubmit,
      input,
      undefined,
      signal,
    );
  }

  /**
   * Fire a Stop event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async fireStopEvent(
    stopHookActive: boolean = false,
    lastAssistantMessage: string = '',
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: StopInput = {
      ...this.createBaseInput(HookEventName.Stop),
      stop_hook_active: stopHookActive,
      last_assistant_message: lastAssistantMessage,
    };

    return this.executeHooks(HookEventName.Stop, input, undefined, signal);
  }

  /**
   * Fire a SessionStart event
   * Called when a new session starts or resumes
   */
  async fireSessionStartEvent(
    source: SessionStartSource,
    model: string,
    permissionMode?: PermissionMode,
    agentType?: AgentType,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: SessionStartInput = {
      ...this.createBaseInput(HookEventName.SessionStart),
      permission_mode: permissionMode ?? PermissionMode.Default,
      source,
      model,
      agent_type: agentType,
    };

    // Pass source as context for matcher filtering
    return this.executeHooks(
      HookEventName.SessionStart,
      input,
      {
        trigger: source,
      },
      signal,
    );
  }

  /**
   * Fire a SessionEnd event
   * Called when a session ends
   */
  async fireSessionEndEvent(
    reason: SessionEndReason,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: SessionEndInput = {
      ...this.createBaseInput(HookEventName.SessionEnd),
      reason,
    };

    // Pass reason as context for matcher filtering
    return this.executeHooks(
      HookEventName.SessionEnd,
      input,
      {
        trigger: reason,
      },
      signal,
    );
  }

  /**
   * Fire a PreToolUse event
   * Called before tool execution begins
   */
  async firePreToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    permissionMode: PermissionMode,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: PreToolUseInput = {
      ...this.createBaseInput(HookEventName.PreToolUse),
      permission_mode: permissionMode,
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
    };

    // Pass tool name as context for matcher filtering
    return this.executeHooks(
      HookEventName.PreToolUse,
      input,
      {
        toolName,
      },
      signal,
    );
  }

  /**
   * Fire a PostToolUse event
   * Called after successful tool execution
   */
  async firePostToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown>,
    toolUseId: string,
    permissionMode: PermissionMode,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: PostToolUseInput = {
      ...this.createBaseInput(HookEventName.PostToolUse),
      permission_mode: permissionMode,
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      tool_use_id: toolUseId,
    };

    // Pass tool name as context for matcher filtering
    return this.executeHooks(
      HookEventName.PostToolUse,
      input,
      {
        toolName,
      },
      signal,
    );
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
    isInterrupt?: boolean,
    permissionMode?: PermissionMode,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: PostToolUseFailureInput = {
      ...this.createBaseInput(HookEventName.PostToolUseFailure),
      permission_mode: permissionMode ?? PermissionMode.Default,
      tool_use_id: toolUseId,
      tool_name: toolName,
      tool_input: toolInput,
      error: errorMessage,
      is_interrupt: isInterrupt,
    };

    // Pass tool name as context for matcher filtering
    return this.executeHooks(
      HookEventName.PostToolUseFailure,
      input,
      {
        toolName,
      },
      signal,
    );
  }

  /**
   * Fire a PreCompact event
   * Called before conversation compaction begins
   */
  async firePreCompactEvent(
    trigger: PreCompactTrigger,
    customInstructions: string = '',
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: PreCompactInput = {
      ...this.createBaseInput(HookEventName.PreCompact),
      trigger,
      custom_instructions: customInstructions,
    };

    // Pass trigger as context for matcher filtering
    return this.executeHooks(
      HookEventName.PreCompact,
      input,
      {
        trigger,
      },
      signal,
    );
  }

  /**
   * Fire a Notification event
   */
  async fireNotificationEvent(
    message: string,
    notificationType: NotificationType,
    title?: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: NotificationInput = {
      ...this.createBaseInput(HookEventName.Notification),
      message,
      notification_type: notificationType,
      title,
    };

    // Pass notification_type as context for matcher filtering
    return this.executeHooks(
      HookEventName.Notification,
      input,
      {
        notificationType,
      },
      signal,
    );
  }

  /**
   * Fire a PermissionRequest event
   * Called when a permission dialog is about to be shown to the user
   */
  async firePermissionRequestEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    permissionMode: PermissionMode,
    permissionSuggestions?: PermissionSuggestion[],
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: PermissionRequestInput = {
      ...this.createBaseInput(HookEventName.PermissionRequest),
      permission_mode: permissionMode,
      tool_name: toolName,
      tool_input: toolInput,
      permission_suggestions: permissionSuggestions,
    };

    // Pass tool name as context for matcher filtering
    return this.executeHooks(
      HookEventName.PermissionRequest,
      input,
      {
        toolName,
      },
      signal,
    );
  }

  /**
   * Fire a SubagentStart event
   * Called when a subagent is spawned via the Agent tool
   */
  async fireSubagentStartEvent(
    agentId: string,
    agentType: AgentType | string,
    permissionMode: PermissionMode,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: SubagentStartInput = {
      ...this.createBaseInput(HookEventName.SubagentStart),
      permission_mode: permissionMode,
      agent_id: agentId,
      agent_type: agentType,
    };

    // Pass agentType as context for matcher filtering
    return this.executeHooks(
      HookEventName.SubagentStart,
      input,
      {
        agentType: String(agentType),
      },
      signal,
    );
  }

  /**
   * Fire a SubagentStop event
   * Called when a subagent has finished responding
   */
  async fireSubagentStopEvent(
    agentId: string,
    agentType: AgentType | string,
    agentTranscriptPath: string,
    lastAssistantMessage: string,
    stopHookActive: boolean,
    permissionMode: PermissionMode,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: SubagentStopInput = {
      ...this.createBaseInput(HookEventName.SubagentStop),
      permission_mode: permissionMode,
      stop_hook_active: stopHookActive,
      agent_id: agentId,
      agent_type: agentType,
      agent_transcript_path: agentTranscriptPath,
      last_assistant_message: lastAssistantMessage,
    };

    // Pass agentType as context for matcher filtering
    return this.executeHooks(
      HookEventName.SubagentStop,
      input,
      {
        agentType: String(agentType),
      },
      signal,
    );
  }

  /**
   * Fire a StopFailure event
   * Called when an API error ends the turn (instead of Stop)
   * Fire-and-forget: output and exit codes are ignored
   */
  async fireStopFailureEvent(
    error: StopFailureErrorType,
    errorDetails?: string,
    lastAssistantMessage?: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: StopFailureInput = {
      ...this.createBaseInput(HookEventName.StopFailure),
      error,
      error_details: errorDetails,
      last_assistant_message: lastAssistantMessage,
    };

    // Pass error type as context for matcher filtering (fieldToMatch: 'error')
    return this.executeHooks(
      HookEventName.StopFailure,
      input,
      { error },
      signal,
    );
  }

  /**
   * Fire a PostCompact event
   * Called after conversation compaction completes
   */
  async firePostCompactEvent(
    trigger: PostCompactTrigger,
    compactSummary: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: PostCompactInput = {
      ...this.createBaseInput(HookEventName.PostCompact),
      trigger,
      compact_summary: compactSummary,
    };

    // Pass trigger as context for matcher filtering
    return this.executeHooks(
      HookEventName.PostCompact,
      input,
      { trigger },
      signal,
    );
  }

  /**
   * Fire a TodoCreated event
   * Called when a new todo item is added to the list
   */
  async fireTodoCreatedEvent(
    todoId: string,
    todoContent: string,
    todoStatus: TodoStatus,
    allTodos: TodoItem[],
    phase: HookPhase,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: TodoCreatedInput = {
      ...this.createBaseInput(HookEventName.TodoCreated),
      hook_event_name: 'TodoCreated',
      todo_id: todoId,
      todo_content: todoContent,
      todo_status: todoStatus,
      all_todos: allTodos,
      phase,
    };

    return this.executeHooks(
      HookEventName.TodoCreated,
      input,
      undefined,
      signal,
    );
  }

  /**
   * Fire a TodoCompleted event
   * Called when a todo item's status changes to 'completed'
   */
  async fireTodoCompletedEvent(
    todoId: string,
    todoContent: string,
    previousStatus: 'pending' | 'in_progress',
    allTodos: TodoItem[],
    phase: HookPhase,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const input: TodoCompletedInput = {
      ...this.createBaseInput(HookEventName.TodoCompleted),
      hook_event_name: 'TodoCompleted',
      todo_id: todoId,
      todo_content: todoContent,
      previous_status: previousStatus,
      all_todos: allTodos,
      phase,
    };

    return this.executeHooks(
      HookEventName.TodoCompleted,
      input,
      undefined,
      signal,
    );
  }

  /**
   * Execute hooks for a specific event (direct execution without MessageBus)
   * Used as fallback when MessageBus is not available
   */
  private async executeHooks(
    eventName: HookEventName,
    input: HookInput,
    context?: HookEventContext,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const failClosedResult: AggregatedHookResult = {
      success: false,
      allOutputs: [],
      errors: [],
      totalDuration: 0,
      finalOutput:
        eventName === HookEventName.TodoCreated ||
        eventName === HookEventName.TodoCompleted
          ? {
              decision: 'block',
              reason: `Hook system failed while processing ${eventName}`,
            }
          : undefined,
    };

    try {
      // Create execution plan from registry hooks
      const plan = this.hookPlanner.createExecutionPlan(eventName, context);

      // Get session hooks and merge with registry hooks
      const sessionId = input.session_id;
      const targetName = context?.toolName || '';
      const sessionHooks = sessionId
        ? this.sessionHooksManager.getMatchingHooks(
            sessionId,
            eventName,
            targetName,
          )
        : [];

      // Merge hook configs from registry plan and session hooks
      const registryHookConfigs = plan?.hookConfigs || [];
      const sessionHookConfigs = sessionHooks.map((entry) => entry.config);
      const allHookConfigs = [...registryHookConfigs, ...sessionHookConfigs];

      if (allHookConfigs.length === 0) {
        return {
          success: true,
          allOutputs: [],
          errors: [],
          totalDuration: 0,
        };
      }

      // Determine execution strategy: sequential if any hook requires it
      const sequential =
        (plan?.sequential ?? false) ||
        sessionHooks.some((entry) => entry.sequential === true);

      // Build function hook context with messages from provider
      const messages = this.messagesProvider?.();
      const functionContext: FunctionHookContext = {
        messages,
        toolUseID:
          'tool_use_id' in input ? (input.tool_use_id as string) : undefined,
        signal,
      };

      const totalHooks = allHookConfigs.length;
      const onHookStart = (config: HookConfig, index: number) => {
        const hookName = this.getHookName(config);
        debugLogger.debug(
          `Hook ${hookName} started for event ${eventName} (${index + 1}/${totalHooks})`,
        );
      };

      const onHookEnd = (config: HookConfig, result: HookExecutionResult) => {
        const hookName = this.getHookName(config);
        debugLogger.debug(
          `Hook ${hookName} ended for event ${eventName}: ${result.success ? 'success' : 'failed'}`,
        );
      };

      // Execute hooks according to the merged strategy
      const results = sequential
        ? await this.hookRunner.executeHooksSequential(
            allHookConfigs,
            eventName,
            input,
            onHookStart,
            onHookEnd,
            signal,
            functionContext,
          )
        : await this.hookRunner.executeHooksParallel(
            allHookConfigs,
            eventName,
            input,
            onHookStart,
            onHookEnd,
            signal,
            functionContext,
          );

      // Aggregate results
      const aggregated = this.hookAggregator.aggregateResults(
        results,
        eventName,
      );

      // Process common hook output fields centrally
      this.processCommonHookOutputFields(aggregated);

      // Log hook execution for telemetry
      this.logHookExecution(eventName, input, results, aggregated);

      return aggregated;
    } catch (error) {
      debugLogger.error(`Hook event bus error for ${eventName}: ${error}`);

      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      failClosedResult.errors = [normalizedError];
      if (failClosedResult.finalOutput) {
        failClosedResult.finalOutput.reason = `${failClosedResult.finalOutput.reason}: ${normalizedError.message}`;
      }
      return failClosedResult;
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

  private sanitizeHookInputForTelemetry(
    eventName: HookEventName,
    input: HookInput,
  ): Record<string, unknown> {
    const telemetryInput: Record<string, unknown> = { ...input };

    if (eventName === HookEventName.TodoCreated) {
      delete telemetryInput['todo_content'];
      delete telemetryInput['all_todos'];
      if ('phase' in telemetryInput) {
        telemetryInput['phase'] =
          telemetryInput['phase'] === HookPhase.PostWrite
            ? HookPhase.PostWrite
            : HookPhase.Validation;
      }
    }

    if (eventName === HookEventName.TodoCompleted) {
      delete telemetryInput['todo_content'];
      delete telemetryInput['all_todos'];
      if ('phase' in telemetryInput) {
        telemetryInput['phase'] =
          telemetryInput['phase'] === HookPhase.PostWrite
            ? HookPhase.PostWrite
            : HookPhase.Validation;
      }
    }

    return telemetryInput;
  }

  /**
   * Log hook execution for observability
   */
  private logHookExecution(
    eventName: HookEventName,
    input: HookInput,
    results: HookExecutionResult[],
    aggregated: AggregatedHookResult,
  ): void {
    const failedHooks = results.filter((r) => !r.success);
    const successCount = results.length - failedHooks.length;
    const errorCount = failedHooks.length;

    if (errorCount > 0) {
      const failedNames = failedHooks
        .map((r) => this.getHookNameFromResult(r))
        .join(', ');

      debugLogger.warn(
        `Hook(s) [${failedNames}] failed for event ${eventName}. Check debug logs for more details.`,
      );
    } else {
      debugLogger.debug(
        `Hook execution for ${eventName}: ${successCount} hooks executed successfully, ` +
          `total duration: ${aggregated.totalDuration}ms`,
      );
    }

    const telemetryInput = this.sanitizeHookInputForTelemetry(eventName, input);

    for (const result of results) {
      const hookName = this.getHookNameFromResult(result);
      const hookType = this.getHookTypeFromResult(result);

      const hookCallEvent = new HookCallEvent(
        eventName,
        hookType,
        hookName,
        telemetryInput,
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
  private getHookTypeFromResult(
    result: HookExecutionResult,
  ): 'command' | 'http' | 'function' | 'prompt' {
    return result.hookConfig.type;
  }
}
