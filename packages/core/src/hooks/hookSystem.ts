/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CoreEvent, coreEvents } from '../utils/events.js';
import type { Config } from '../config/config.js';
import { HookRegistry, type HookRegistryEntry } from './hookRegistry.js';
import { HookRunner } from './hookRunner.js';
import type { ImagePrepareRequest } from './imagePrepare.js';
import {
  HookAggregator,
  EMPTY_FAILED_HOOK_RESULT,
  buildPreToolUseDenyResult,
  type AggregatedHookResult,
} from './hookAggregator.js';
import { HookPlanner } from './hookPlanner.js';
import { HookEventHandler } from './hookEventHandler.js';
import { runLogger } from '../utils/runLogger.js';
import { initAutoDream } from '../services/autoDream/index.js';
import { createFileChangedWatcher } from './fileChangedWatcher.js';
import {
  NotificationType,
  type SessionStartSource,
  type SetupTrigger,
  type SessionEndReason,
  type PreCompactTrigger,
  type DefaultHookOutput,
  type McpToolContext,
  type HookConfig,
  HookEventName,
  type ConfigSource,
  type ConfigChangeSource,
  type InstructionsLoadReason,
  type FileChangeEventType,
  type ElicitationAction,
  type StopFailureErrorType,
  type StopFailureOptions,
  type PermissionSuggestion,
  type PostToolUseInput,
  type QueryEndReason,
} from './types.js';

/**
 * Main hook system that coordinates all hook-related functionality
 */

/**
 * SessionEnd hook timeout bounds. Clamps so that shutdown
 * waits at least 1.5s (best-effort cleanup) but never more than 60s (UX bound),
 * regardless of what a hook declares in its `timeout` field.
 */
const SESSION_END_HOOK_TIMEOUT_MIN_MS = 1500;
const SESSION_END_HOOK_TIMEOUT_MAX_MS = 60_000;
const QUERY_END_HOOK_TIMEOUT_MIN_MS = 5_000;
const QUERY_END_HOOK_TIMEOUT_MAX_MS = 15_000;

export class HookSystem {
  private static readonly runnerFactories: Array<{
    factory: (config: Config) => HookRunner;
  }> = [];

  /** Install the runner for future sessions in this application process. */
  static setRunnerFactory(factory: (config: Config) => HookRunner): () => void {
    const registration = { factory };
    this.runnerFactories.push(registration);
    return () => {
      const index = this.runnerFactories.indexOf(registration);
      if (index !== -1) this.runnerFactories.splice(index, 1);
    };
  }

  async fireImagePrepareEvent(input: ImagePrepareRequest, signal?: AbortSignal) {
    return this.hookEventHandler.fireImagePrepareEvent(input, signal);
  }

  private readonly fileWatcher = createFileChangedWatcher();
  private cwdRevision = 0;
  private watcherCwd?: string;
  private disposed = false;
  private readonly config: Config;
  private readonly hookRegistry: HookRegistry;
  private readonly hookRunner: HookRunner;
  private readonly hookAggregator: HookAggregator;
  private readonly hookPlanner: HookPlanner;
  private readonly hookEventHandler: HookEventHandler;

  constructor(config: Config) {
    this.config = config;
    this.hookRegistry = new HookRegistry(config);
    const factory = HookSystem.runnerFactories.at(-1)?.factory;
    this.hookRunner = factory ? factory(config) : new HookRunner(config);
    this.hookAggregator = new HookAggregator();
    this.hookPlanner = new HookPlanner(this.hookRegistry);
    this.hookEventHandler = new HookEventHandler(
      config,
      this.hookPlanner,
      this.hookRunner,
      this.hookAggregator,
      this.hookRegistry,
    );
  }

  /**
   * Initialize the hook system
   */
  async initialize(opts?: { emitToFeed?: boolean }): Promise<void> {
    await this.hookRegistry.initialize(opts);
    if (this.disposed) return;
    coreEvents.emit(CoreEvent.HookDiagnosticsChanged, {
      sessionId: this.config.getSessionId(),
    });
    initAutoDream(this.config);
    runLogger.debug('Hook system initialized successfully');

    // Start watching files referenced by FileChanged hook matchers
    try {
      this.fileWatcher.initializeFileChangedWatcher(
        this.watcherCwd ?? this.config.getWorkingDir(),
        this.hookRegistry,
        this.hookEventHandler,
      );
    } catch (error) {
      runLogger.debug('[HookSystem] Failed to initialize file watcher:', error);
    }
  }

  /**
   * Dispose hook system resources (file watcher, etc.)
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cwdRevision++;
    this.fileWatcher.disposeFileChangedWatcher();
  }

  updateFileWatcherCwd(cwd: string): void {
    if (this.disposed) return;
    this.cwdRevision++;
    this.watcherCwd = cwd;
    this.fileWatcher.updateFileWatcherCwd(cwd);
  }

  /** Update dynamic watch paths for this session only. */
  updateFileWatcherPaths(paths: string[]): void {
    if (this.disposed) return;
    this.fileWatcher.updateWatchPaths(paths);
  }

  /** Rebase synchronously; ignore late hook output after another change or disposal. */
  readonly onCwdChanged = (oldCwd: string, newCwd: string): void => {
    if (this.disposed || oldCwd === newCwd) return;
    this.updateFileWatcherCwd(newCwd);
    const revision = this.cwdRevision;
    void this.fireCwdChangedEvent(oldCwd, newCwd)
      .then((result) => {
        if (this.disposed || revision !== this.cwdRevision) return;
        const paths = result?.finalOutput?.hookSpecificOutput?.['watchPaths'];
        if (Array.isArray(paths))
          this.updateFileWatcherPaths(paths as string[]);
      })
      .catch((error) => {
        runLogger.debug('[HookSystem] CwdChanged hook failed:', error);
      });
  };

  /**
   * Get the hook event bus for firing events
   */
  getEventHandler(): HookEventHandler {
    return this.hookEventHandler;
  }

  /**
   * Get the Config bound to this hook system.
   */
  getConfig(): Config {
    return this.config;
  }

  /**
   * Drain all accumulated async hook context strings.
   *
   * Call this before the next model turn to retrieve any context that
   * background (async) hooks produced since the last drain.
   * Returns `undefined` if no async hooks completed.
   */
  drainPendingAsyncContext(): string | undefined {
    return this.hookEventHandler.drainPendingAsyncContext();
  }

  /**
   * Get hook registry for management operations
   */
  getRegistry(): HookRegistry {
    return this.hookRegistry;
  }

  /**
   * Get load errors collected during the most recent initialize() call.
   */
  getLoadErrors(): ReadonlyArray<
    import('../utils/configLoadError.js').ConfigLoadError
  > {
    return this.hookRegistry.getLoadErrors();
  }

  /**
   * Remove a hook from the in-memory registry by name.
   * Returns the number of entries removed.
   */
  removeEntry(hookName: string): number {
    return this.hookRegistry.removeEntry(hookName);
  }

  /**
   * Get all registered hooks for display/management
   */
  getAllHooks(): HookRegistryEntry[] {
    return this.hookRegistry.getAllHooks();
  }

  /**
   * Register a new hook programmatically
   */
  registerHook(
    config: HookConfig,
    eventName: HookEventName,
    options?: { matcher?: string; sequential?: boolean; source?: ConfigSource },
  ): void {
    this.hookRegistry.registerHook(config, eventName, options);
  }

  /**
   * Refresh the file changed watcher to pick up newly registered hooks.
   * Call this after registering FileChanged hooks at runtime (e.g. SDK hooks).
   */
  refreshFileWatcher(): void {
    this.fileWatcher.refreshFileChangedWatcher();
  }

  /**
   * Register a session-scoped hook for a specific agent.
   * Delegates to {@link HookRegistry.registerSessionHook}.
   */
  registerSessionHook(
    agentId: string,
    config: HookConfig,
    eventName: HookEventName,
    options?: { matcher?: string; sequential?: boolean },
  ): void {
    this.hookRegistry.registerSessionHook(agentId, config, eventName, options);
  }

  /**
   * Clear all session-scoped hooks for a specific agent.
   * Should be called in the agent's finally block.
   */
  clearSessionHooks(agentId: string): void {
    this.hookRegistry.clearSessionHooks(agentId);
  }

  /**
   * Remove inline skill session hooks matching the given config (by
   * reference) across all skill buckets. Used by the `once` mechanism for
   * hooks that fire in the main agent context, which carries no agentId.
   */
  removeInlineSkillSessionHooks(config: HookConfig): boolean {
    return this.hookRegistry.removeInlineSkillSessionHooks(config);
  }

  /**
   * Fire hook events directly
   */
  async fireSessionStartEvent(
    source: SessionStartSource,
    model?: string,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSessionStartEvent(
      source,
      model,
      signal,
    );
    return result.finalOutput;
  }

  async fireSetupEvent(
    trigger: SetupTrigger,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSetupEvent(trigger, signal);
    return result.finalOutput;
  }

  async fireSessionEndEvent(
    reason: SessionEndReason,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult | undefined> {
    try {
      const computedTimeoutMs = this.getSessionEndTimeoutMs(reason);
      const timeoutSignal = AbortSignal.timeout(computedTimeoutMs);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      return await this.hookEventHandler.fireSessionEndEvent(
        reason,
        combinedSignal,
      );
    } catch (error) {
      runLogger.debug(`SessionEndEvent failed for ${reason}:`, error);
      return EMPTY_FAILED_HOOK_RESULT;
    }
  }

  /**
   * Compute SessionEnd hook timeout, clamped to [1500ms, 60000ms].
   *
   * Honors each configured SessionEnd hook's `timeout` field as a hint for the
   * upper bound, but shutdown UX requires a hard cap so a slow hook cannot
   * stall exit.
   */
  getSessionEndTimeoutMs(reason: SessionEndReason): number {
    const plan = this.hookPlanner.createExecutionPlan(
      HookEventName.SessionEnd,
      { trigger: reason },
      this.config.canRunAsyncRewakeHooks(),
    );

    let maxConfiguredMs = 0;
    const allConfigs = [
      ...(plan?.hookConfigs ?? []),
      ...(plan?.asyncHookConfigs ?? []),
    ];
    for (const config of allConfigs) {
      const t = config.timeout;
      if (typeof t === 'number' && t > 0 && t * 1000 > maxConfiguredMs) {
        maxConfiguredMs = t * 1000;
      }
    }

    return Math.max(
      SESSION_END_HOOK_TIMEOUT_MIN_MS,
      Math.min(maxConfiguredMs, SESSION_END_HOOK_TIMEOUT_MAX_MS),
    );
  }

  async firePreCompactEvent(
    trigger: PreCompactTrigger,
    customInstructions: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult | undefined> {
    return this.hookEventHandler.firePreCompactEvent(
      trigger,
      customInstructions,
      signal,
      model,
    );
  }

  async fireSubagentStartEvent(
    agentId: string,
    agentType: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSubagentStartEvent(
      agentId,
      agentType,
      signal,
      model,
    );
    return result.finalOutput;
  }

  async fireSubagentStopEvent(
    agentId: string,
    agentType: string,
    stopHookActive: boolean = false,
    agentTranscriptPath?: string,
    lastAssistantMessage?: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireSubagentStopEvent(
      agentId,
      agentType,
      stopHookActive,
      agentTranscriptPath,
      lastAssistantMessage,
      signal,
      model,
    );
  }

  async firePreToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    mcpContext?: McpToolContext,
    originalRequestName?: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    try {
      return await this.hookEventHandler.firePreToolUseEvent(
        toolName,
        toolInput,
        toolUseId,
        mcpContext,
        originalRequestName,
        signal,
        model,
      );
    } catch (error) {
      runLogger.error(`PreToolUseEvent failed for ${toolName}:`, error);
      return buildPreToolUseDenyResult(
        `PreToolUse hook system error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async firePostToolUseEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: unknown,
    toolUseId: string,
    mcpContext?: McpToolContext,
    originalRequestName?: string,
    signal?: AbortSignal,
    model?: string,
    fileWrite?: PostToolUseInput['file_write'],
  ): Promise<AggregatedHookResult> {
    try {
      return await this.hookEventHandler.firePostToolUseEvent(
        toolName,
        toolInput,
        toolResponse,
        toolUseId,
        mcpContext,
        originalRequestName,
        signal,
        model,
        fileWrite,
      );
    } catch (error) {
      runLogger.debug(`PostToolUseEvent failed for ${toolName}:`, error);
      return EMPTY_FAILED_HOOK_RESULT;
    }
  }

  /**
   * Fire a generic Notification hook event for any NotificationType.
   * This enables hooks to react to idle prompts, auth success,
   * elicitation dialogs, and other notification scenarios.
   */
  async fireNotificationEvent(
    type: NotificationType,
    message: string,
    details: Record<string, unknown>,
    title?: string,
    signal?: AbortSignal,
  ): Promise<DefaultHookOutput | undefined> {
    try {
      const result = await this.hookEventHandler.fireNotificationEvent(
        type,
        message,
        details,
        title,
        signal,
      );
      return result.finalOutput;
    } catch (error) {
      runLogger.debug(`NotificationEvent (${type}) failed:`, error);
      return undefined;
    }
  }

  async firePostToolUseFailureEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    errorMessage: string,
    toolUseId: string,
    errorType?: string,
    mcpContext?: McpToolContext,
    originalRequestName?: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.firePostToolUseFailureEvent(
      toolName,
      toolInput,
      errorMessage,
      toolUseId,
      errorType,
      mcpContext,
      originalRequestName,
      undefined,
      signal,
      model,
    );
  }

  async firePostCompactEvent(
    trigger: PreCompactTrigger,
    compactSummary: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.firePostCompactEvent(
      trigger,
      compactSummary,
      signal,
      model,
    );
  }

  /**
   * Fires the Stop event for the main agent loop, returning DefaultHookOutput
   * for stop/block/clearContext semantics. Accepts prompt and response context
   * so downstream hooks can inspect them.
   */
  async fireStopEvent(
    prompt: string,
    response: string,
    stopHookActive: boolean = false,
    lifecycleContext?: {
      requestId?: string;
      parentRequestSetId?: string;
      parentBusinessInfo?: Readonly<
        import('../qoder/business-info.js').BusinessInfo
      >;
      customContext?: Readonly<Record<string, string>>;
    },
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireStopEventWithContext(
      prompt,
      response,
      stopHookActive,
      lifecycleContext,
      signal,
      model,
    );
  }

  /**
   * QueryEnd owns one outer finishing deadline around the whole hook batch.
   * It must not undercut a hook's own declared timeout, but remains bounded by
   * the same 15-second maximum used by query lifecycle finalization.
   */
  private getQueryEndTimeoutMs(): number {
    const declaredMs = this.hookRegistry
      .getHooksForEvent(HookEventName.QueryEnd)
      .reduce(
        (maximum, entry) =>
          Math.max(maximum, (entry.config.timeout ?? 0) * 1000),
        0,
      );
    return Math.min(
      QUERY_END_HOOK_TIMEOUT_MAX_MS,
      Math.max(QUERY_END_HOOK_TIMEOUT_MIN_MS, declaredMs),
    );
  }

  /** Fires notification-only QueryEnd hooks within the finishing deadline. */
  async fireQueryEndEvent(
    requestSetId: string,
    businessId: string | undefined,
    model: string,
    reason: QueryEndReason,
  ): Promise<void> {
    try {
      await this.hookEventHandler.fireQueryEndEvent(
        requestSetId,
        businessId,
        model,
        reason,
        AbortSignal.timeout(this.getQueryEndTimeoutMs()),
      );
    } catch (error) {
      runLogger.warn(`QueryEnd hook failed for ${requestSetId}: ${error}`);
    }
  }

  /**
   * Fires the UserPromptSubmit event for the main agent loop, returning
   * DefaultHookOutput for stop/block/context injection semantics.
   */
  async fireUserPromptSubmitEvent(
    prompt: string,
    signal?: AbortSignal,
    imageUrls?: readonly string[],
    requestSetId?: string,
  ): Promise<AggregatedHookResult> {
    const result = await this.hookEventHandler.fireUserPromptSubmitEvent(
      prompt,
      signal,
      imageUrls,
      requestSetId,
    );
    return result;
  }

  async fireConfigChangeEvent(
    source: ConfigChangeSource,
    filePath?: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireConfigChangeEvent(
      source,
      filePath,
      signal,
    );
  }

  async fireStopFailureEvent(
    error: StopFailureErrorType,
    options?: StopFailureOptions,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireStopFailureEvent(
      error,
      options,
      signal,
      model,
    );
  }

  async fireTeammateIdleEvent(
    teammateName: string,
    teamName?: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireTeammateIdleEvent(
      teammateName,
      teamName,
      signal,
    );
  }

  async fireInstructionsLoadedEvent(
    filePath: string,
    memoryType: string,
    loadReason: InstructionsLoadReason,
    options?: {
      globs?: string[];
      triggerFilePath?: string;
      parentFilePath?: string;
    },
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireInstructionsLoadedEvent(
      filePath,
      memoryType,
      loadReason,
      options,
      signal,
    );
  }

  async fireCwdChangedEvent(
    oldCwd: string,
    newCwd: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireCwdChangedEvent(oldCwd, newCwd, signal);
  }

  async fireFileChangedEvent(
    filePath: string,
    event: FileChangeEventType,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireFileChangedEvent(filePath, event, signal);
  }

  async fireWorktreeCreateEvent(
    name: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireWorktreeCreateEvent(name, signal);
  }

  async fireWorktreeRemoveEvent(
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireWorktreeRemoveEvent(worktreePath, signal);
  }

  async fireElicitationEvent(
    mcpServerName: string,
    message: string,
    options?: {
      mode?: string;
      url?: string;
      elicitationId?: string;
      requestedSchema?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    // Also fire an ElicitationDialog notification so notification hooks can react
    void this.fireNotificationEvent(
      NotificationType.ElicitationDialog,
      message,
      {
        mcpServerName,
        ...(options?.elicitationId && {
          elicitationId: options.elicitationId,
        }),
        ...(options?.mode && { mode: options.mode }),
      },
      undefined,
      signal,
    );

    return this.hookEventHandler.fireElicitationEvent(
      mcpServerName,
      message,
      options,
      signal,
    );
  }

  async fireElicitationResultEvent(
    mcpServerName: string,
    action: ElicitationAction,
    options?: {
      content?: Record<string, unknown>;
      mode?: string;
      elicitationId?: string;
    },
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    // Also fire an ElicitationResponse notification so notification hooks can react
    void this.fireNotificationEvent(
      NotificationType.ElicitationResponse,
      `Elicitation response for server "${mcpServerName}": ${action}`,
      {
        mcpServerName,
        action,
        ...(options?.elicitationId && { elicitationId: options.elicitationId }),
        ...(options?.mode && { mode: options.mode }),
      },
      undefined,
      signal,
    );

    return this.hookEventHandler.fireElicitationResultEvent(
      mcpServerName,
      action,
      options,
      signal,
    );
  }

  async fireTaskCreatedEvent(
    taskId: string,
    taskSubject: string,
    options?: {
      taskDescription?: string;
      teammateName?: string;
      teamName?: string;
    },
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireTaskCreatedEvent(
      taskId,
      taskSubject,
      options,
      signal,
    );
  }

  async fireTaskCompletedEvent(
    taskId: string,
    taskSubject: string,
    options?: {
      taskDescription?: string;
      teammateName?: string;
      teamName?: string;
    },
    signal?: AbortSignal,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.fireTaskCompletedEvent(
      taskId,
      taskSubject,
      options,
      signal,
    );
  }

  async firePermissionRequestEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    permissionSuggestions?: PermissionSuggestion[],
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.firePermissionRequestEvent(
      toolName,
      toolInput,
      permissionSuggestions,
      signal,
      model,
    );
  }

  async firePermissionDeniedEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    reason: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<AggregatedHookResult> {
    return this.hookEventHandler.firePermissionDeniedEvent(
      toolName,
      toolInput,
      toolUseId,
      reason,
      signal,
      model,
    );
  }
}
