/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { statSync } from 'node:fs';
import { splitListEntries } from './hook-matcher.js';
import type { Config } from '../config/config.js';
import { HookRegistry } from './hookRegistry.js';
import { HookRunner } from './hookRunner.js';
import { HookAggregator, type AggregatedHookResult } from './hookAggregator.js';
import { HookPlanner } from './hookPlanner.js';
import {
  HookEventHandler,
  type ManagedHookDispatcher,
} from './hookEventHandler.js';
import type { HookRegistryEntry } from './hookRegistry.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type {
  ContextUsageData,
  DefaultHookOutput,
  HookPhase,
  FileChangeEvent,
} from './types.js';
import { createHookOutput, PermissionMode, HookEventName } from './types.js';
import type {
  SessionStartSource,
  SessionEndReason,
  AgentType,
  PostToolBatchToolCall,
  PreCompactTrigger,
  PostCompactTrigger,
  NotificationType,
  PermissionDeniedReason,
  PermissionSuggestion,
  FunctionHookCallback,
  CommandHookConfig,
  HttpHookConfig,
  PendingAsyncHook,
  PendingAsyncOutput,
  MessagesProvider,
  StopFailureErrorType,
  TodoItem,
  TodoStatus,
  InstructionMemoryType,
  InstructionLoadReason,
} from './types.js';
import { SessionHooksManager } from './sessionHooksManager.js';
import { resolveHookExecutionOwner } from './hook-execution-context.js';
import type { AsyncHookRegistry } from './asyncHookRegistry.js';
import { FileChangedWatcher } from './file-changed-watcher.js';
import { runWithHookExecutionOwner } from './hook-execution-context.js';
import { runWithInvocationContext } from '../utils/invocation-context.js';
import { promptIdContext } from '../utils/promptIdContext.js';

// Re-export MessagesProvider for external use
export type { MessagesProvider } from './types.js';

const debugLogger = createDebugLogger('TRUSTED_HOOKS');

/**
 * Main hook system that coordinates all hook-related functionality
 */

export class HookSystem {
  readonly runtimeId: string = randomUUID();
  private readonly hookRegistry: HookRegistry;
  private readonly hookRunner: HookRunner;
  private readonly hookAggregator: HookAggregator;
  private readonly hookPlanner: HookPlanner;
  private readonly hookEventHandler: HookEventHandler;
  private readonly sessionHooksManager: SessionHooksManager;
  /** Optional provider for automatically fetching conversation history */
  private messagesProvider?: MessagesProvider;
  private fileWatcher?: FileChangedWatcher;
  private dynamicWatchPaths: string[] = [];
  private fileWatchingAllowed = false;
  private fileWatchingSessionId?: string;
  private fileWatchingEndedSession?: { sessionId: string };
  private fileWatcherClosing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly config: Config,
    private readonly managedDispatcher?: ManagedHookDispatcher,
  ) {
    // Get allowed HTTP URLs from config
    const allowedHttpUrls = config.getAllowedHttpHookUrls();

    // Initialize components
    this.hookRegistry = new HookRegistry(config);
    this.hookRunner = new HookRunner(allowedHttpUrls, config); // Pass config for prompt hooks
    this.hookAggregator = new HookAggregator();
    this.hookPlanner = new HookPlanner(this.hookRegistry);
    this.sessionHooksManager = new SessionHooksManager((sessionId) => {
      if (sessionId === this.config.getSessionId())
        this.refreshFileWatchingInBackground();
    });
    this.hookEventHandler = new HookEventHandler(
      config,
      this.hookPlanner,
      this.hookRunner,
      this.hookAggregator,
      this.sessionHooksManager,
      undefined,
      this.runtimeId,
      this.managedDispatcher,
    );
  }

  /**
   * Initialize the hook system
   */
  async initialize(options?: { skipFileWatching?: boolean }): Promise<void> {
    if (this.managedDispatcher) return;
    await this.hookRegistry.initialize();
    this.fileWatchingAllowed = !options?.skipFileWatching;
    this.fileWatchingSessionId = this.config.getSessionId();
    await this.refreshFileWatching();
    debugLogger.debug('Hook system initialized successfully');
  }

  async reload(): Promise<void> {
    if (this.managedDispatcher) return;
    await this.hookRegistry.reloadConfiguredHooks();
    await this.refreshFileWatching();
    debugLogger.debug('Hook system reloaded successfully');
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
    this.refreshFileWatchingInBackground();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stopFileWatching();
  }

  private stopFileWatching(): Promise<void> {
    this.fileWatchingSessionId = undefined;
    this.dynamicWatchPaths = [];
    const watcher = this.fileWatcher;
    this.fileWatcher = undefined;
    if (watcher) {
      this.fileWatcherClosing = Promise.all([
        this.fileWatcherClosing,
        watcher.close(),
      ]).then(() => undefined);
    }
    return this.fileWatcherClosing;
  }

  async refreshFileWatchingForWorkingDirectory(): Promise<void> {
    await this.refreshFileWatching();
  }

  private refreshFileWatchingInBackground(): void {
    void this.refreshFileWatching().catch((error: unknown) => {
      debugLogger.warn(`Failed to update FileChanged watch paths: ${error}`);
    });
  }

  private async refreshFileWatching(
    result?: AggregatedHookResult,
    eventName?: HookEventName,
  ): Promise<void> {
    const sessionId = this.config.getSessionId();
    if (
      !this.fileWatchingAllowed ||
      this.closed ||
      this.fileWatchingEndedSession?.sessionId === sessionId
    )
      return;
    if (
      this.managedDispatcher ||
      this.config.getSessionExecutionEngine?.() === 'managed' ||
      this.config.getExecutionEnvironment?.() ||
      this.config.getShellExecutionSandbox?.()
    ) {
      return;
    }
    if (this.fileWatchingSessionId !== sessionId) {
      await this.stopFileWatching();
      if (
        this.closed ||
        sessionId !== this.config.getSessionId() ||
        this.fileWatchingEndedSession?.sessionId === sessionId
      )
        return;
      this.fileWatchingSessionId = sessionId;
    }
    for (const output of result?.allOutputs ?? []) {
      const specific = output.hookSpecificOutput;
      if (!specific || specific['hookEventName'] !== eventName) continue;
      const paths = specific['watchPaths'];
      if (paths === undefined) continue;
      if (
        !Array.isArray(paths) ||
        !paths.every(
          (value: unknown): value is string =>
            typeof value === 'string' && path.isAbsolute(value),
        )
      ) {
        debugLogger.warn('FileChanged watchPaths must be absolute paths');
        continue;
      }
      this.dynamicWatchPaths = paths;
    }
    const entries = this.hookRegistry
      .getHooksForEvent(HookEventName.FileChanged)
      .filter(
        (entry) =>
          entry.agentScope === undefined && (entry.isSourceTrusted?.() ?? true),
      );
    const sessionEntries = this.sessionHooksManager
      .getHooksForEvent(this.config.getSessionId(), HookEventName.FileChanged)
      .filter((entry) => !entry.trustGated || this.config.isTrustedFolder());
    const staticFiles = [...entries, ...sessionEntries].flatMap((entry) =>
      (/^[\^(]/.test((entry.matcher ?? '').trimStart())
        ? []
        : splitListEntries(entry.matcher ?? '')
      )
        .map((filename) => filename.trim())
        .filter(
          (filename) =>
            filename !== '' &&
            !/[\\^$|?*+()[\]{}]/.test(filename) &&
            path.basename(filename) === filename &&
            filename !== '.' &&
            filename !== '..',
        )
        .map((filename) => path.resolve(this.config.getWorkingDir(), filename))
        .filter((filename) => {
          try {
            return statSync(filename).isFile();
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ENOENT';
          }
        }),
    );
    const paths =
      this.config.getDisableAllHooks?.() ||
      entries.length + sessionEntries.length === 0
        ? []
        : [...this.dynamicWatchPaths, ...staticFiles];
    if (!this.fileWatcher && paths.length > 0) {
      const owner = Object.freeze({
        runtimeId: this.runtimeId,
        sessionId: this.config.getSessionId(),
        agentId: null,
      });
      this.fileWatcher = new FileChangedWatcher((filePath, event, signal) =>
        runWithInvocationContext(undefined, () =>
          promptIdContext.exit(() =>
            runWithHookExecutionOwner(owner, async () => {
              if (owner.sessionId !== this.config.getSessionId()) return;
              await this.fireFileChangedEvent(filePath, event, signal);
            }),
          ),
        ),
      );
    }
    const dynamicPaths = new Set(
      this.dynamicWatchPaths.map((file) => path.resolve(file)),
    );
    await this.fileWatcher?.setPaths(
      paths,
      staticFiles.filter((file) => !dynamicPaths.has(file)),
    );
  }

  async fireFileChangedEvent(
    filePath: string,
    event: FileChangeEvent,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    const sessionId = this.config.getSessionId();
    const result = await this.hookEventHandler.fireFileChangedEvent(
      filePath,
      event,
      signal,
    );
    if (!signal?.aborted && sessionId === this.config.getSessionId()) {
      await this.refreshFileWatching(result, HookEventName.FileChanged);
    }
    return result;
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
  hasHooksForEvent(eventName: string, sessionId?: string): boolean {
    if (this.managedDispatcher)
      return this.managedDispatcher.hasHooksForEvent(eventName);
    const event = eventName as HookEventName;
    if (this.hookRegistry.getHooksForEvent(event).length > 0) return true;
    return this.sessionHooksManager.hasHooksForEvent(event, sessionId);
  }

  hasHooksMatchingTool(
    eventName: string,
    toolName: string,
    sessionId?: string,
  ): boolean {
    if (this.managedDispatcher)
      return this.managedDispatcher.hasHooksForEvent(eventName);
    const event = eventName as HookEventName;
    const owner = resolveHookExecutionOwner(
      this.runtimeId,
      sessionId ?? this.config.getSessionId(),
    );
    return Boolean(
      this.hookPlanner.createExecutionPlan(event, { toolName }, owner)
        ?.hookConfigs.length ||
        this.sessionHooksManager
          .getMatchingHooks(owner.sessionId, event, toolName)
          .some((entry) => !entry.trustGated || this.config.isTrustedFolder()),
    );
  }

  isManaged(): boolean {
    return this.managedDispatcher !== undefined;
  }

  async fireUserPromptSubmitEvent(
    prompt: string,
    signal?: AbortSignal,
    submittedPrompt?: string,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireUserPromptSubmitEvent(
      prompt,
      signal,
      submittedPrompt,
    );
    return result.finalOutput
      ? createHookOutput('UserPromptSubmit', result.finalOutput)
      : undefined;
  }

  async fireInstructionsLoadedEvent(
    filePath: string,
    memoryType: InstructionMemoryType,
    loadReason: InstructionLoadReason,
    options: {
      triggerFilePath?: string;
      parentFilePath?: string;
    } = {},
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireInstructionsLoadedEvent(
      filePath,
      memoryType,
      loadReason,
      options,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('InstructionsLoaded', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a UserPromptExpansion event after a slash command returns a prompt and
   * before that expanded prompt is submitted to the model.
   */
  async fireUserPromptExpansionEvent(
    commandName: string,
    commandArgs: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireUserPromptExpansionEvent(
      commandName,
      commandArgs,
      prompt,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('UserPromptExpansion', result.finalOutput)
      : undefined;
  }

  async fireStopEvent(
    stopHookActive: boolean = false,
    lastAssistantMessage: string = '',
    contextUsage?: ContextUsageData,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireStopEvent(
      stopHookActive,
      lastAssistantMessage,
      contextUsage,
      signal,
    );
  }

  /**
   * Fire a MessageDisplay event - called repeatedly as the assistant's reply streams
   */
  async fireMessageDisplayEvent(
    messageId: string,
    displayedText: string,
    isFinal: boolean,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireMessageDisplayEvent(
      messageId,
      displayedText,
      isFinal,
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
    const sessionId = this.config.getSessionId();
    const endedSession = this.fileWatchingEndedSession;
    if (
      this.fileWatchingSessionId !== undefined &&
      this.fileWatchingSessionId !== sessionId
    ) {
      await this.stopFileWatching();
    }
    await this.fileWatcherClosing;
    if (
      this.closed ||
      sessionId !== this.config.getSessionId() ||
      this.fileWatchingEndedSession !== endedSession
    )
      return undefined;
    const result = await this.hookEventHandler.fireSessionStartEvent(
      source,
      model,
      permissionMode,
      agentType,
      signal,
    );
    if (
      !signal?.aborted &&
      !this.closed &&
      sessionId === this.config.getSessionId() &&
      this.fileWatchingEndedSession === endedSession
    ) {
      this.fileWatchingEndedSession = undefined;
      this.fileWatchingAllowed = true;
      this.fileWatchingSessionId = sessionId;
      await this.refreshFileWatching(result, HookEventName.SessionStart);
    }
    return result.finalOutput
      ? createHookOutput('SessionStart', result.finalOutput)
      : undefined;
  }

  async fireSessionEndEvent(
    reason: SessionEndReason,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    this.fileWatchingEndedSession = { sessionId: this.config.getSessionId() };
    const ended = this.hookEventHandler.fireSessionEndEvent(reason, signal);
    const stopped = this.stopFileWatching();
    const result = await ended;
    await stopped;
    return result.finalOutput
      ? createHookOutput('SessionEnd', result.finalOutput)
      : undefined;
  }

  async fireSessionDeleteEvent(
    deletedSessionId: string,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSessionDeleteEvent(
      deletedSessionId,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('SessionDelete', result.finalOutput)
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
    tool_call_id?: string,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePreToolUseEvent(
      toolName,
      toolInput,
      toolUseId,
      permissionMode,
      signal,
      tool_call_id,
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
    tool_call_id?: string,
    durationMs?: number,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePostToolUseEvent(
      toolName,
      toolInput,
      toolResponse,
      toolUseId,
      permissionMode,
      signal,
      tool_call_id,
      durationMs,
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
    tool_call_id?: string,
    durationMs?: number,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePostToolUseFailureEvent(
      toolUseId,
      toolName,
      toolInput,
      errorMessage,
      isInterrupt,
      permissionMode,
      signal,
      tool_call_id,
      durationMs,
    );
    return result.finalOutput
      ? createHookOutput('PostToolUseFailure', result.finalOutput)
      : undefined;
  }

  /**
   * Fire a PostToolBatch event - called once after a tool-call batch resolves
   */
  async firePostToolBatchEvent(
    toolCalls: PostToolBatchToolCall[],
    permissionMode: PermissionMode = PermissionMode.Default,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePostToolBatchEvent(
      toolCalls,
      permissionMode,
      signal,
    );
    return result.finalOutput
      ? createHookOutput('PostToolBatch', result.finalOutput)
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
   * Fire a PermissionDenied event
   */
  async firePermissionDeniedEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    reason: PermissionDeniedReason,
    signal?: AbortSignal,
    tool_call_id?: string,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.firePermissionDeniedEvent(
      toolName,
      toolInput,
      toolUseId,
      reason,
      signal,
      tool_call_id,
    );
    return result.finalOutput
      ? createHookOutput('PermissionDenied', result.finalOutput)
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
    const id = this.sessionHooksManager.addFunctionHook(
      sessionId,
      event,
      matcher,
      callback,
      errorMessage,
      options,
    );
    return id;
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
    options?: {
      sequential?: boolean;
      skillRoot?: string;
      trustGated?: boolean;
    },
  ): string {
    const id = this.sessionHooksManager.addSessionHook(
      sessionId,
      event,
      matcher,
      hook,
      options,
    );
    return id;
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
    const removed = this.sessionHooksManager.removeFunctionHook(
      sessionId,
      event,
      hookId,
    );
    return removed;
  }

  /**
   * Remove a hook by ID (searches all events)
   * @param sessionId Session ID
   * @param hookId Hook ID to remove
   * @returns True if hook was found and removed
   */
  removeSessionHook(sessionId: string, hookId: string): boolean {
    const removed = this.sessionHooksManager.removeHook(sessionId, hookId);
    return removed;
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
