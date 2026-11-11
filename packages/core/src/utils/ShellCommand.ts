/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process lifecycle wrapper for shell command execution.
 * Encapsulates a child process with state machine, timeout handling,
 * backgrounding, and process tree cleanup.
 */

import type { ChildProcess } from 'node:child_process';
import os, { constants as osConstants } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { killProcessGroup } from './process-utils.js';
import { stat as fsStat } from 'node:fs/promises';
import type { ShellType } from './shell/shellProvider.js';
import type { TaskOutput } from './task/TaskOutput.js';
import {
  MAX_TASK_OUTPUT_BYTES,
  MAX_TASK_OUTPUT_BYTES_DISPLAY,
} from './task/diskOutput.js';
import { runLogger } from './runLogger.js';

const WINDOWS_KILL_RETRY_DELAY_MS = 1500;

/** Root shell process timing, captured before output/cleanup processing. */
export interface ProcessExecutionTiming {
  startedAt: number;
  endedAt: number;
  /** Monotonic elapsed time; wall-clock corrections must not change runtime. */
  durationMs: number;
}

/** Result of a shell command execution. */
export type ExecResult = {
  processTiming?: ProcessExecutionTiming;
  stdout: string;
  stderr: string;
  code: number;
  /** Actual terminating signal number reported by the child process. */
  signal?: number;
  interrupted: boolean;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
  backgroundTaskId?: string;
  backgroundedByUser?: boolean;
  assistantAutoBackgrounded?: boolean;
  outputFilePath?: string;
  outputFileSize?: number;
  preSpawnError?: string;
  preSpawnErrorCode?: string;
  /**
   * 进程树终止失败时，调用方无法确认命令的最终状态。此时 result 会以
   * rejection 传播，服务层需要把它转换为可结算的失败结果而不是继续等待。
   */
  terminationError?: string;
};

/**
 * Rejection reason used when the command exited but its process tree could not
 * be confirmed terminated. `result` is the terminal result computed from the
 * child exit, so consumers can settle with the real exit code, output, and
 * background identity instead of leaving the tool call pending.
 */
export class ShellTerminationError extends Error {
  readonly result: ExecResult;

  constructor(message: string, cause: unknown, result: ExecResult) {
    super(message, { cause });
    this.name = 'ShellTerminationError';
    this.result = result;
  }
}

/** Public interface for a shell command. */
export type ShellCommand = {
  /** Process ID of the underlying child process. */
  pid: number | undefined;
  /** Attempt to background this command. Returns true if successful. */
  background: (backgroundTaskId: string) => boolean;
  /**
   * Promise that resolves when the command completes.
   *
   * Rejects with a {@link ShellTerminationError} when the root process exited
   * but the process tree termination failed, so the final state cannot be
   * confirmed. Every consumer must convert that rejection into a settled
   * result; otherwise the tool call stays pending forever.
   */
  result: Promise<ExecResult>;
  /** Kill the process tree. */
  kill: () => Promise<void>;
  /** Current state of the command. */
  status: 'running' | 'backgrounded' | 'completed' | 'killed';
  /** Cleanup resources. */
  cleanup: () => void;
  /** Register a callback for timeout events. */
  onTimeout?: (
    callback: (backgroundFn: (taskId: string) => boolean) => void,
  ) => void;
  /** The TaskOutput instance managing this command's output. May be undefined for synthetic commands. */
  taskOutput: TaskOutput | undefined;
};

/**
 * Wraps stdout/stderr data events into string accumulation.
 */
class StreamWrapper {
  #chunks: string[] = [];
  #stream: Readable | null;

  constructor(stream: Readable | null) {
    this.#stream = stream;
    if (stream) {
      stream.setEncoding('utf-8');
      stream.on('data', (data: string) => {
        // Break SlicedString reference to large data buffers
        this.#chunks.push(Buffer.from(data).toString());
      });
    }
  }

  getOutput(): string {
    return this.#chunks.join('');
  }

  cleanup(): void {
    this.#stream?.removeAllListeners('data');
    this.#stream = null;
    this.#chunks = [];
  }
}

/**
 * Implementation of the ShellCommand interface.
 */
class ShellCommandImpl implements ShellCommand {
  #status: ShellCommand['status'] = 'running';
  readonly #startedAt = Date.now();
  readonly #startedMonotonic = performance.now();
  #backgroundTaskId?: string;
  #stdoutWrapper: StreamWrapper;
  #stderrWrapper: StreamWrapper;
  #childProcess: ChildProcess;
  #timeoutId: ReturnType<typeof setTimeout> | undefined;
  #killedForTimeout = false;
  #killedForOutputLimit = false;
  #abortSignal: AbortSignal;
  #onTimeoutCallback?: (backgroundFn: (taskId: string) => boolean) => void;
  #timeout: number;
  #shouldAutoBackground: boolean;
  #resultResolve!: (result: ExecResult) => void;
  #resultReject!: (error: unknown) => void;
  #isExited = false;
  #killPromise: Promise<void> | undefined;
  #terminationError: unknown;
  #killRequested = false;
  #timeoutAttempted = false;
  #outputLimitAttempted = false;
  #boundAbortHandler: () => void;
  #sizeWatchdogId: ReturnType<typeof setInterval> | undefined;

  result: Promise<ExecResult>;
  pid: number | undefined;
  taskOutput: TaskOutput | undefined;

  constructor(
    childProcess: ChildProcess,
    abortSignal: AbortSignal,
    timeout: number,
    shouldAutoBackground: boolean = false,
    taskOutput?: TaskOutput,
    private readonly shellType: ShellType = 'bash',
  ) {
    this.#childProcess = childProcess;
    this.pid = childProcess.pid;
    this.#abortSignal = abortSignal;
    this.#timeout = timeout;
    this.#shouldAutoBackground = shouldAutoBackground;
    this.taskOutput = taskOutput;

    this.#stdoutWrapper = new StreamWrapper(childProcess.stdout);
    this.#stderrWrapper = new StreamWrapper(childProcess.stderr);

    // In pipe mode with TaskOutput, forward stream data to TaskOutput
    if (taskOutput && !taskOutput.stdoutToFile) {
      if (childProcess.stdout) {
        childProcess.stdout.on('data', (data: Buffer | string) => {
          taskOutput.writeStdout(
            typeof data === 'string' ? data : data.toString('utf-8'),
          );
        });
      }
      if (childProcess.stderr) {
        childProcess.stderr.on('data', (data: Buffer | string) => {
          taskOutput.writeStderr(
            typeof data === 'string' ? data : data.toString('utf-8'),
          );
        });
      }
    }

    // Write to stdin to close it immediately (stdin safety)
    if (childProcess.stdin) {
      childProcess.stdin.end();
    }

    // Set up result promise
    this.result = new Promise<ExecResult>((resolve, reject) => {
      this.#resultResolve = resolve;
      this.#resultReject = reject;
    });

    // Set up timeout
    if (timeout > 0) {
      this.#timeoutId = setTimeout(() => this.#handleTimeout(), timeout);
    }

    // File-mode stdout/stderr bypasses JavaScript and writes directly to disk.
    // Guard it from process start, including while the command is foregrounded.
    this.#startSizeWatchdog();

    // Set up abort handler
    this.#boundAbortHandler = () => {
      if (abortSignal.reason === 'interrupt') {
        return;
      }
      void this.kill().catch(() => {}); // Failure is logged; retain ownership.
    };
    abortSignal.addEventListener('abort', this.#boundAbortHandler, {
      once: true,
    });

    // Listen for exit (not 'close', to avoid waiting for grandchild inherited fds)
    childProcess.on('exit', (code, signal) => {
      this.#handleExit(code, signal);
    });

    // Handle spawn errors
    childProcess.on('error', (err) => {
      runLogger.error(
        `[ShellCommand] pid=${this.pid} spawn error: ${err.message}`,
      );
      this.#handleExit(1, null, err);
    });
  }

  get status(): ShellCommand['status'] {
    return this.#status;
  }

  background(backgroundTaskId: string): boolean {
    if (this.#status !== 'running') {
      return false;
    }

    this.#backgroundTaskId = backgroundTaskId;
    this.#status = 'backgrounded';
    runLogger.debug(
      `[ShellCommand] pid=${this.pid} backgrounded, taskId=${backgroundTaskId}`,
    );

    // Spill any in-memory output to disk when backgrounding
    this.taskOutput?.spillToDisk();

    // Idempotent: file-mode commands are watched from process start.
    this.#startSizeWatchdog();

    // Clear timeout and abort listener when backgrounded
    this.#clearTimeout();
    this.#abortSignal.removeEventListener('abort', this.#boundAbortHandler);

    return true;
  }

  kill(): Promise<void> {
    return this.#startKill(true);
  }

  #startKill(markKilled: boolean): Promise<void> {
    if (this.#killPromise) {
      return this.#killPromise;
    }
    if (this.#isExited && this.#terminationError !== undefined) {
      // The original leader is gone; do not retry against a possibly reused PID.
      return Promise.reject(this.#terminationError);
    }
    if (this.#status === 'completed') {
      return Promise.resolve();
    }

    runLogger.debug(
      `[ShellCommand] pid=${this.pid} kill requested, status=${this.#status}`,
    );
    this.#killRequested = true;
    const previousStatus = this.#status;
    if (markKilled) this.#status = 'killed';
    this.#terminationError = undefined;
    this.#killPromise = this.#doKill().catch((error: unknown) => {
      // A rejected attempt is not a terminal state. Keep the command owned
      // and allow TaskStop or shutdown to retry, without reviving an exited PID.
      if (!this.#isExited) {
        this.#status = previousStatus;
        this.#killedForTimeout = false;
        this.#killedForOutputLimit = false;
      }
      this.#terminationError = error;
      this.#killPromise = undefined;
      runLogger.warn(
        `[ShellCommand] pid=${this.pid} termination failed: ${String(error)}`,
      );
      throw error;
    });
    return this.#killPromise;
  }

  cleanup(): void {
    this.#clearTimeout();
    this.#clearSizeWatchdog();
    this.#stdoutWrapper.cleanup();
    this.#stderrWrapper.cleanup();
    this.taskOutput?.clear();
    this.#abortSignal.removeEventListener('abort', this.#boundAbortHandler);
  }

  onTimeout = (
    callback: (backgroundFn: (taskId: string) => boolean) => void,
  ) => {
    this.#onTimeoutCallback = callback;
  };

  #handleTimeout(): void {
    if (this.#status !== 'running') {
      return;
    }

    runLogger.warn(
      `[ShellCommand] pid=${this.pid} timed out after ${Math.round(this.#timeout / 1000)}s, ` +
        `autoBackground=${this.#shouldAutoBackground}`,
    );

    // If auto-background is enabled and callback is set, try to background
    if (this.#shouldAutoBackground && this.#onTimeoutCallback) {
      this.#onTimeoutCallback((taskId: string) => this.background(taskId));
      return;
    }

    // Otherwise, kill with SIGTERM, escalate to SIGKILL after timeout
    this.#timeoutAttempted = true;
    this.#killedForTimeout = true;
    // Timeout handling is synchronous; process completion is reported via #handleExit.
    void this.#startKill(false).catch(() => {});
  }

  async #doKill(): Promise<void> {
    const pid = this.#childProcess.pid;
    if (pid === undefined) {
      return;
    }

    const maxAttempts = os.platform() === 'win32' ? 2 : 1;
    const rootExited = () =>
      this.#isExited ||
      this.#childProcess.exitCode != null ||
      this.#childProcess.signalCode != null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      try {
        await killProcessGroup({
          pid,
          escalate: true,
          isLeaderExited: rootExited,
        });
        runLogger.debug(
          `[ShellCommand] pid=${pid} termination succeeded, attempt=${attempt}/${maxAttempts}, elapsedMs=${Date.now() - startedAt}`,
        );
        return;
      } catch (error) {
        runLogger.warn(
          `[ShellCommand] pid=${pid} termination attempt failed, attempt=${attempt}/${maxAttempts}, elapsedMs=${Date.now() - startedAt}, error=${String(error)}`,
        );
        if (attempt === maxAttempts) throw error;
        if (!rootExited()) {
          runLogger.debug(
            `[ShellCommand] pid=${pid} retrying termination after ${WINDOWS_KILL_RETRY_DELAY_MS}ms`,
          );
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, WINDOWS_KILL_RETRY_DELAY_MS);
            timer.unref?.();
          });
        }
        // Do not send a delayed taskkill to a PID whose original child exited.
        // Root exit alone cannot prove that its descendants were reclaimed.
        if (rootExited()) {
          runLogger.warn(
            `[ShellCommand] pid=${pid} termination retry skipped: original child exited; descendant cleanup is unconfirmed`,
          );
          throw error;
        }
      }
    }
  }

  #clearTimeout(): void {
    if (this.#timeoutId !== undefined) {
      clearTimeout(this.#timeoutId);
      this.#timeoutId = undefined;
    }
  }

  #clearSizeWatchdog(): void {
    if (this.#sizeWatchdogId !== undefined) {
      clearInterval(this.#sizeWatchdogId);
      this.#sizeWatchdogId = undefined;
    }
  }

  #startSizeWatchdog(): void {
    if (!this.taskOutput?.stdoutToFile || this.#sizeWatchdogId !== undefined) {
      return;
    }
    this.#sizeWatchdogId = setInterval(() => {
      void this.#checkFileSize();
    }, 5000);
    this.#sizeWatchdogId.unref();
  }

  async #checkFileSize(): Promise<void> {
    if (!this.taskOutput?.stdoutToFile) {
      return;
    }
    try {
      const stats = await fsStat(this.taskOutput.path);
      if (
        stats.size > MAX_TASK_OUTPUT_BYTES &&
        (this.#status === 'running' || this.#status === 'backgrounded') &&
        !this.#isExited
      ) {
        this.#outputLimitAttempted = true;
        this.#killedForOutputLimit = true;
        this.#clearSizeWatchdog();
        runLogger.warn(
          `[ShellCommand] pid=${this.pid} output file exceeded ${MAX_TASK_OUTPUT_BYTES} bytes ` +
            `(${stats.size}), terminating process group`,
        );
        void this.kill().catch(() => {});
      }
    } catch {
      // File may not exist yet
    }
  }

  #handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ): void {
    if (this.#isExited) return;
    this.#isExited = true;
    const processTiming: ProcessExecutionTiming = {
      startedAt: this.#startedAt,
      endedAt: Date.now(),
      durationMs: Math.max(
        0,
        Math.round(performance.now() - this.#startedMonotonic),
      ),
    };

    if (this.#status === 'running' || this.#status === 'backgrounded') {
      this.#status = 'completed';
    }

    this.#clearTimeout();
    this.#clearSizeWatchdog();
    this.#abortSignal.removeEventListener('abort', this.#boundAbortHandler);

    const signalNumber = signal ? osConstants.signals[signal] : undefined;
    let exitCode = code ?? (signalNumber ? 128 + signalNumber : 1);
    if (error) {
      exitCode = 1;
    }

    runLogger.debug(
      `[ShellCommand] pid=${this.pid} exited: code=${exitCode}, signal=${signal ?? 'none'}, ` +
        `timedOut=${this.#killedForTimeout}, status=${this.#status}` +
        (error ? `, error=${error.message}` : ''),
    );

    let stderr = this.#stderrWrapper.getOutput();
    if (this.#killedForTimeout) {
      stderr =
        `Command timed out after ${Math.round(this.#timeout / 1000)}s and was terminated.\n` +
        stderr;
    }
    if (this.#killedForOutputLimit) {
      stderr =
        `Command killed: output file exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY}.\n` +
        stderr;
    }
    if (error) {
      stderr = `Process error: ${error.message}\n` + stderr;
    }

    const result: ExecResult = {
      processTiming,
      stdout: this.#stdoutWrapper.getOutput(),
      stderr,
      code: exitCode,
      ...(this.shellType === 'powershell' && error && this.pid === undefined
        ? {
            preSpawnError: error.message,
            preSpawnErrorCode: (error as NodeJS.ErrnoException).code,
          }
        : {}),
      ...(signalNumber ? { signal: signalNumber } : {}),
      interrupted: this.#status === 'killed' || this.#abortSignal.aborted,
      timedOut: this.#killedForTimeout,
      outputLimitExceeded: this.#killedForOutputLimit,
      backgroundTaskId: this.#backgroundTaskId,
      outputFilePath: this.taskOutput?.stdoutToFile
        ? this.taskOutput.path
        : undefined,
    };

    // A root exit can precede termination of its descendants. A cancelled tool
    // must not publish its final result (or release lifecycle ownership) until
    // the termination attempt settles. Propagate failure instead of claiming
    // that an unconfirmed process tree has completed.
    const buildTerminationError = (cause: unknown): ShellTerminationError => {
      const message = cause instanceof Error ? cause.message : String(cause);
      return new ShellTerminationError(message, cause, {
        ...result,
        interrupted: result.interrupted || this.#killRequested,
        timedOut: result.timedOut === true || this.#timeoutAttempted,
        outputLimitExceeded:
          result.outputLimitExceeded === true || this.#outputLimitAttempted,
      });
    };

    if (this.#killPromise) {
      void this.#killPromise.then(
        () => this.#resultResolve(result),
        (error: unknown) =>
          this.#resultReject(buildTerminationError(error)),
      );
    } else if (this.#terminationError !== undefined) {
      this.#resultReject(buildTerminationError(this.#terminationError));
    } else {
      this.#resultResolve(result);
    }
  }
}

/**
 * Wraps a spawned child process into a ShellCommand with lifecycle management.
 *
 * @param childProcess - The spawned child process.
 * @param abortSignal - Signal to abort the command.
 * @param timeout - Timeout in milliseconds (0 = no timeout).
 * @param shouldAutoBackground - Whether to auto-background on timeout instead of killing.
 */
export function wrapSpawn(
  childProcess: ChildProcess,
  abortSignal: AbortSignal,
  timeout: number,
  shouldAutoBackground?: boolean,
  taskOutput?: TaskOutput,
  shellType: ShellType = 'bash',
): ShellCommand {
  return new ShellCommandImpl(
    childProcess,
    abortSignal,
    timeout,
    shouldAutoBackground,
    taskOutput,
    shellType,
  );
}

/**
 * Creates a ShellCommand that represents an already-aborted command.
 */
export function createAbortedCommand(
  backgroundTaskId?: string,
  opts?: { stderr?: string; code?: number },
): ShellCommand {
  const result: ExecResult = {
    stdout: '',
    stderr: opts?.stderr ?? '',
    code: opts?.code ?? 145,
    interrupted: true,
    backgroundTaskId,
  };

  return {
    pid: undefined,
    background: () => false,
    result: Promise.resolve(result),
    kill: async () => {},
    status: 'completed' as const,
    cleanup: () => {},
    taskOutput: undefined,
  };
}

/**
 * Creates a ShellCommand that represents a pre-spawn failure.
 */
export function createFailedCommand(preSpawnError: string): ShellCommand {
  const result: ExecResult = {
    stdout: '',
    stderr: '',
    code: 1,
    interrupted: false,
    preSpawnError,
  };

  return {
    pid: undefined,
    background: () => false,
    result: Promise.resolve(result),
    kill: async () => {},
    status: 'completed' as const,
    cleanup: () => {},
    taskOutput: undefined,
  };
}
