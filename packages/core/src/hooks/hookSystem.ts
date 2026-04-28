/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { HookRegistry } from './hookRegistry.js';
import { HookRunner } from './hookRunner.js';
import { HookAggregator, type AggregatedHookResult } from './hookAggregator.js';
import { HookPlanner } from './hookPlanner.js';
import { HookEventHandler } from './hookEventHandler.js';
import type { HookRegistryEntry } from './hookRegistry.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { DefaultHookOutput , HookPhase } from './types.js';
import { createHookOutput } from './types.js';
import type {
  SessionStartSource,
  SessionEndReason,
  AgentType,
  PermissionMode,
  PreCompactTrigger,
  PostCompactTrigger,
  NotificationType,
  PermissionSuggestion,
  HookEventName,
  FunctionHookCallback,
  CommandHookConfig,
  HttpHookConfig,
  PendingAsyncHook,
  PendingAsyncOutput,
  MessagesProvider,
  StopFailureErrorType,
  TodoItem,
  TodoStatus,
} from './types.js';
import { SessionHooksManager } from './sessionHooksManager.js';
import type { AsyncHookRegistry } from './asyncHookRegistry.js';

// Re-export MessagesProvider for external use
export type { MessagesProvider } from './types.js';

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
  private readonly sessionHooksManager: SessionHooksManager;
  /** Optional provider for automatically fetching conversation history */
  private messagesProvider?: MessagesProvider;

  constructor(config: Config) {
    // Get allowed HTTP URLs from config
    const allowedHttpUrls = config.getAllowedHttpHookUrls();

    // Initialize components
    this.hookRegistry = new HookRegistry(config);
    this.hookRunner = new HookRunner(allowedHttpUrls);
    this.hookAggregator = new HookAggregator();
    this.hookPlanner = new HookPlanner(this.hookRegistry);
    this.sessionHooksManager = new SessionHooksManager();
    this.hookEventHandler = new HookEventHandler(
      config,
      this.hookPlanner,
      this.hookRunner,
      this.hookAggregator,
      this.sessionHooksManager,
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
   * Set the messages provider for automatic conversation history passing
   * to function hooks during execution
   */
  setMessagesProvider(provider: MessagesProvider): void {
    this.messagesProvider = provider;
    this.hookEventHandler.setMessagesProvider(provider);
  }

  /**
   * Get the current messages provider
   */
  getMessagesProvider(): MessagesProvider | undefined {
    return this.messagesProvider;
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
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireStopEvent(
      stopHookActive,
      lastAssistantMessage,
      signal,
    );
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

  /**
   * Fire a StopFailure event - called when an API error ends the turn
   * Fire-and-forget: output and exit codes are ignored
   */
  async fireStopFailureEvent(
    error: StopFailureErrorType,
    errorDetails?: string,
    lastAssistantMessage?: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireStopFailureEvent(
      error,
      errorDetails,
      lastAssistantMessage,
      signal,
    );
  }

  /**
   * Fire a PostCompact event - called after conversation compaction completes
   */
  async firePostCompactEvent(
    trigger: PostCompactTrigger,
    compactSummary: string,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePostCompactEvent(
      trigger,
      compactSummary,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('PostCompact', result.finalOutput)
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
    return this.hookEventHandler.fireTodoCreatedEvent(
      todoId,
      todoContent,
      todoStatus,
      allTodos,
      phase,
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
    return this.hookEventHandler.fireTodoCompletedEvent(
      todoId,
      todoContent,
      previousStatus,
      allTodos,
      phase,
      signal,
    );
  }

  // ==================== Session Hooks API ====================

  /**
   * Add a function hook for a session
   * @param sessionId Session ID
   * @param event Hook event name
   * @param matcher Matcher pattern (e.g., 'Bash', '*', 'Write|Edit', or regex)
   * @param callback Function callback to execute
   * @param errorMessage Error message to display on failure
   * @param options Additional options
   * @returns Hook ID for later removal
   */
  addFunctionHook(
    sessionId: string,
    event: HookEventName,
    matcher: string,
    callback: FunctionHookCallback,
    errorMessage: string,
    options?: {
      timeout?: number;
      id?: string;
      name?: string;
      description?: string;
      statusMessage?: string;
      skillRoot?: string;
    },
  ): string {
    return this.sessionHooksManager.addFunctionHook(
      sessionId,
      event,
      matcher,
      callback,
      errorMessage,
      options,
    );
  }

  /**
   * Add a command or HTTP hook for a session
   * @param sessionId Session ID
   * @param event Hook event name
   * @param matcher Matcher pattern
   * @param hook Hook configuration (command or HTTP)
   * @param options Additional options
   * @returns Hook ID
   */
  addSessionHook(
    sessionId: string,
    event: HookEventName,
    matcher: string,
    hook: CommandHookConfig | HttpHookConfig,
    options?: { sequential?: boolean },
  ): string {
    return this.sessionHooksManager.addSessionHook(
      sessionId,
      event,
      matcher,
      hook,
      options,
    );
  }

  /**
   * Remove a function hook by ID
   * @param sessionId Session ID
   * @param event Hook event name
   * @param hookId Hook ID to remove
   * @returns True if hook was found and removed
   */
  removeFunctionHook(
    sessionId: string,
    event: HookEventName,
    hookId: string,
  ): boolean {
    return this.sessionHooksManager.removeFunctionHook(
      sessionId,
      event,
      hookId,
    );
  }

  /**
   * Remove a hook by ID (searches all events)
   * @param sessionId Session ID
   * @param hookId Hook ID to remove
   * @returns True if hook was found and removed
   */
  removeSessionHook(sessionId: string, hookId: string): boolean {
    return this.sessionHooksManager.removeHook(sessionId, hookId);
  }

  /**
   * Check if a session has any hooks registered
   * @param sessionId Session ID
   * @returns True if session has hooks
   */
  hasSessionHooks(sessionId: string): boolean {
    return this.sessionHooksManager.hasSessionHooks(sessionId);
  }

  /**
   * Clear all hooks for a session
   * @param sessionId Session ID
   */
  clearSessionHooks(sessionId: string): void {
    this.sessionHooksManager.clearSessionHooks(sessionId);
    // Also clear async hooks for this session
    this.getAsyncRegistry().clearSession(sessionId);
  }

  /**
   * Get the session hooks manager
   */
  getSessionHooksManager(): SessionHooksManager {
    return this.sessionHooksManager;
  }

  // ==================== Async Hooks API ====================

  /**
   * Get the async hook registry
   */
  getAsyncRegistry(): AsyncHookRegistry {
    return this.hookRunner.getAsyncRegistry();
  }

  /**
   * Get all pending async hooks
   */
  getPendingAsyncHooks(): PendingAsyncHook[] {
    return this.getAsyncRegistry().getPendingHooks();
  }

  /**
   * Get pending async hooks for a specific session
   */
  getPendingAsyncHooksForSession(sessionId: string): PendingAsyncHook[] {
    return this.getAsyncRegistry().getPendingHooksForSession(sessionId);
  }

  /**
   * Get and clear pending async output for delivery to the next turn
   */
  getPendingAsyncOutput(): PendingAsyncOutput {
    return this.getAsyncRegistry().getPendingOutput();
  }

  /**
   * Check if there are any pending async outputs
   */
  hasPendingAsyncOutput(): boolean {
    return this.getAsyncRegistry().hasPendingOutput();
  }

  /**
   * Check if there are any running async hooks
   */
  hasRunningAsyncHooks(): boolean {
    return this.getAsyncRegistry().hasRunningHooks();
  }

  /**
   * Check for timed out async hooks and mark them
   */
  checkAsyncHookTimeouts(): void {
    this.getAsyncRegistry().checkTimeouts();
  }

  /**
   * Update allowed HTTP hook URLs
   */
  updateAllowedHttpUrls(allowedUrls: string[]): void {
    this.hookRunner.updateAllowedHttpUrls(allowedUrls);
  }
}
