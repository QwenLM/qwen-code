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
import type { DefaultHookOutput, McpToolContext } from './types.js';
import { createHookOutput } from './types.js';
import type {
  SessionStartSource,
  SessionEndReason,
  PreCompactTrigger,
  AgentType,
  PermissionSuggestion,
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

  async fireUserPromptSubmitEvent(
    prompt: string,
  ): Promise<DefaultHookOutput | undefined> {
    const result =
      await this.hookEventHandler.fireUserPromptSubmitEvent(prompt);
    return result.finalOutput
      ? createHookOutput('UserPromptSubmit', result.finalOutput)
      : undefined;
  }

  async fireStopEvent(
    stopHookActive: boolean = false,
    lastAssistantMessage: string = '',
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireStopEvent(
      stopHookActive,
      lastAssistantMessage,
    );
    return result.finalOutput
      ? createHookOutput('Stop', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a PreToolUse event - called before tool execution
   */
  async firePreToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    _mcpContext?: McpToolContext,
    _originalRequestName?: string,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePreToolUseEvent(
      toolName,
      toolInput,
      toolUseId,
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
    mcpContext?: McpToolContext,
    originalRequestName?: string,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePostToolUseEvent(
      toolName,
      toolInput,
      toolResponse,
      toolUseId,
      mcpContext,
      originalRequestName,
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
    errorType?: string,
    isInterrupt?: boolean,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePostToolUseFailureEvent(
      toolUseId,
      toolName,
      toolInput,
      errorMessage,
      errorType,
      isInterrupt,
    );
    return result.finalOutput
      ? createHookOutput('PostToolUseFailure', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a Notification event - called when a notification is generated
   */
  async fireNotificationEvent(
    notificationType: string,
    message: string,
    title?: string,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireNotificationEvent(
      notificationType,
      message,
      title,
    );
    return result.finalOutput
      ? createHookOutput('Notification', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a SessionStart event - called when a new session starts or is resumed
   */
  async fireSessionStartEvent(
    source: SessionStartSource,
    model?: string,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSessionStartEvent(
      source,
      model,
    );
    return result.finalOutput
      ? createHookOutput('SessionStart', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a SessionEnd event - called when a session is ending
   */
  async fireSessionEndEvent(
    reason: SessionEndReason,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSessionEndEvent(reason);
    return result.finalOutput
      ? createHookOutput('SessionEnd', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a PreCompact event - called before context compaction
   */
  async firePreCompactEvent(
    trigger: PreCompactTrigger,
    customInstructions?: string,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePreCompactEvent(
      trigger,
      customInstructions,
    );
    return result.finalOutput
      ? createHookOutput('PreCompact', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a SubagentStart event - called when a subagent is started
   */
  async fireSubagentStartEvent(
    agentId: string,
    agentType: AgentType,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSubagentStartEvent(
      agentId,
      agentType,
    );
    return result.finalOutput
      ? createHookOutput('SubagentStart', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a SubagentStop event - called when a subagent is stopping
   */
  async fireSubagentStopEvent(
    agentId: string,
    agentType: AgentType,
    agentTranscriptPath: string,
    lastAssistantMessage: string,
    stopHookActive: boolean = false,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSubagentStopEvent(
      agentId,
      agentType,
      agentTranscriptPath,
      lastAssistantMessage,
      stopHookActive,
    );
    return result.finalOutput
      ? createHookOutput('SubagentStop', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a PermissionRequest event - called when a permission dialog is displayed
   */
  async firePermissionRequestEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    permissionSuggestions?: PermissionSuggestion[],
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePermissionRequestEvent(
      toolName,
      toolInput,
      permissionSuggestions,
    );
    return result.finalOutput
      ? createHookOutput('PermissionRequest', result.finalOutput)
      : undefined;
  }
}
