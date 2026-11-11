/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import stripAnsi from 'strip-ansi';
import { exec as shellExec, type ExecOptions } from '../utils/Shell.js';
import {
  DEFAULT_SHELL_TYPE,
  type ShellSessionContext,
  type ShellType,
} from '../utils/shell/shellProvider.js';
import {
  ShellTerminationError,
  type ShellCommand,
  type ExecResult,
} from '../utils/ShellCommand.js';
import { isBinary, truncateString } from '../utils/textUtils.js';
import { runLogger } from '../utils/runLogger.js';
import { tailFile } from '../utils/fsOperations.js';
import { PROGRESS_TAIL_BYTES, TaskOutput } from '../utils/task/TaskOutput.js';
import {
  emitShellStarted,
  emitShellFinished,
  emitShellFailed,
  emitShellKillRequested,
  emitShellBackgrounded,
} from '../utils/diagnosticInterceptors.js';
import type { EnvironmentSanitizationConfig } from './environmentSanitization.js';
import {
  ExecutionLifecycleService,
  type BackgroundReason,
  type ExecutionHandle,
  type ExecutionOutputEvent,
  type CompletionBehavior,
  type ExecutionResult,
} from './executionLifecycleService.js';
import { startStallWatchdog } from './stallDetection.js';
import {
  buildShellSpawnTransform,
  type ShellSpawnPreparationConfig,
} from './shellSpawnPreparation.js';



export { BRAND_CLI_IDENTIFICATION_ENV_VAR as CLI_IDENTIFICATION_ENV_VAR } from '../config/brand.js';
export const CLI_IDENTIFICATION_ENV_VAR_VALUE = '1';

// We want to allow shell outputs that are close to the context window in size.
// 300,000 lines is roughly equivalent to a large context window, ensuring
// we capture significant output from long-running commands.
export const SCROLLBACK_LIMIT = 300000;

/** A structured result from a shell command execution. */
export type ShellExecutionResult = ExecutionResult;

/** A handle for an ongoing shell execution. */
export type ShellExecutionHandle = ExecutionHandle;

export interface ShellExecutionConfig {
  /** Exact line counts are opt-in and only used for foreground Bash output. */
  exactOutputLineCount?: boolean;
  shellType?: ShellType;
  pager?: string;
  sanitizationConfig: EnvironmentSanitizationConfig;
  // Used for testing
  disableDynamicLineTrimming?: boolean;
  originalCommand?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  /** Absolute timeout in ms passed from model's timeout parameter. */
  absoluteTimeout?: number;
  /** Move the command to the background instead of killing it when the absolute timeout expires. */
  autoBackgroundOnTimeout?: boolean;
  /** Register the command as background work before returning its execution handle. */
  startInBackground?: {
    reason: BackgroundReason;
    disableStallWatchdog?: boolean;
  };
  /** Prevent CWD updates after command execution. Set to true for subagent shell commands. */
  preventCwdChanges?: boolean;
  /** Controls background completion notification behavior for this execution. */
  completionBehavior?: CompletionBehavior;
  /** Model metadata of the current invocation, interpreted by product tools. */
  modelDisplayName?: string;
  modelKey?: string;
  environmentPreparation?: ShellSpawnPreparationConfig['environmentPreparation'];
  /** Preserve stdout and stderr as separate result fields. */
  preserveStdoutAndStderr?: boolean;
  /** Stable task ID exposed to tools and SDK consumers. */
  taskId?: string;
  ownerAgentId?: string;
  taskKind?: 'bash' | 'monitor';
  taskDescription?: string;
  toolUseId?: string;
  /** Per-turn identity snapshot inherited by background task notifications. */
  customContext?: Readonly<Record<string, string>>;
  /** Monitor uses pipe mode so stdout can be decoded as events. */
  stdoutToFile?: boolean;
  persistOutputToFile?: boolean;
  onStdout?: (chunk: string) => void;
  /**
   * Session-owned shell inputs, normally the Config that produced this bag via
   * `Config.getShellExecutionConfig()`. Forwarded verbatim to Shell.exec so the
   * shared per-shell-type provider reads the calling session's values.
   */
  sessionContext?: ShellSessionContext;
}

/**
 * Describes a structured event emitted during shell command execution.
 */
export type ShellOutputEvent = ExecutionOutputEvent;

export type BackgroundProcessRecord = {
  command: string;
  status: 'running' | 'exited';
  exitCode?: number | null;
  signal?: number | null;
  outputPath?: string;
  startTime: number;
  endTime?: number;
};

/**
 * A centralized service for executing shell commands with robust process
 * management, cross-platform compatibility, and streaming output capabilities.
 *
 * Phase 5: Internally delegates to Shell.exec() for command assembly,
 * process lifecycle, and CWD tracking. Retains responsibility for:
 * - Environment sanitization (via transformSpawn)
 * - Binary output detection
 * - ExecutionLifecycleService bridging
 * - Background process logging and history
 */
export class ShellExecutionService {
  private static backgroundProcessHistory = new Map<
    string, // sessionId
    Map<number, BackgroundProcessRecord>
  >();
  /** Tracks the ShellCommand for each active execution by PID. */
  private static activeCommands = new Map<number, ShellCommand>();
  /** Tracks the accumulated output getter for each execution (closure over local state). */
  private static activeOutputGetters = new Map<number, () => string>();
  /** Tracks stall watchdog cancel functions by PID. */
  private static stallWatchdogCancels = new Map<number, () => void>();

  private static formatShellBackgroundCompletion(
    _output: string,
    error?: Error,
  ): string {
    const status = error ? `with error: ${error.message}` : 'successfully';
    return `[Background command completed ${status}]`;
  }

  /** Returns the output file path for a background process by PID. */
  static getOutputFilePath(pid: number): string | undefined {
    const cmd = this.activeCommands.get(pid);
    if (cmd?.taskOutput) {
      return cmd.taskOutput.path;
    }
    // Fallback to stored outputPath in history
    for (const history of this.backgroundProcessHistory.values()) {
      const record = history.get(pid);
      if (record?.outputPath) {
        return record.outputPath;
      }
    }
    return undefined;
  }

  /**
   * Executes a shell command using Shell.exec(), capturing all output and
   * lifecycle events. Uses file mode (stdoutToFile) with onProgress callback
   * for output streaming.
   */
  static async execute(
    commandToExecute: string,
    cwd: string,
    onOutputEvent: (event: ShellOutputEvent) => void,
    abortSignal: AbortSignal,
    shellExecutionConfig: ShellExecutionConfig,
  ): Promise<ShellExecutionHandle> {
    return this.executeImpl(
      commandToExecute,
      cwd,
      onOutputEvent,
      abortSignal,
      shellExecutionConfig,
    );
  }

  private static async executeImpl(
    commandToExecute: string,
    cwd: string,
    onOutputEvent: (event: ShellOutputEvent) => void,
    abortSignal: AbortSignal,
    shellExecutionConfig: ShellExecutionConfig,
  ): Promise<ShellExecutionHandle> {
    try {
      runLogger.debug(
        `[ShellExecService] execute: command=${truncateString(commandToExecute, 120, '...')}, ` +
          `cwd=${cwd}, session=${shellExecutionConfig.sessionId ?? 'default'}`,
      );
      emitShellStarted({
        sessionId: shellExecutionConfig.sessionId,
        turnId: shellExecutionConfig.turnId,
        toolCallId: shellExecutionConfig.toolCallId,
        command: commandToExecute,
        cwd,
        shellType: shellExecutionConfig.shellType ?? DEFAULT_SHELL_TYPE,
      });

      // Output state — progress snapshots replace rather than accumulate
      let latestOutput = '';
      let completedOutput = '';
      let completedProcessTiming: ExecResult['processTiming'];
      let latestTotalBytes = 0;
      let latestExactLines: number | undefined;
      // eslint-disable-next-line prefer-const -- assigned after shellExec(), but captured by execOptions and result handlers below
      let currentPid: number | undefined;
      // eslint-disable-next-line prefer-const -- assigned after shellExec(), but captured by closures in execOptions above
      let taskOutput: TaskOutput | undefined;
      const exactLineCounting = shellExecutionConfig.exactOutputLineCount === true &&
        !shellExecutionConfig.startInBackground &&
        (shellExecutionConfig.stdoutToFile ?? !shellExecutionConfig.preserveStdoutAndStderr) &&
        (shellExecutionConfig.shellType ?? DEFAULT_SHELL_TYPE) === 'bash' &&
        (shellExecutionConfig.taskKind ?? 'bash') === 'bash';

      const transformSpawn = buildShellSpawnTransform(shellExecutionConfig);

      const execOptions: ExecOptions = {
        cwd,
        sessionContext: shellExecutionConfig.sessionContext,
        preventCwdChanges: shellExecutionConfig.preventCwdChanges ?? false,
        transformSpawn,
        stdoutToFile:
          shellExecutionConfig.stdoutToFile ??
          !shellExecutionConfig.preserveStdoutAndStderr,
        persistOutputToFile: shellExecutionConfig.persistOutputToFile ?? false,
        taskId: shellExecutionConfig.taskId,
        onStdout: shellExecutionConfig.onStdout,
        timeout: shellExecutionConfig.absoluteTimeout,
        shouldAutoBackground: shellExecutionConfig.autoBackgroundOnTimeout,
        onProgress: (
          _lastLines: string,
          allLines: string,
          _totalLines: number,
          _totalBytes: number,
          _isIncomplete: boolean,
          exactTotalLines?: number,
        ) => {
          // Skip no-op updates when neither content nor file size changed.
          // Content alone is insufficient: for repetitive output (e.g.
          // `while true; do echo "test"; done`), the tail-100-lines window
          // returns the same string even as the file grows. Checking
          // totalBytes ensures we still propagate progress.
          if (allLines === latestOutput && _totalBytes === latestTotalBytes &&
            exactTotalLines === latestExactLines)
            return;
          if (runLogger.isDebugEnabled) {
            runLogger.debug(
              `[ShellExecService] onProgress: totalLines=${_totalLines}, totalBytes=${_totalBytes}, outputLen=${allLines.length}, isIncomplete=${_isIncomplete}`,
            );
          }
          latestOutput = allLines;
          latestTotalBytes = _totalBytes;
          latestExactLines = exactTotalLines;

          const event: ShellOutputEvent = {
            type: 'data',
            chunk: allLines,
            totalLines: exactLineCounting && taskOutput?.exactLineCountingEnabled
              ? exactTotalLines : _totalLines,
            totalBytes: _totalBytes,
            isSnapshot: true,
          };
          onOutputEvent(event);
          if (currentPid) {
            ExecutionLifecycleService.emitEvent(currentPid, event);
          }
        },
      };

      // Execute via the new Shell infrastructure
      const shellCommand: ShellCommand = await shellExec(
        commandToExecute,
        abortSignal,
        shellExecutionConfig.shellType ?? DEFAULT_SHELL_TYPE,
        execOptions,
      );

      taskOutput = shellCommand.taskOutput;
      // 单次结算入口：正常完成、终止失败和完成链异常都走这里，保证 cleanup
      // 与 completeWithResult 不会被遗漏；重复调用时 lifecycle 会直接跳过。
      const settleShellExecution = (
        resultPayload: ShellExecutionResult,
      ): void => {
        if (!currentPid) {
          return;
        }
        try {
          ShellExecutionService.stallWatchdogCancels.get(currentPid)?.();
          ShellExecutionService.stallWatchdogCancels.delete(currentPid);
          if (shellCommand.taskOutput) {
            TaskOutput.stopPolling(shellCommand.taskOutput.taskId);
          }
          ShellExecutionService.activeCommands.delete(currentPid);
          ShellExecutionService.activeOutputGetters.delete(currentPid);
          shellCommand.cleanup();
        } catch (cleanupError) {
          runLogger.warn(
            `[ShellExecService] pid=${currentPid} cleanup failed after execution: ${String(cleanupError)}`,
          );
        } finally {
          ExecutionLifecycleService.completeWithResult(
            currentPid,
            resultPayload,
          );
        }
      };

      // ShellCommand 在进程树终止失败时会 reject result（例如超时 kill 与
      // 进程自然退出竞争，taskkill 因 leader 已退出而失败）。这里必须转换
      // 成失败结果：否则下面的完成链不会执行，lifecycle 永远不会结算，
      // 工具调用会永久挂起，只能靠中断会话恢复。
      const commandResult = shellCommand.result.catch(
        async (error: unknown): Promise<ExecResult> => {
          const terminationError =
            error instanceof Error ? error : new Error(String(error));
          const terminationResult =
            error instanceof ShellTerminationError ? error.result : undefined;
          let stdout = terminationResult?.stdout ?? latestOutput;
          let stderr = terminationResult?.stderr ?? '';
          if (
            !terminationResult &&
            shellExecutionConfig.preserveStdoutAndStderr === true
          ) {
            try {
              await shellCommand.taskOutput?.flush();
              stdout =
                (await shellCommand.taskOutput?.getStdout()) || latestOutput;
              stderr = shellCommand.taskOutput?.getStderr() ?? '';
            } catch {
              stdout = latestOutput;
              stderr = '';
            }
          }
          const terminationNotice =
            `Process tree termination failed; the command result could not be confirmed.\n` +
            terminationError.message;
          stderr = stderr ? `${stderr}\n${terminationNotice}` : terminationNotice;
          runLogger.warn(
            `[ShellExecService] pid=${shellCommand.pid} shell result rejected before completion: ${terminationError.message}`,
          );
          return {
            ...terminationResult,
            stdout,
            stderr,
            code: terminationResult?.code ?? 1,
            interrupted: terminationResult?.interrupted ?? false,
            timedOut: terminationResult?.timedOut,
            outputLimitExceeded: terminationResult?.outputLimitExceeded,
            terminationError: terminationError.message,
          };
        },
      );

      const resultPromise = commandResult.then(
        async (execResult: ExecResult): Promise<ShellExecutionResult> => {
          completedProcessTiming = execResult.processTiming;
          const preserveStreams =
            shellExecutionConfig.preserveStdoutAndStderr === true;
          let stdout = '';
          let stderr = '';

          // Read final output from TaskOutput in file mode. Stream-preserving
          // callers use pipe mode so stdout/stderr remain independently
          // available without changing the existing Bash result contract.
          let finalOutput: string;
          if (preserveStreams) {
            stdout = stripAnsi(execResult.stdout).trimEnd();
            stderr = stripAnsi(execResult.stderr).trimEnd();
            finalOutput = [stdout, stderr].filter(Boolean).join('\n');
          } else {
            try {
              await shellCommand.taskOutput?.flush();
              finalOutput = await shellCommand.taskOutput!.getStdout();
            } catch {
              finalOutput = latestOutput;
            }
          }

          // Clean up foreground .output files: delete small ones (already in
          // memory), pass large ones to shell.ts for persistence.
          const isForegroundFileOutput =
            shellCommand.taskOutput?.stdoutToFile &&
            !execResult.backgroundTaskId;
          const hasSpilledPipeOutput =
            preserveStreams &&
            shellCommand.taskOutput?.isOverflowed === true &&
            !execResult.backgroundTaskId;
          let hasLargeOutputFile = false;
          if (isForegroundFileOutput) {
            if (shellCommand.taskOutput!.outputFileRedundant) {
              void shellCommand.taskOutput!.deleteOutputFile();
            } else {
              hasLargeOutputFile = true;
            }
          }

          const outputIsBinary = isBinary(Buffer.from(finalOutput));
          // Binary detection is diagnostic only: mixed output can contain useful text.
          const output = finalOutput.replace(/^(?:[^\S\n]*\n)+/, '').trimEnd();
          // 完成链后续步骤若抛错，兜底结算仍能带回已经读取到的输出。
          completedOutput = output;

          // Exit codes are ordinary numeric process results and cannot prove
          // that a signal occurred (`exit 137` is valid). Only propagate the
          // signal captured from the child process exit event.
          const exitSignal = execResult.signal ?? null;

          const resultPayload: ShellExecutionResult = {
            processTiming: execResult.processTiming,
            rawOutput: Buffer.from(''),
            output,
            ...(preserveStreams ? { stdout, stderr } : {}),
            exitCode: execResult.code,
            signal: exitSignal,
            error: execResult.preSpawnError
              ? Object.assign(new Error(execResult.preSpawnError), {
                  ...(shellExecutionConfig.shellType === 'powershell'
                    ? { code: execResult.preSpawnErrorCode }
                    : {}),
                })
              : execResult.terminationError
                ? new Error(execResult.terminationError)
                : null,
            aborted: execResult.interrupted || abortSignal.aborted,
            timedOut: execResult.timedOut,
            outputLimitExceeded: execResult.outputLimitExceeded,
            pid: currentPid,
            executionMethod: 'child_process',
            ...(hasLargeOutputFile || hasSpilledPipeOutput
              ? {
                  outputFilePath: shellCommand.taskOutput!.path,
                  outputFileSize: hasSpilledPipeOutput
                    ? shellCommand.taskOutput!.totalBytes
                    : shellCommand.taskOutput!.outputFileSize,
                }
              : {}),
          };

          runLogger.debug(
            `[ShellExecService] pid=${currentPid} completed: exitCode=${execResult.code}, ` +
              `signal=${exitSignal ?? 'none'}, aborted=${resultPayload.aborted}, ` +
              `binary=${outputIsBinary}, outputLen=${output.length}`,
          );
          try {
            emitShellFinished({
              sessionId: shellExecutionConfig.sessionId,
              turnId: shellExecutionConfig.turnId,
              toolCallId: shellExecutionConfig.toolCallId,
              pid: currentPid,
              exitCode: execResult.code,
              signal: exitSignal ?? undefined,
              aborted: resultPayload.aborted,
              binaryOutput: outputIsBinary,
              outputLength: output.length,
              outputPath: shellCommand.taskOutput?.path,
              error: resultPayload.error?.message,
            });
          } catch (diagnosticError) {
            runLogger.warn(
              `[ShellExecService] pid=${currentPid} emitShellFinished failed: ${String(diagnosticError)}`,
            );
          }

          // Emit exit event. A listener failure must not rewrite the command
          // result; lifecycle settlement still publishes its own exit event.
          const exitEvent: ShellOutputEvent = {
            type: 'exit',
            exitCode: execResult.code,
            signal: exitSignal,
          };
          try {
            onOutputEvent(exitEvent);
          } catch (callbackError) {
            runLogger.warn(
              `[ShellExecService] pid=${currentPid} onOutputEvent failed: ${String(callbackError)}`,
            );
          }

          // Update background process history
          const sessionId = shellExecutionConfig.sessionId ?? 'default';
          if (currentPid) {
            const history =
              ShellExecutionService.backgroundProcessHistory.get(sessionId);
            const historyItem = history?.get(currentPid);
            if (historyItem) {
              historyItem.status = 'exited';
              historyItem.exitCode = execResult.code ?? undefined;
              historyItem.signal = exitSignal ?? undefined;
              historyItem.endTime = Date.now();
            }
          }

          settleShellExecution(resultPayload);
          return resultPayload;
        },
      );

      // 完成链自身抛错时也必须结算，否则同样会把工具调用永久挂起。
      void resultPromise.catch((error: unknown) => {
        const completionError =
          error instanceof Error ? error : new Error(String(error));
        runLogger.error(
          `[ShellExecService] pid=${currentPid} completion failed: ${completionError.message}`,
        );
        settleShellExecution({
          processTiming: completedProcessTiming,
          rawOutput: Buffer.from(''),
          output: completedOutput || latestOutput,
          exitCode: 1,
          signal: null,
          error: completionError,
          aborted: abortSignal.aborted,
          pid: currentPid,
          executionMethod: 'child_process',
        });
      });

      // Extract PID from ShellCommand for lifecycle registration
      currentPid = shellCommand.pid;

      // Start TaskOutput polling so onProgress fires for foreground commands too.
      // Without this, file-mode stdout is never read back into JS during execution.
      if (shellCommand.taskOutput) {
        shellCommand.taskOutput.setExactLineCounting(exactLineCounting);
        TaskOutput.startPolling(shellCommand.taskOutput.taskId);
      }

      if (currentPid) {
        this.activeCommands.set(currentPid, shellCommand);
        this.activeOutputGetters.set(currentPid, () => latestOutput);

        // Register with ExecutionLifecycleService
        const lifecycleHandle = ExecutionLifecycleService.attachExecution(
          currentPid,
          {
            executionMethod: 'child_process',
            taskId: shellExecutionConfig.taskId,
            sessionId: shellExecutionConfig.sessionId,
            ownerAgentId: shellExecutionConfig.ownerAgentId,
            taskKind: shellExecutionConfig.taskKind ?? 'bash',
            toolUseId: shellExecutionConfig.toolUseId,
            customContext: shellExecutionConfig.customContext,
            backgroundControlType:
              (shellExecutionConfig.taskKind ?? 'bash') === 'bash'
                ? 'local_bash'
                : undefined,
            label: shellExecutionConfig.taskDescription ?? commandToExecute,
            command: commandToExecute,
            shellType: shellExecutionConfig.shellType,
            outputPath: shellCommand.taskOutput?.path,
            getBackgroundOutput: () => {
              const getter = this.activeOutputGetters.get(currentPid);
              return getter ? getter() : latestOutput;
            },
            getSubscriptionSnapshot: () => latestOutput || undefined,
            writeInput: () => {
              // stdin is redirected to /dev/null by bashProvider
            },
            kill: async () => {
              await shellCommand.kill();
              if (currentPid) {
                this.activeCommands.delete(currentPid);
              }
            },
            isActive: () =>
              shellCommand.status === 'running' ||
              shellCommand.status === 'backgrounded',
            formatInjection: (output, error) =>
              ShellExecutionService.formatShellBackgroundCompletion(
                output,
                error ?? undefined,
              ),
            completionBehavior:
              shellExecutionConfig.completionBehavior ?? 'notify',
          },
        );

        if (shellExecutionConfig.startInBackground) {
          ShellExecutionService.background(
            currentPid,
            shellExecutionConfig.sessionId,
            shellExecutionConfig.originalCommand ?? commandToExecute,
            shellExecutionConfig.startInBackground.reason,
            shellExecutionConfig.taskId,
            shellExecutionConfig.startInBackground.disableStallWatchdog,
          );
        }

        if (shellExecutionConfig.autoBackgroundOnTimeout) {
          shellCommand.onTimeout?.(() => {
            if (!currentPid) {
              return;
            }
            ShellExecutionService.background(
              currentPid,
              shellExecutionConfig.sessionId,
              shellExecutionConfig.originalCommand ?? commandToExecute,
              'timeout',
              shellExecutionConfig.taskId,
            );
          });
        }

        return {
          pid: currentPid,
          result: lifecycleHandle.result,
        };
      }

      // No pid available (shouldn't happen in practice)
      return {
        pid: undefined,
        result: resultPromise,
      };
    } catch (e) {
      const error = e as Error;
      runLogger.error(`[ShellExecService] execute failed: ${error.message}`);
      emitShellFailed({
        sessionId: shellExecutionConfig.sessionId,
        turnId: shellExecutionConfig.turnId,
        toolCallId: shellExecutionConfig.toolCallId,
        command: commandToExecute,
        cwd,
        error: error.stack || error.message,
      });
      return {
        pid: undefined,
        result: Promise.resolve({
          error,
          rawOutput: Buffer.from(''),
          output: '',
          exitCode: 1,
          signal: null,
          aborted: false,
          pid: undefined,
          executionMethod: 'none',
        }),
      };
    }
  }

  /**
   * Writes a string to the stdin of a running process.
   */
  static writeInput(pid: number, input: string): void {
    ExecutionLifecycleService.writeInput(pid, input);
  }

  static isActive(pid: number): boolean {
    return ExecutionLifecycleService.isActive(pid);
  }

  /**
   * Registers a callback to be invoked when the process with the given PID exits.
   */
  static onExit(
    pid: number,
    callback: (exitCode: number, signal?: number) => void,
  ): () => void {
    return ExecutionLifecycleService.onExit(pid, callback);
  }

  /**
   * Kills a process by its PID.
   */
  static async kill(pid: number): Promise<void> {
    runLogger.debug(`[ShellExecService] kill: pid=${pid}`);
    emitShellKillRequested(pid);
    // Cancel stall watchdog if running
    this.stallWatchdogCancels.get(pid)?.();
    this.stallWatchdogCancels.delete(pid);
    const cmd = this.activeCommands.get(pid);
    await ExecutionLifecycleService.kill(pid);
    if (cmd) {
      cmd.cleanup();
    }
  }

  /**
   * Moves a running shell command to the background.
   */
  static background(
    pid: number,
    sessionId?: string,
    command?: string,
    reason?: BackgroundReason,
    taskId?: string,
    disableStallWatchdog = false,
  ): void {
    runLogger.debug(
      `[ShellExecService] background: pid=${pid}, session=${sessionId ?? 'default'}, ` +
        `command=${truncateString(command ?? 'unknown', 80, '...')}`,
    );
    emitShellBackgrounded({
      sessionId,
      pid,
      command,
    });
    const shellCmd = this.activeCommands.get(pid);
    const resolvedSessionId = sessionId || 'default';
    const resolvedCommand = command || 'unknown command';

    const MAX_BACKGROUND_PROCESS_HISTORY_SIZE = 100;
    const history =
      this.backgroundProcessHistory.get(resolvedSessionId) ??
      new Map<number, BackgroundProcessRecord>();

    if (history.size >= MAX_BACKGROUND_PROCESS_HISTORY_SIZE) {
      const oldestPid = history.keys().next().value;
      if (oldestPid !== undefined) {
        history.delete(oldestPid);
      }
    }

    // Store the output file path from the ShellCommand's TaskOutput
    const outputPath = shellCmd?.taskOutput?.path;

    history.set(pid, {
      command: resolvedCommand,
      status: 'running',
      startTime: Date.now(),
      outputPath,
    });
    this.backgroundProcessHistory.set(resolvedSessionId, history);

    // Start TaskOutput polling so onProgress fires while backgrounded.
    // This drives live output updates to UI subscribers via ExecutionLifecycleService.
    if (shellCmd?.taskOutput) {
      shellCmd.taskOutput.setExactLineCounting(false);
      TaskOutput.startPolling(shellCmd.taskOutput.taskId);
    }

    if (shellCmd) {
      shellCmd.background(taskId ?? `bg-${pid}`);
    }

    const backgroundInfo = ExecutionLifecycleService.background(pid, reason);

    if (shellCmd?.taskOutput) {
      const taskOutputPath = shellCmd.taskOutput.path;
      void tailFile(taskOutputPath, PROGRESS_TAIL_BYTES).then(
        ({ content, bytesTotal }) => {
          if (!content) return;
          ExecutionLifecycleService.emitEvent(pid, {
            type: 'data',
            chunk: content,
            totalBytes: bytesTotal,
            isSnapshot: true,
          });
        },
        () => {
          // Output file may not be ready yet; regular polling will retry.
        },
      );
    }

    // Start stall watchdog for background commands with output files
    if (outputPath && backgroundInfo?.taskId && !disableStallWatchdog) {
      const cancel = startStallWatchdog({
        taskId: backgroundInfo.taskId,
        outputPath: backgroundInfo.outputPath ?? outputPath,
        description:
          backgroundInfo.command ?? backgroundInfo.label ?? resolvedCommand,
        toolUseId: backgroundInfo.toolUseId,
        targetAgentId: backgroundInfo.ownerAgentId,
        sessionId: backgroundInfo.sessionId,
        customContext: backgroundInfo.customContext,
      });
      this.stallWatchdogCancels.set(pid, cancel);
    }
  }

  static subscribe(
    pid: number,
    listener: (event: ShellOutputEvent) => void,
  ): () => void {
    return ExecutionLifecycleService.subscribe(pid, listener);
  }
}
