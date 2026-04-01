/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { HookRegistry } from './hookRegistry.js';
import { HookRunner } from './hookRunner.js';
import { HookAggregator } from './hookAggregator.js';
import { HookPlanner } from './hookPlanner.js';
import { HookEventHandler } from './hookEventHandler.js';
import type { HookRegistryEntry } from './hookRegistry.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { DefaultHookOutput } from './types.js';
import { createHookOutput } from './types.js';
import type {
  SessionStartSource,
  SessionEndReason,
  AgentType,
  PermissionMode,
  PreCompactTrigger,
  NotificationType,
  PermissionSuggestion,
  HookEventName,
} from './types.js';

const debugLogger = createDebugLogger('TRUSTED_HOOKS');

/**
 * Main hook system that coordinates all hook-related functionality
 */

export class HookSystem {
  private readonly hookRegistry: HookRegistry;
  private readonly hookRunner: HookRunner;
  private readonly hookAggregator: HookAggregator;
  private readonly hookPlanner: HookPlanner;
  private readonly hookEventHandler: HookEventHandler;

  constructor(config: Config) {
    // Initialize components
    this.hookRegistry = new HookRegistry(config);
    this.hookRunner = new HookRunner();
    this.hookAggregator = new HookAggregator();
    this.hookPlanner = new HookPlanner(this.hookRegistry);
    this.hookEventHandler = new HookEventHandler(
      config,
      this.hookPlanner,
      this.hookRunner,
      this.hookAggregator,
    );
  }

  /**
   * Initialize the hook system
   */
  async initialize(): Promise<void> {
    await this.hookRegistry.initialize();
    debugLogger.debug('Hook system initialized successfully');
  }

  /**
   * Get the hook event bus for firing events
   */
  getEventHandler(): HookEventHandler {
    return this.hookEventHandler;
  }

  /**
   * Get hook registry for management operations
   */
  getRegistry(): HookRegistry {
    return this.hookRegistry;
  }

  /**
   * Enable or disable a hook
   */
  setHookEnabled(hookName: string, enabled: boolean): void {
    this.hookRegistry.setHookEnabled(hookName, enabled);
  }

  /**
   * Get all registered hooks for display/management
   */
  getAllHooks(): HookRegistryEntry[] {
    return this.hookRegistry.getAllHooks();
  }

  /**
   * Check if there are any enabled hooks registered for a specific event.
   * This is a fast-path check to avoid expensive MessageBus round-trips
   * when no hooks are configured for a given event.
   */
  hasHooksForEvent(eventName: string): boolean {
    return (
      this.hookRegistry.getHooksForEvent(eventName as HookEventName).length > 0
    );
  }

  async fireUserPromptSubmitEvent(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireUserPromptSubmitEvent(
      prompt,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('UserPromptSubmit', result.finalOutput)
      : undefined;
  }

  async fireStopEvent(
    stopHookActive: boolean = false,
    lastAssistantMessage: string = '',
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireStopEvent(
      stopHookActive,
      lastAssistantMessage,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('Stop', result.finalOutput)
      : undefined;
  }

  async fireSessionStartEvent(
    source: SessionStartSource,
    model: string,
    permissionMode?: PermissionMode,
    agentType?: AgentType,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSessionStartEvent(
      source,
      model,
      permissionMode,
      agentType,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('SessionStart', result.finalOutput)
      : undefined;
  }

  async fireSessionEndEvent(
    reason: SessionEndReason,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSessionEndEvent(
      reason,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('SessionEnd', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a PreToolUse event - called before tool execution
   */
  async firePreToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    permissionMode: PermissionMode,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePreToolUseEvent(
      toolName,
      toolInput,
      toolUseId,
      permissionMode,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('PreToolUse', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a PostToolUse event - called after successful tool execution
   */
  async firePostToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown>,
    toolUseId: string,
    permissionMode: PermissionMode,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePostToolUseEvent(
      toolName,
      toolInput,
      toolResponse,
      toolUseId,
      permissionMode,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('PostToolUse', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a PostToolUseFailure event - called when tool execution fails
   */
  async firePostToolUseFailureEvent(
    toolUseId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    errorMessage: string,
    isInterrupt?: boolean,
    permissionMode?: PermissionMode,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePostToolUseFailureEvent(
      toolUseId,
      toolName,
      toolInput,
      errorMessage,
      isInterrupt,
      permissionMode,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('PostToolUseFailure', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a PreCompact event - called before conversation compaction
   */
  async firePreCompactEvent(
    trigger: PreCompactTrigger,
    customInstructions: string = '',
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePreCompactEvent(
      trigger,
      customInstructions,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('PreCompact', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a Notification event
   */
  async fireNotificationEvent(
    message: string,
    notificationType: NotificationType,
    title?: string,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireNotificationEvent(
      message,
      notificationType,
      title,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('Notification', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a SubagentStart event - called when a subagent is spawned
   */
  async fireSubagentStartEvent(
    agentId: string,
    agentType: AgentType | string,
    permissionMode: PermissionMode,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSubagentStartEvent(
      agentId,
      agentType,
      permissionMode,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('SubagentStart', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a SubagentStop event - called when a subagent finishes
   */
  async fireSubagentStopEvent(
    agentId: string,
    agentType: AgentType | string,
    agentTranscriptPath: string,
    lastAssistantMessage: string,
    stopHookActive: boolean,
    permissionMode: PermissionMode,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSubagentStopEvent(
      agentId,
      agentType,
      agentTranscriptPath,
      lastAssistantMessage,
      stopHookActive,
      permissionMode,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('SubagentStop', result.finalOutput)
      : undefined;
  }

  // ─── Team Lifecycle Hooks ────────────────────────────────────

  /**
   * Fire a TeammateIdle event
   */
  async fireTeammateIdleEvent(
    agentId: string,
    agentName: string,
    resultSummary: string,
    success: boolean,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireTeammateIdleEvent(
      agentId,
      agentName,
      resultSummary,
      success,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('TeammateIdle', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a TaskCreated event
   */
  async fireTaskCreatedEvent(
    taskId: string,
    taskTitle: string,
    taskDescription: string | undefined,
    createdBy: string,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireTaskCreatedEvent(
      taskId,
      taskTitle,
      taskDescription,
      createdBy,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('TaskCreated', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a TaskCompleted event
   */
  async fireTaskCompletedEvent(
    taskId: string,
    taskTitle: string,
    completedBy: string,
    output?: string,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireTaskCompletedEvent(
      taskId,
      taskTitle,
      completedBy,
      output,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('TaskCompleted', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a PermissionRequest event
   */
  async firePermissionRequestEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    permissionMode: PermissionMode,
    permissionSuggestions?: PermissionSuggestion[],
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePermissionRequestEvent(
      toolName,
      toolInput,
      permissionMode,
      permissionSuggestions,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('PermissionRequest', result.finalOutput)
      : undefined;
  }
}
