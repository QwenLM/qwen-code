/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { ProcessExecutionTiming } from '../utils/ShellCommand.js';
import type { ShellType } from '../utils/shell/shellProvider.js';
import { runLogger } from '../utils/runLogger.js';
import {
  evictTaskOutput,
  MAX_TASK_OUTPUT_BYTES_DISPLAY,
} from '../utils/task/diskOutput.js';
import { sanitizeOutput } from '../utils/textUtils.js';
import { enqueuePendingNotification } from './messageQueueManager.js';
import {
  buildTaskNotificationXml,
  buildCompletionSummary,
  buildMonitorCompletionSummary,
} from './taskNotification.js';
import {
  createTaskUpdatedEvent,
  enqueueSubagentSdkEvent,
} from '../agents/subagent-sdk-events.js';

export type ExecutionMethod = 'child_process' | 'none';

export interface ExecutionResult {
  processTiming?: ProcessExecutionTiming;
  rawOutput?: Buffer;
  output: string;
  /** Captured stdout when the caller requests stream-preserving execution. */
  stdout?: string;
  /** Captured stderr when the caller requests stream-preserving execution. */
  stderr?: string;
  exitCode: number | null;
  signal: number | null;
  error: Error | null;
  aborted: boolean;
  timedOut?: boolean;
  /** The command was terminated after its task output file exceeded the hard cap. */
  outputLimitExceeded?: boolean;
  pid: number | undefined;
  executionMethod: ExecutionMethod;
  backgrounded?: boolean;
  backgroundReason?: BackgroundReason;
  /** Path to the raw .output file when it was too large to read fully into memory. */
  outputFilePath?: string;
  /** Size in bytes of the raw .output file. */
  outputFileSize?: number;
}

/**
 * Why a foreground execution was detached into the background.
 * - `user`: the user explicitly pressed the background shortcut.
 * - `model`: the model requested background execution via tool parameters.
 * - `timeout`: foreground execution hit its timeout and was preserved.
 * - `auto`: the system proactively detached execution for policy or budget reasons.
 */
export type BackgroundReason = 'user' | 'model' | 'timeout' | 'auto';

export interface ExecutionHandle {
  pid: number | undefined;
  result: Promise<ExecutionResult>;
}

export type ExecutionOutputEvent =
  | {
      type: 'data';
      chunk: string;
      /** Total line count (estimated for large files). */
      totalLines?: number;
      /** Total byte count of all output so far. */
      totalBytes?: number;
      /** True when `chunk` is a full output snapshot instead of an incremental delta. */
      isSnapshot?: boolean;
    }
  | {
      type: 'exit';
      exitCode: number | null;
      signal: number | null;
    };

export interface ExecutionCompletionOptions {
  exitCode?: number | null;
  signal?: number | null;
  error?: Error | null;
  aborted?: boolean;
}

export interface ExternalExecutionRegistration {
  shellType?: ShellType;
  executionMethod: ExecutionMethod;
  /** Stable task identifier exposed to model tools and SDK consumers. */
  taskId?: string;
  /** Session that owns the execution. */
  sessionId?: string;
  /** Subagent that created the execution. Undefined for the main session. */
  ownerAgentId?: string;
  /** Distinguishes ordinary background Bash from Monitor. */
  taskKind?: 'bash' | 'monitor';
  /** Tool call that launched the execution. */
  toolUseId?: string;
  /** Per-turn identity snapshot captured when the execution was created. */
  customContext?: Readonly<Record<string, string>>;
  /** Makes this execution eligible for SDK foreground-to-background control. */
  backgroundControlType?: 'local_bash' | 'local_agent';
  /** Human-readable label for the background task UI (e.g. the command string). */
  label?: string;
  /** Original shell command for local Bash and Monitor tasks. */
  command?: string;
  /** Output file path for the background task (used in XML notification). */
  outputPath?: string;
  initialOutput?: string;
  getBackgroundOutput?: () => string;
  getSubscriptionSnapshot?: () => string | undefined;
  writeInput?: (input: string) => void;
  kill?: () => void | Promise<void>;
  isActive?: () => boolean;
  formatInjection?: FormatInjectionFn;
  completionBehavior?: CompletionBehavior;
}

export interface ExecutionTaskMetadata {
  shellType?: ShellType;
  taskId?: string;
  sessionId?: string;
  ownerAgentId?: string;
  taskKind?: 'bash' | 'monitor';
  toolUseId?: string;
  /** Per-turn identity snapshot captured when the execution was created. */
  customContext?: Readonly<Record<string, string>>;
  /** Makes this execution eligible for SDK foreground-to-background control. */
  backgroundControlType?: 'local_bash' | 'local_agent';
  outputPath?: string;
}

/**
 * Callback that an execution creator provides to control how its output
 * is formatted when reinjected into the model conversation after backgrounding.
 * Return `null` to skip injection entirely.
 */
export type FormatInjectionFn = (
  output: string,
  error: Error | null,
) => string | null;

/**
 * Controls what happens when a backgrounded execution completes:
 * - `'inject'`  — full formatted output is injected into the conversation; task auto-dismisses from UI.
 * - `'notify'`  — a short pointer (e.g. "output saved to /tmp/...") is injected; task auto-dismisses from UI.
 * - `'silent'`  — nothing is injected; task stays in the UI until manually dismissed.
 *
 * Background shell commands always use `'notify'` (unconditional).
 * The `'silent'` option is reserved for internal tasks (e.g. skill extraction) that
 * should not trigger agent responses.
 *
 * The distinction between `inject` and `notify` is semantic for now (both inject + dismiss),
 * but enables the system to treat them differently in the future (e.g. LLM-decided injection).
 */
export type CompletionBehavior = 'inject' | 'notify' | 'silent';

interface ManagedExecutionBase {
  backgroundReason?: BackgroundReason;
  shellType?: ShellType;
  startedAt: number;
  executionMethod: ExecutionMethod;
  taskId?: string;
  sessionId?: string;
  ownerAgentId?: string;
  taskKind?: 'bash' | 'monitor';
  toolUseId?: string;
  /** Per-turn identity snapshot captured when the execution was created. */
  customContext?: Readonly<Record<string, string>>;
  backgroundControlType?: 'local_bash' | 'local_agent';
  label?: string;
  command?: string;
  output: string;
  backgrounded?: boolean;
  /** Atomic dedup flag — once set, no duplicate notification is enqueued. */
  notified?: boolean;
  /** Output file path for the background task (used in XML notification). */
  outputPath?: string;
  formatInjection?: FormatInjectionFn;
  completionBehavior?: CompletionBehavior;
  getBackgroundOutput?: () => string;
  getSubscriptionSnapshot?: () => string | undefined;
}

/**
 * Payload emitted when an execution is moved to the background.
 */
export interface BackgroundStartInfo {
  shellType?: ShellType;
  executionId: number;
  executionMethod: ExecutionMethod;
  taskId?: string;
  sessionId?: string;
  ownerAgentId?: string;
  taskKind?: 'bash' | 'monitor';
  toolUseId?: string;
  /** Per-turn identity snapshot captured when the execution was created. */
  customContext?: Readonly<Record<string, string>>;
  outputPath?: string;
  command?: string;
  label: string;
  output: string;
  reason?: BackgroundReason;
  completionBehavior: CompletionBehavior;
}

export type BackgroundStartListener = (info: BackgroundStartInfo) => void;

/**
 * Payload emitted when a previously-backgrounded execution settles.
 */
export interface BackgroundCompletionInfo {
  shellType?: ShellType;
  taskKind?: 'bash' | 'monitor';
  backgroundReason?: BackgroundReason;
  processTiming?: ProcessExecutionTiming;
  aborted: boolean;
  executionId: number;
  executionMethod: ExecutionMethod;
  taskId?: string;
  sessionId?: string;
  toolUseId?: string;
  command?: string;
  startedAt: number;
  exitCode: number | null;
  signal: number | null;
  output: string;
  error: Error | null;
  /** Pre-formatted injection text from the execution creator, or `null` if skipped. */
  injectionText: string | null;
  completionBehavior: CompletionBehavior;
}

export type BackgroundCompletionListener = (
  info: BackgroundCompletionInfo,
) => void;

interface VirtualExecutionState extends ManagedExecutionBase {
  kind: 'virtual';
  onKill?: (reason?: string) => void | Promise<void>;
}

interface ExternalExecutionState extends ManagedExecutionBase {
  kind: 'external';
  writeInput?: (input: string) => void;
  kill?: () => void | Promise<void>;
  isActive?: () => boolean;
}

type ManagedExecutionState = VirtualExecutionState | ExternalExecutionState;

/** Resolve the effective completion behavior for a managed execution. */
function resolveCompletionBehavior(
  execution: ManagedExecutionBase,
): CompletionBehavior {
  return (
    execution.completionBehavior ??
    (execution.formatInjection ? 'inject' : 'notify')
  );
}

const NON_PROCESS_EXECUTION_ID_START = 2_000_000_000;

/**
 * Central owner for execution backgrounding lifecycle across shell and tools.
 */
export class ExecutionLifecycleService {
  private static readonly EXIT_INFO_TTL_MS = 5 * 60 * 1000;
  private static nextExecutionId = NON_PROCESS_EXECUTION_ID_START;

  private static activeExecutions = new Map<number, ManagedExecutionState>();
  private static activeResolvers = new Map<
    number,
    (result: ExecutionResult) => void
  >();
  private static activeListeners = new Map<
    number,
    Set<(event: ExecutionOutputEvent) => void>
  >();
  private static pendingKills = new Map<number, Promise<void>>();
  private static exitedExecutionInfo = new Map<
    number,
    { exitCode: number; signal?: number }
  >();
  private static backgroundCompletionListeners =
    new Set<BackgroundCompletionListener>();

  private static backgroundStartListeners = new Set<BackgroundStartListener>();

  /**
   * Registers a listener that fires when any execution is moved to the background.
   * This is the hook for the UI to automatically discover backgrounded executions.
   */
  static onBackground(listener: BackgroundStartListener): void {
    this.backgroundStartListeners.add(listener);
  }

  /**
   * Unregisters a background start listener.
   */
  static offBackground(listener: BackgroundStartListener): void {
    this.backgroundStartListeners.delete(listener);
  }

  /**
   * Registers a listener that fires when a previously-backgrounded
   * execution settles (completes or errors).
   */
  static onBackgroundComplete(listener: BackgroundCompletionListener): void {
    this.backgroundCompletionListeners.add(listener);
  }

  /**
   * Unregisters a background completion listener.
   */
  static offBackgroundComplete(listener: BackgroundCompletionListener): void {
    this.backgroundCompletionListeners.delete(listener);
  }

  private static storeExitInfo(
    executionId: number,
    exitCode: number,
    signal?: number,
  ): void {
    this.exitedExecutionInfo.set(executionId, {
      exitCode,
      signal,
    });
    setTimeout(() => {
      this.exitedExecutionInfo.delete(executionId);
    }, this.EXIT_INFO_TTL_MS).unref();
  }

  private static allocateExecutionId(): number {
    let executionId = ++this.nextExecutionId;
    while (this.activeExecutions.has(executionId)) {
      executionId = ++this.nextExecutionId;
    }
    return executionId;
  }

  private static createPendingResult(
    executionId: number,
  ): Promise<ExecutionResult> {
    return new Promise<ExecutionResult>((resolve) => {
      this.activeResolvers.set(executionId, resolve);
    });
  }

  private static createAbortedResult(
    executionId: number,
    execution: ManagedExecutionState,
  ): ExecutionResult {
    const output = execution.getBackgroundOutput?.() ?? execution.output;
    return {
      rawOutput: Buffer.from(output, 'utf8'),
      output,
      exitCode: 130,
      signal: null,
      error: new Error('Operation cancelled by user.'),
      aborted: true,
      pid: executionId,
      executionMethod: execution.executionMethod,
    };
  }

  /**
   * Resets lifecycle state for isolated unit tests.
   */
  static resetForTest(): void {
    this.activeExecutions.clear();
    this.activeResolvers.clear();
    this.activeListeners.clear();
    this.pendingKills.clear();
    this.exitedExecutionInfo.clear();
    this.backgroundCompletionListeners.clear();
    this.backgroundStartListeners.clear();
    this.nextExecutionId = NON_PROCESS_EXECUTION_ID_START;
  }

  static attachExecution(
    executionId: number,
    registration: ExternalExecutionRegistration,
  ): ExecutionHandle {
    if (
      this.activeExecutions.has(executionId) ||
      this.activeResolvers.has(executionId)
    ) {
      throw new Error(`Execution ${executionId} is already attached.`);
    }
    this.exitedExecutionInfo.delete(executionId);

    runLogger.debug(
      `[Lifecycle] attachExecution: id=${executionId}, method=${registration.executionMethod}, ` +
        `completionBehavior=${registration.completionBehavior}`,
    );

    this.activeExecutions.set(executionId, {
      startedAt: Date.now(),
      executionMethod: registration.executionMethod,
      taskId: registration.taskId,
      sessionId: registration.sessionId,
      ownerAgentId: registration.ownerAgentId,
      taskKind: registration.taskKind,
      shellType: registration.shellType,
      toolUseId: registration.toolUseId,
      customContext: registration.customContext,
      backgroundControlType: registration.backgroundControlType,
      label: registration.label,
      command: registration.command,
      output: registration.initialOutput ?? '',
      kind: 'external',
      outputPath: registration.outputPath,
      getBackgroundOutput: registration.getBackgroundOutput,
      getSubscriptionSnapshot: registration.getSubscriptionSnapshot,
      writeInput: registration.writeInput,
      kill: registration.kill,
      isActive: registration.isActive,
      formatInjection: registration.formatInjection,
      completionBehavior: registration.completionBehavior,
    });

    return {
      pid: executionId,
      result: this.createPendingResult(executionId),
    };
  }

  static createExecution(
    initialOutput = '',
    onKill?: (reason?: string) => void | Promise<void>,
    executionMethod: ExecutionMethod = 'none',
    formatInjection?: FormatInjectionFn,
    label?: string,
    completionBehavior?: CompletionBehavior,
    metadata?: ExecutionTaskMetadata,
  ): ExecutionHandle {
    const executionId = this.allocateExecutionId();

    this.activeExecutions.set(executionId, {
      startedAt: Date.now(),
      executionMethod,
      taskId: metadata?.taskId,
      sessionId: metadata?.sessionId,
      ownerAgentId: metadata?.ownerAgentId,
      taskKind: metadata?.taskKind,
      shellType: metadata?.shellType,
      toolUseId: metadata?.toolUseId,
      customContext: metadata?.customContext,
      backgroundControlType: metadata?.backgroundControlType,
      outputPath: metadata?.outputPath,
      label,
      output: initialOutput,
      kind: 'virtual',
      onKill,
      formatInjection,
      completionBehavior,
      getBackgroundOutput: () => {
        const state = this.activeExecutions.get(executionId);
        return state?.output ?? initialOutput;
      },
      getSubscriptionSnapshot: () => {
        const state = this.activeExecutions.get(executionId);
        return state?.output ?? initialOutput;
      },
    });

    return {
      pid: executionId,
      result: this.createPendingResult(executionId),
    };
  }

  static hasActiveNotifiableExecutions(): boolean {
    for (const execution of this.activeExecutions.values()) {
      if (resolveCompletionBehavior(execution) !== 'silent') {
        return true;
      }
    }
    return false;
  }

  static appendOutput(executionId: number, chunk: string): void {
    const execution = this.activeExecutions.get(executionId);
    if (!execution || chunk.length === 0) {
      return;
    }

    execution.output += chunk;
    this.emitEvent(executionId, { type: 'data', chunk });
  }

  static setTaskMetadata(
    executionId: number,
    metadata: ExecutionTaskMetadata,
  ): void {
    const execution = this.activeExecutions.get(executionId);
    if (!execution) return;
    Object.assign(execution, metadata);
  }

  static emitEvent(executionId: number, event: ExecutionOutputEvent): void {
    const listeners = this.activeListeners.get(executionId);
    if (listeners) {
      listeners.forEach((listener) => listener(event));
    }
  }

  private static resolvePending(
    executionId: number,
    result: ExecutionResult,
  ): void {
    const resolve = this.activeResolvers.get(executionId);
    if (!resolve) {
      return;
    }

    resolve(result);
    this.activeResolvers.delete(executionId);
  }

  private static settleExecution(
    executionId: number,
    result: ExecutionResult,
  ): void {
    const execution = this.activeExecutions.get(executionId);
    if (!execution) {
      runLogger.debug(
        `[Lifecycle] settleExecution: id=${executionId} — no active execution found, skipping`,
      );
      return;
    }

    runLogger.debug(
      `[Lifecycle] settleExecution: id=${executionId}, backgrounded=${execution.backgrounded}, ` +
        `aborted=${result.aborted}, completionBehavior=${execution.completionBehavior}, ` +
        `notified=${execution.notified}, exitCode=${result.exitCode}`,
    );

    // Fire background completion listeners if this was a backgrounded execution.
    if (
      execution.backgrounded &&
      (!result.aborted || execution.taskKind !== undefined)
    ) {
      const behavior = resolveCompletionBehavior(execution);

      runLogger.debug(
        `[Lifecycle] settleExecution: id=${executionId}, resolved behavior=${behavior}`,
      );
      const rawInjection =
        behavior !== 'silent' && execution.formatInjection
          ? execution.formatInjection(result.output, result.error)
          : null;

      const injectionText = rawInjection ? sanitizeOutput(rawInjection) : null;

      // Enqueue XML notification via messageQueueManager.
      // Atomic dedup: only enqueue once per execution.
      if (!execution.notified && behavior !== 'silent') {
        execution.notified = true;

        const status: 'completed' | 'failed' | 'killed' =
          result.aborted || result.signal
            ? 'killed'
            : result.error ||
                (result.exitCode !== null && result.exitCode !== 0)
              ? 'failed'
              : 'completed';
        const description = execution.label ?? `PID ${executionId}`;
        const summary = result.outputLimitExceeded
          ? `Background command "${description}" was stopped: output file exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY}`
          : execution.taskKind === 'monitor'
            ? buildMonitorCompletionSummary(
                description,
                status,
                result.exitCode ?? undefined,
              )
            : buildCompletionSummary(
                description,
                status,
                result.exitCode ?? undefined,
              );
        const outputPath = execution.outputPath ?? '';

        if (execution.sessionId && execution.taskId) {
          enqueueSubagentSdkEvent(
            execution.sessionId,
            createTaskUpdatedEvent({
              sessionId: execution.sessionId,
              taskId: execution.taskId,
              status,
              endTime: Date.now(),
            }),
          );
        }

        const xmlMessage = buildTaskNotificationXml({
          taskId: execution.taskId ?? executionId,
          outputPath,
          status,
          summary,
          toolUseId: execution.toolUseId,
        });

        enqueuePendingNotification({
          prompt: xmlMessage,
          commandMode: 'task-notification',
          priority: execution.taskKind ? 'next' : 'later',
          sessionId: execution.sessionId,
          targetAgentId: execution.ownerAgentId,
          ...(execution.customContext !== undefined
            ? { customContext: execution.customContext }
            : {}),
        });

        runLogger.debug(
          `[Lifecycle] enqueued task-notification: id=${executionId}, status=${status}`,
        );

        // Evict DiskTaskOutput from memory now that the notification is queued.
        if (outputPath) {
          const taskId = path.basename(outputPath, '.output');
          if (taskId) {
            evictTaskOutput(taskId).catch((err) => {
              runLogger.debug(`[Lifecycle] evictTaskOutput failed: ${err}`);
            });
          }
        }
      }

      const info: BackgroundCompletionInfo = {
        shellType: execution.shellType,
        taskKind: execution.taskKind,
        backgroundReason: execution.backgroundReason,
        processTiming: result.processTiming,
        aborted: result.aborted,
        executionId,
        executionMethod: execution.executionMethod,
        taskId: execution.taskId,
        sessionId: execution.sessionId,
        toolUseId: execution.toolUseId,
        command: execution.command,
        startedAt: execution.startedAt,
        exitCode: result.exitCode,
        signal: result.signal,
        output: result.output,
        error: result.error,
        injectionText,
        completionBehavior: behavior,
      };

      for (const listener of this.backgroundCompletionListeners) {
        try {
          listener(info);
        } catch (error) {
          runLogger.warn(`Background completion listener failed: ${error}`);
        }
      }
    }

    this.resolvePending(executionId, result);
    this.emitEvent(executionId, {
      type: 'exit',
      exitCode: result.exitCode,
      signal: result.signal,
    });

    this.activeListeners.delete(executionId);
    this.activeExecutions.delete(executionId);
    this.storeExitInfo(
      executionId,
      result.exitCode ?? 0,
      result.signal ?? undefined,
    );
  }

  static completeExecution(
    executionId: number,
    options?: ExecutionCompletionOptions,
  ): void {
    const execution = this.activeExecutions.get(executionId);
    if (!execution) {
      return;
    }

    const {
      error = null,
      aborted = false,
      exitCode = error ? 1 : 0,
      signal = null,
    } = options ?? {};

    const output = execution.getBackgroundOutput?.() ?? execution.output;

    this.settleExecution(executionId, {
      rawOutput: Buffer.from(output, 'utf8'),
      output,
      exitCode,
      signal,
      error,
      aborted,
      pid: executionId,
      executionMethod: execution.executionMethod,
    });
  }

  static completeWithResult(
    executionId: number,
    result: ExecutionResult,
  ): void {
    runLogger.debug(
      `[Lifecycle] completeWithResult: id=${executionId}, exitCode=${result.exitCode}, aborted=${result.aborted}`,
    );
    this.settleExecution(executionId, result);
  }

  static background(
    executionId: number,
    reason?: BackgroundReason,
  ): BackgroundStartInfo | undefined {
    runLogger.debug(`[Lifecycle] background: id=${executionId}`);
    const resolve = this.activeResolvers.get(executionId);
    if (!resolve) {
      return undefined;
    }

    const execution = this.activeExecutions.get(executionId);
    if (!execution) {
      return undefined;
    }

    const output = execution.getBackgroundOutput?.() ?? execution.output;

    resolve({
      rawOutput: Buffer.from(''),
      output,
      exitCode: null,
      signal: null,
      error: null,
      aborted: false,
      pid: executionId,
      executionMethod: execution.executionMethod,
      backgrounded: true,
      backgroundReason: reason,
    });

    this.activeResolvers.delete(executionId);
    execution.backgrounded = true;
    execution.backgroundReason = reason;

    // Notify listeners that an execution was moved to the background.
    const info: BackgroundStartInfo = {
      executionId,
      executionMethod: execution.executionMethod,
      taskId: execution.taskId,
      sessionId: execution.sessionId,
      ownerAgentId: execution.ownerAgentId,
      taskKind: execution.taskKind,
      shellType: execution.shellType,
      toolUseId: execution.toolUseId,
      customContext: execution.customContext,
      outputPath: execution.outputPath,
      command: execution.command,
      label:
        execution.label ?? `${execution.executionMethod} (ID: ${executionId})`,
      output,
      reason,
      completionBehavior: resolveCompletionBehavior(execution),
    };
    for (const listener of this.backgroundStartListeners) {
      listener(info);
    }
    return info;
  }

  /**
   * Background eligible foreground executions for one session. When a tool
   * use ID is provided, only the execution created by that tool call is
   * targeted. Returns true when at least one execution transitioned.
   */
  static backgroundTasks(options: {
    sessionId?: string;
    toolUseId?: string;
    reason?: BackgroundReason;
  }): boolean {
    let backgrounded = false;
    for (const [executionId, execution] of [
      ...this.activeExecutions.entries(),
    ]) {
      if (execution.backgrounded) continue;
      if (execution.backgroundControlType === undefined) continue;
      if (
        options.sessionId !== undefined &&
        execution.sessionId !== options.sessionId
      ) {
        continue;
      }
      if (
        options.toolUseId !== undefined &&
        execution.toolUseId !== options.toolUseId
      ) {
        continue;
      }
      if (this.background(executionId, options.reason ?? 'user')) {
        backgrounded = true;
      }
    }
    return backgrounded;
  }

  static subscribe(
    executionId: number,
    listener: (event: ExecutionOutputEvent) => void,
  ): () => void {
    if (!this.activeListeners.has(executionId)) {
      this.activeListeners.set(executionId, new Set());
    }
    this.activeListeners.get(executionId)?.add(listener);

    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      const snapshot =
        execution.getSubscriptionSnapshot?.() ??
        (execution.output.length > 0 ? execution.output : undefined);
      if (snapshot && (typeof snapshot !== 'string' || snapshot.length > 0)) {
        listener({ type: 'data', chunk: snapshot, isSnapshot: true });
      }
    }

    return () => {
      this.activeListeners.get(executionId)?.delete(listener);
      if (this.activeListeners.get(executionId)?.size === 0) {
        this.activeListeners.delete(executionId);
      }
    };
  }

  static onExit(
    executionId: number,
    callback: (exitCode: number, signal?: number) => void,
  ): () => void {
    if (this.activeExecutions.has(executionId)) {
      const listener = (event: ExecutionOutputEvent) => {
        if (event.type === 'exit') {
          callback(event.exitCode ?? 0, event.signal ?? undefined);
          unsubscribe();
        }
      };
      const unsubscribe = this.subscribe(executionId, listener);
      return unsubscribe;
    }

    const exitedInfo = this.exitedExecutionInfo.get(executionId);
    if (exitedInfo) {
      callback(exitedInfo.exitCode, exitedInfo.signal);
    }

    return () => {};
  }

  static kill(executionId: number, reason?: string): Promise<void> {
    runLogger.debug(
      `[Lifecycle] kill: id=${executionId}, reason=${reason ?? 'unknown'}`,
    );
    const pendingKill = this.pendingKills.get(executionId);
    if (pendingKill) {
      return pendingKill;
    }

    const execution = this.activeExecutions.get(executionId);
    if (!execution) {
      return Promise.resolve();
    }

    const killPromise = (async () => {
      try {
        if (execution.kind === 'virtual') {
          await execution.onKill?.(reason);
        }

        if (execution.kind === 'external') {
          await execution.kill?.();
        }
      } catch (error) {
        runLogger.warn(
          `[Lifecycle] kill callback failed: id=${executionId}, error=${String(error)}`,
        );
        if (execution.kind === 'external') {
          // Keep ownership and the task's running state so a failed OS-level
          // stop can be surfaced to the caller and retried during shutdown.
          throw error;
        }
      }

      // The execution may have completed naturally while its asynchronous kill
      // callback was running. Only settle the exact state that initiated this
      // kill, so a reused execution ID cannot be affected.
      if (this.activeExecutions.get(executionId) === execution) {
        this.completeWithResult(
          executionId,
          this.createAbortedResult(executionId, execution),
        );
      }
    })();

    this.pendingKills.set(executionId, killPromise);
    const removePendingKill = () => {
      if (this.pendingKills.get(executionId) === killPromise) {
        this.pendingKills.delete(executionId);
      }
    };
    void killPromise.then(removePendingKill, removePendingKill);
    return killPromise;
  }

  /**
   * Terminates every execution still owned by this CLI process and waits for
   * all registered kill callbacks to finish.
   *
   * This intentionally uses the lifecycle registry rather than the task UI
   * registry: foreground executions are attached here immediately, while only
   * background executions are exposed as tasks.
   */
  static async terminateAll(reason = 'session_shutdown'): Promise<void> {
    const executionIds = [...this.activeExecutions.keys()];
    runLogger.debug(
      `[Lifecycle] terminateAll: activeExecutions=${executionIds.length}, pendingKills=${this.pendingKills.size}`,
    );

    const pending = new Set<Promise<void>>(this.pendingKills.values());
    for (const executionId of executionIds) {
      pending.add(this.kill(executionId, reason));
    }
    await Promise.allSettled(pending);
  }

  static isActive(executionId: number): boolean {
    const execution = this.activeExecutions.get(executionId);
    if (!execution) {
      if (executionId >= NON_PROCESS_EXECUTION_ID_START) {
        return false;
      }
      try {
        return process.kill(executionId, 0);
      } catch {
        return false;
      }
    }

    if (execution.kind === 'virtual') {
      return true;
    }

    if (execution.kind === 'external' && execution.isActive) {
      try {
        return execution.isActive();
      } catch {
        return false;
      }
    }

    try {
      return process.kill(executionId, 0);
    } catch {
      return false;
    }
  }

  static writeInput(executionId: number, input: string): void {
    const execution = this.activeExecutions.get(executionId);
    if (execution?.kind === 'external') {
      execution.writeInput?.(input);
    }
  }

  /**
   * Mark an execution as notified to suppress a pending notification.
   * Used when backgrounding raced with completion — the tool result already
   * carries the full output, so the `<task-notification>` would be redundant.
   */
  static markNotified(executionId: number): void {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.notified = true;
    }
  }
}
