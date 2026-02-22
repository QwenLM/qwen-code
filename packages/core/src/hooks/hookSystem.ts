/**
 * @license
 * Copyright 2025 Google LLC
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
import type {
  SessionStartSource,
  SessionEndReason,
  PreCompactTrigger,
  DefaultHookOutput,
  McpToolContext,
} from './types.js';
import { NotificationType, createHookOutput } from './types.js';
import type { AggregatedHookResult } from './hookAggregator.js';
import type { ToolCallConfirmationDetails } from '../tools/tools.js';

const debugLogger = createDebugLogger('TRUSTED_HOOKS');

/**
 * Main hook system that coordinates all hook-related functionality
 */

/**
 * Converts ToolCallConfirmationDetails to a serializable format for hooks.
 * Excludes function properties (onConfirm, ideConfirmation) that can't be serialized.
 */
function toSerializableDetails(
  details: ToolCallConfirmationDetails,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: details.type,
    title: details.title,
  };

  switch (details.type) {
    case 'edit':
      return {
        ...base,
        fileName: details.fileName,
        filePath: details.filePath,
        fileDiff: details.fileDiff,
        originalContent: details.originalContent,
        newContent: details.newContent,
        isModifying: details.isModifying,
      };
    case 'exec':
      return {
        ...base,
        command: details.command,
        rootCommand: details.rootCommand,
      };
    case 'mcp':
      return {
        ...base,
        serverName: details.serverName,
        toolName: details.toolName,
        toolDisplayName: details.toolDisplayName,
      };
    case 'info':
      return {
        ...base,
        prompt: details.prompt,
        urls: details.urls,
      };
    default:
      return base;
  }
}

/**
 * Gets the message to display in the notification hook for tool confirmation.
 */
function getNotificationMessage(
  confirmationDetails: ToolCallConfirmationDetails,
): string {
  switch (confirmationDetails.type) {
    case 'edit':
      return `Tool ${confirmationDetails.title} requires editing`;
    case 'exec':
      return `Tool ${confirmationDetails.title} requires execution`;
    case 'mcp':
      return `Tool ${confirmationDetails.title} requires MCP`;
    case 'info':
      return `Tool ${confirmationDetails.title} requires information`;
    default:
      return `Tool requires confirmation`;
  }
}

export class HookSystem {
  private readonly hookRegistry: HookRegistry;
  private readonly hookRunner: HookRunner;
  private readonly hookAggregator: HookAggregator;
  private readonly hookPlanner: HookPlanner;
  private readonly hookEventHandler: HookEventHandler;

  constructor(config: Config) {
    // Initialize components
    this.hookRegistry = new HookRegistry(config);
    this.hookRunner = new HookRunner(config);
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
   * Fire hook events directly
   */
  async fireSessionStartEvent(
    source: SessionStartSource,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSessionStartEvent(source);
    return result.finalOutput
      ? createHookOutput('SessionStart', result.finalOutput)
      : undefined;
  }

  async fireSessionEndEvent(
    reason: SessionEndReason,
  ): Promise<AggregatedHookResult | undefined> {
    return this.hookEventHandler.fireSessionEndEvent(reason);
  }

  async firePreCompactEvent(
    trigger: PreCompactTrigger,
  ): Promise<AggregatedHookResult | undefined> {
    return this.hookEventHandler.firePreCompactEvent(trigger);
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
    prompt: string,
    response: string,
    stopHookActive: boolean = false,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireStopEvent(
      prompt,
      response,
      stopHookActive,
    );
    return result.finalOutput
      ? createHookOutput('Stop', result.finalOutput)
      : undefined;
  }

  async firePreToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    mcpContext?: McpToolContext,
  ): Promise<DefaultHookOutput | undefined> {
    try {
      const result = await this.hookEventHandler.firePreToolUseEvent(
        toolName,
        toolInput,
        mcpContext,
      );
      return result.finalOutput
        ? createHookOutput('PreToolUse', result.finalOutput)
        : undefined;
    } catch (error) {
      debugLogger.debug(`PreToolUseEvent failed for ${toolName}:`, error);
      return undefined;
    }
  }

  async firePostToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: {
      llmContent: unknown;
      returnDisplay: unknown;
      error: unknown;
    },
    mcpContext?: McpToolContext,
  ): Promise<DefaultHookOutput | undefined> {
    try {
      const result = await this.hookEventHandler.firePostToolUseEvent(
        toolName,
        toolInput,
        toolResponse as Record<string, unknown>,
        mcpContext,
      );
      return result.finalOutput
        ? createHookOutput('PostToolUse', result.finalOutput)
        : undefined;
    } catch (error) {
      debugLogger.debug(`PostToolUseEvent failed for ${toolName}:`, error);
      return undefined;
    }
  }

  async fireToolNotificationEvent(
    confirmationDetails: ToolCallConfirmationDetails,
  ): Promise<void> {
    try {
      const message = getNotificationMessage(confirmationDetails);
      const serializedDetails = toSerializableDetails(confirmationDetails);

      await this.hookEventHandler.fireNotificationEvent(
        NotificationType.ToolPermission,
        message,
        serializedDetails,
      );
    } catch (error) {
      debugLogger.debug(
        `NotificationEvent failed for ${confirmationDetails.title}:`,
        error,
      );
    }
  }
}
