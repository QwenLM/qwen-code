/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExecutionLifecycleService,
  ExitCodes,
  SessionEndReason,
  sessionLogger,
  redactSecrets,
  stopDetachedProcessGuard,
  drainDetachedProcessGuard,
  runLogger,
} from '@qwen-code/core';
import type { Config, ExitReason } from '@qwen-code/core';
import { isMainThread } from 'node:worker_threads';
import { onExit } from 'signal-exit';
import { exitOrKill as exitRuntime } from './exitOrKill.js';

function exitOrKill(code: number): never {
  return exitRuntime(
    code,
    () => sessionLogger.getProcessLogPath(),
    (text) => redactSecrets(text),
  );
}

/**
 * Force-exit after cleanup did not finish in time. Records `cleanup_timeout`
 * as the exit context (first-call-wins, so a real root cause set earlier
 * still survives) and exits via {@link exitOrKill}.
 */
export function forceExit(code: number): never {
  sessionLogger.setExitContext({
    reason: 'cleanup_timeout',
    exit_code: code,
    message: 'force exiting process',
    source: 'cleanup.forceExit',
  });
  exitOrKill(code);
}

const cleanupFunctions: Array<(() => void) | (() => Promise<void>)> = [];
type SessionEndCleanupFunction = (
  reason: SessionEndReason,
) => Promise<void>;

const sessionEndCleanupFunctions: SessionEndCleanupFunction[] = [];
const syncCleanupFunctions: Array<() => void> = [];
const exitCancellations = new Set<() => void | Promise<void>>();

/** Cancel in-flight session work before waiting for shutdown hooks/resources. */
export function registerExitCancellation(cancel: () => void | Promise<void>): () => void {
  exitCancellations.add(cancel);
  return () => { exitCancellations.delete(cancel); };
}
let cancelAppInitialization: (() => void) | undefined;
let disposeApp: (() => Promise<void>) | undefined;

/** 应用准备的取消和共享资源的最终释放，不能混进并行的 SessionEnd 清理。 */
export function registerApplicationLifecycle(input: {
  cancelInitialization(): void;
  dispose(): Promise<void>;
}): void {
  cancelAppInitialization = input.cancelInitialization;
  disposeApp = input.dispose;
}
// Single-process multi-session keeps one Config per live session; every
// registered config gets its own disposal pass at process exit.
// Keyed by object identity because a session's Config instance is unique.
const exitConfigs = new Set<Config>();
let isShuttingDown = false;
let exitCleanupPromise: Promise<void> | null = null;
let gracefulExitPromise: Promise<never> | null = null;
let sessionDrainTimedOut = false;
let sessionDrainCompletedAt: number | undefined;
const sessionDrainListeners = new Set<() => void>();

export function registerCleanup(fn: (() => void) | (() => Promise<void>)) {
  cleanupFunctions.push(fn);
  return () => {
    const index = cleanupFunctions.indexOf(fn);
    if (index !== -1) cleanupFunctions.splice(index, 1);
  };
}

/**
 * Register work that belongs to the SessionEnd shutdown phase.
 *
 * SessionEnd is kept separate from general cleanup so a slow watcher or
 * service cannot prevent the hook from receiving its own timeout
 * budget. Registrations are still single-shot because the entire exit cleanup
 * pipeline is shared by all shutdown callers.
 */
export function registerSessionEndCleanup(fn: SessionEndCleanupFunction) {
  sessionEndCleanupFunctions.push(fn);
}

export function registerSyncCleanup(fn: () => void) {
  syncCleanupFunctions.push(fn);
}

/**
 * Resets the internal cleanup state for testing purposes.
 * This allows tests to run in isolation without vi.resetModules().
 */
export function resetCleanupForTesting() {
  cleanupFunctions.length = 0;
  sessionEndCleanupFunctions.length = 0;
  syncCleanupFunctions.length = 0;
  exitCancellations.clear();
  cancelAppInitialization = undefined;
  disposeApp = undefined;
  exitConfigs.clear();
  isShuttingDown = false;
  exitCleanupPromise = null;
  gracefulExitPromise = null;
  sessionDrainTimedOut = false;
  sessionDrainCompletedAt = undefined;
  sessionDrainListeners.clear();
}

export function runSyncCleanup() {
  for (const fn of syncCleanupFunctions) {
    try {
      fn();
    } catch {
      // Ignore errors during cleanup.
    }
  }
  syncCleanupFunctions.length = 0;
}

/**
 * Register a session's config instance for disposal at process exit.
 * Each session in a single-process multi-session runtime registers its own
 * config; registering the same instance again is a no-op.
 */
export function registerExitConfig(config: Config) {
  exitConfigs.add(config);
}

/**
 * Drop a session's config from the exit pipeline when the session ends
 * before the process does. The caller owns the final dispose of the
 * config; this only stops process-exit cleanup from touching a dead session.
 */
export function unregisterExitConfig(config: Config) {
  exitConfigs.delete(config);
}

export type CliExitReason =
  | 'user_quit'
  | 'signal_int'
  | 'signal_term'
  | 'error'
  | 'natural_end'
  | 'idle_timeout';

export interface RunExitCleanupOptions {
  exitCode?: number;
  exitReason?: CliExitReason;
  sessionEndReason?: SessionEndReason;
}

export interface RunExitCleanupWithTimeoutOptions
  extends RunExitCleanupOptions {
  timeoutMs?: number;
}

/**
 * Base allowance for non-hook exit cleanup such as watcher close and IDE
 * disconnect. A configured SessionEnd budget is added to this
 * allowance so the outer shutdown guard cannot preempt the hook's own timeout.
 */
export const DEFAULT_EXIT_CLEANUP_TIMEOUT_MS = 5000;
const EXECUTION_TERMINATION_TIMEOUT_MS = 2000;
export const SESSION_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Shared single-flight cleanup pipeline, with no outer deadline of its own.
 * Prefer {@link runExitCleanupWithTimeout} or {@link gracefulExit} — a
 * best-effort shutdown step must not hold an exit path open indefinitely.
 */
export function runExitCleanup(
  options: RunExitCleanupOptions = {},
): Promise<void> {
  if (exitCleanupPromise) {
    return exitCleanupPromise;
  }

  // The first caller owns the cleanup pass. Final
  // process termination is a separate single-flight owned by gracefulExit(),
  // so a signal can still request a bounded exit while this work is in flight.
  isShuttingDown = true;
  cancelAppInitialization?.();
  const drains: Array<void | Promise<void>> = [];
  for (const cancel of exitCancellations) {
    try { drains.push(cancel()); } catch { /* Other sessions must still be cancelled. */ }
  }
  exitCancellations.clear();
  exitCleanupPromise = runExitCleanupOnce(options, drains);
  return exitCleanupPromise;
}

async function runExitCleanupOnce(
  options: RunExitCleanupOptions,
  sessionDrains: Array<void | Promise<void>>,
) {
  // Reserve the hook budget independently of session finalization.
  // A timed-out producer may still borrow Config/plugins: notify,
  // then fail closed at the process boundary instead of disposing underneath it.
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drained = sessionDrains.length === 0 || await Promise.race([
    Promise.allSettled(sessionDrains).then(() => true),
    new Promise<false>((resolve) => {
      drainTimer = setTimeout(() => resolve(false), SESSION_DRAIN_TIMEOUT_MS);
    }),
  ]);
  if (drainTimer) clearTimeout(drainTimer);
  sessionDrainTimedOut = !drained;
  sessionDrainCompletedAt = Date.now();
  for (const listener of sessionDrainListeners) listener();
  sessionDrainListeners.clear();
  if (!drained) {
    try {
      sessionLogger.event({
        level: 'error', kind: 'cli', type: 'cli.exit.drain_timeout',
        data: { timeout_ms: SESSION_DRAIN_TIMEOUT_MS, session_count: sessionDrains.length },
      });
    } catch { /* Diagnostics must not prevent emergency shutdown. */ }
  }
  const sessionEndReason =
    options.sessionEndReason ?? SessionEndReason.Other;

  // Snapshot: a session registered after shutdown started does not join this
  // pass; process exit disposes exactly the configs alive at cleanup start.
  const configs = [...exitConfigs];

  // drain stdin to prevent printing garbage on exit
  // https://github.com/google-gemini/gemini-cli/issues/16801
  await drainStdin();

  // ExecutionLifecycleService owns both foreground and background executions.
  // Give registered process trees a bounded head start before SessionEnd. A
  // broken child termination must not prevent the final notification phase.
  await waitForExecutionTermination();

  if (drained) runSyncCleanup();

  // General cleanup and SessionEnd are independent shutdown phases. Start
  // them together so a slow general cleanup cannot consume the hook's budget
  // before SessionEnd even starts. Individual callbacks retain registration
  // order within their phase.
  await Promise.all([
    runSessionEndCleanupFunctions(sessionEndReason),
    drained ? runGeneralCleanupFunctions() : Promise.resolve(),
  ]);

  for (const config of configs) {
    await runConfigExitCleanup(config, {
      disposeResources: drained,
    });
  }

  if (!drained) {
    // Keep borrowed services alive until the process terminates, but do not
    // abandon detached execution groups or hide an incomplete exit as success.
    stopDetachedProcessGuard();
    throw new Error('Session finalization exceeded the shutdown drain budget');
  }

  // Hook、Config 和上报都结束后，才释放应用共享组件。
  try {
    await disposeApp?.();
  } catch (error) {
    try {
      sessionLogger.event({
        level: 'warn',
        kind: 'cli',
        type: 'cli.framework.dispose_failed',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    } catch {
      /* 退出日志失败不能阻断其余资源的释放。 */
    }
  }
  stopDetachedProcessGuard();
  // Main-process CLI/ACP/Daemon exits retain their non-blocking shutdown.
  // A Worker shares its OS parent with the surviving host and must reap first.
  if (!isMainThread) {
    try {
      await drainDetachedProcessGuard();
    } catch (error) {
      runLogger.warn('[cleanup] child reaping failed', {
        child: 'guard',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  exitConfigs.clear();
}

/**
 * Dispose a session's config during exit. Sequential across configs so shared
 * resources are released one session at a time.
 */
async function runConfigExitCleanup(
  config: Config,
  context: {
    disposeResources: boolean;
  },
): Promise<void> {
  if (context.disposeResources) await config.permission?.dispose();

  try {
    if (context.disposeResources) await config.dispose();
  } catch {
    // Ignore errors during disposal.
  }
}

async function runGeneralCleanupFunctions(): Promise<void> {
  const functions = cleanupFunctions.splice(0);
  for (const fn of functions) {
    try {
      await fn();
    } catch {
      // Ignore errors during cleanup.
    }
  }
}

async function waitForExecutionTermination(): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, EXECUTION_TERMINATION_TIMEOUT_MS);
  });
  await Promise.race([
    ExecutionLifecycleService.terminateAll().catch(() => {}),
    timeout,
  ]);
  if (timeoutId) clearTimeout(timeoutId);
}

async function runSessionEndCleanupFunctions(
  reason: SessionEndReason,
): Promise<void> {
  const functions = sessionEndCleanupFunctions.splice(0);
  for (const fn of functions) {
    try {
      await fn(reason);
    } catch {
      // SessionEnd is notification-only and cannot cancel shutdown.
    }
  }
}

/**
 * Keep the original total deadline as a backstop, but discard unused drain
 * time as soon as that phase ends. Late callers share the phase timestamp so
 * joining an existing cleanup cannot grant a fresh drain allowance.
 * An explicit timeout remains a caller-owned limit for the entire wait.
 */
function createExitCleanupDeadline(
  options: RunExitCleanupWithTimeoutOptions,
  unref: boolean,
): { promise: Promise<'timeout'>; cancel: () => void } {
  const totalBudgetMs =
    options.timeoutMs ?? getExitCleanupTimeoutMs(options.sessionEndReason);
  const totalDeadline = Date.now() + totalBudgetMs;
  let timer: ReturnType<typeof setTimeout>;
  let onDrainCompleted: () => void;
  const promise = new Promise<'timeout'>((resolve) => {
    const arm = (deadline: number) => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          sessionDrainListeners.delete(onDrainCompleted);
          resolve('timeout');
        },
        Math.max(0, deadline - Date.now()),
      );
      if (unref) timer.unref?.();
    };
    onDrainCompleted = () => {
      if (sessionDrainCompletedAt === undefined) return;
      arm(
        Math.min(
          totalDeadline,
          sessionDrainCompletedAt + totalBudgetMs - SESSION_DRAIN_TIMEOUT_MS,
        ),
      );
    };
    arm(totalDeadline);
    if (options.timeoutMs === undefined) {
      if (sessionDrainCompletedAt === undefined) {
        sessionDrainListeners.add(onDrainCompleted);
      } else {
        onDrainCompleted();
      }
    }
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
      sessionDrainListeners.delete(onDrainCompleted);
    },
  };
}

/**
 * Runs {@link runExitCleanup} under a deadline, for callers that must stay
 * responsive even when a cleanup stage stalls.
 *
 * The default deadline reserves a separate drain allowance; unused drain time
 * is discarded before execution termination, cleanup and SessionEnd. Explicit
 * `timeoutMs` overrides the entire wait. The timer is unref'd: losing the race
 * abandons the wait, not the pipeline, which keeps running on the shared promise.
 *
 * @returns `true` if cleanup completed, `false` if the deadline was reached
 * first. Callers that then leave the process should prefer {@link gracefulExit},
 * which turns that `false` into {@link forceExit} and a `cleanup_timeout` exit
 * context instead of discarding it.
 */
export async function runExitCleanupWithTimeout(
  options: RunExitCleanupWithTimeoutOptions = {},
): Promise<boolean> {
  const { timeoutMs: _timeoutMs, ...cleanupOptions } = options;
  const deadline = createExitCleanupDeadline(options, true);

  let result: 'completed' | 'timeout';
  try {
    result = await Promise.race([
      runExitCleanup(cleanupOptions).then(() => 'completed' as const),
      deadline.promise,
    ]);
  } catch (error) {
    if (sessionDrainTimedOut) forceExit(cleanupOptions.exitCode || 1);
    throw error;
  } finally {
    deadline.cancel();
  }

  return result === 'completed';
}

export function getExitCleanupTimeoutMs(
  reason: SessionEndReason = SessionEndReason.Other,
): number {
  try {
    // Every live session's SessionEnd hook gets its budget, so the guard
    // covers the slowest configured hook across all registered configs.
    let sessionEndTimeoutMs = 0;
    for (const config of exitConfigs) {
      sessionEndTimeoutMs = Math.max(
        sessionEndTimeoutMs,
        config.getHookSystem?.()?.getSessionEndTimeoutMs(reason) ?? 0,
      );
    }
    return (
      EXECUTION_TERMINATION_TIMEOUT_MS +
      SESSION_DRAIN_TIMEOUT_MS +
      DEFAULT_EXIT_CLEANUP_TIMEOUT_MS +
      sessionEndTimeoutMs
    );
  } catch {
    // A malformed hook plan must not prevent the rest of shutdown cleanup.
    return SESSION_DRAIN_TIMEOUT_MS + EXECUTION_TERMINATION_TIMEOUT_MS + DEFAULT_EXIT_CLEANUP_TIMEOUT_MS;
  }
}

/**
 * Run the bounded exit cleanup, then exit the process. Picks a clean
 * `process.exit` on success and {@link forceExit} on timeout, so successful
 * shutdowns don't get tagged with `cleanup_timeout`.
 *
 * Callers should call `sessionLogger.setExitContext` before invoking this
 * so the root cause (signal, user cancellation, fatal error) wins over the
 * fallback context that {@link forceExit} sets on timeout.
 */
export function gracefulExit(
  exitCode: number,
  options: Omit<RunExitCleanupWithTimeoutOptions, 'exitCode'> = {},
): Promise<never> {
  if (gracefulExitPromise) {
    return gracefulExitPromise;
  }

  // Preserve the requested status even if the runtime exits naturally while
  // shutdown is in progress. The bounded-exit timer below intentionally stays
  // referenced so a dangling Promise cannot let Node leave before cleanup or
  // the timeout selects the final exit path.
  process.exitCode = exitCode;

  // Cleanup and final process termination have separate single-flight state.
  // A non-terminal cleanup may already be running when a signal arrives; the
  // signal must still own a bounded final exit instead of merely joining a
  // Promise<void> that never terminates the process.
  isShuttingDown = true;
  const { timeoutMs: _timeoutMs, ...cleanupOptions } = options;
  const exitPromise = (async (): Promise<never> => {
    const deadline = createExitCleanupDeadline(options, false);
    let result: 'completed' | 'timeout';
    try {
      result = await Promise.race([
        runExitCleanup({ exitCode, ...cleanupOptions }).then(
          () => 'completed' as const,
        ),
        deadline.promise,
      ]);
    } catch {
      forceExit(sessionDrainTimedOut ? exitCode || 1 : exitCode);
    } finally {
      deadline.cancel();
    }

    if (result === 'completed') {
      // A finalizer can discover a failure after a successful close request.
      // Preserve signal/error statuses chosen by the first shutdown caller.
      return exitOrKill(exitCode === 0 && typeof process.exitCode === 'number'
        ? process.exitCode : exitCode);
    }
    return forceExit(sessionDrainTimedOut ? exitCode || 1 : exitCode);
  })();
  gracefulExitPromise = exitPromise;

  return exitPromise;
}

/** A crash the host has confirmed fatal; the crash fields are accepted for compatibility. */
export interface ConfirmedCliCrashExitParams {
  exitCode: number;
  exitReason: CliExitReason;
  error?: unknown;
  fallbackCrashType?: string;
  errorOrigin?: string;
  errorLocation?: string;
}

/** Exit after a confirmed crash through the bounded cleanup pipeline. */
export function exitAfterConfirmedCliCrash(
  params: ConfirmedCliCrashExitParams,
): Promise<never> {
  return gracefulExit(params.exitCode, { exitReason: params.exitReason });
}

async function drainStdin() {
  if (!process.stdin?.isTTY) return;
  if (process.stdin.destroyed) return;
  // removeAllListeners('data') prevents stale handlers from firing during
  // drain; the no-op error handler guards against EIO (errno -5) when the
  // TTY closes mid-drain — without it the error crashes the process on exit.
  process.stdin
    .resume()
    .removeAllListeners('data')
    .once('data', () => {});
  if (process.stdin.listenerCount('error') === 0) {
    process.stdin.once('error', () => {});
  }
  // Give it a moment to flush the OS buffer.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Default window for {@link flushStaleStdinOnStartup}. Long enough to cover
 * libuv's async deliver of buffered console events, short enough to be
 * imperceptible before the first dialog renders.
 */
export const STARTUP_STDIN_FLUSH_WINDOW_MS = 100;

/**
 * Discard any stdin bytes already pending at startup (Windows only).
 *
 * Windows' OS-level console input buffer is shared between cmd/PowerShell
 * and the child process. When a previous CLI invocation exits with
 * unconsumed key events still in libuv's pipeline, those bytes survive
 * into the next attached process and are read as if the user just typed
 * them — e.g. "↓ Enter" from a previous "Don't trust and exit" selection
 * auto-dismisses the next FolderTrust dialog. POSIX TTYs flush on child
 * exit, so this is a no-op there.
 *
 * Must be called AFTER `setRawMode(true)` so events arrive as bytes
 * rather than line-buffered input. Caller is expected to invoke this
 * before any stdin reader (ink, KeypressContext) attaches.
 */
export async function flushStaleStdinOnStartup(
  windowMs: number = STARTUP_STDIN_FLUSH_WINDOW_MS,
): Promise<void> {
  if (process.platform !== 'win32') return;
  if (!process.stdin?.isTTY) return;
  if (process.stdin.destroyed) return;

  const stdin = process.stdin;
  const wasFlowing = stdin.readableFlowing;

  await new Promise<void>((resolve) => {
    const onData = () => {
      // Drop the bytes; we only care about the side effect of consuming them.
    };
    stdin.on('data', onData);
    stdin.resume();

    const timer = setTimeout(() => {
      stdin.removeListener('data', onData);
      // Restore the prior flow state so downstream stdin readers (ink,
      // KeypressContext) see stdin in the same state they would have
      // without this flush.
      if (wasFlowing !== true) {
        stdin.pause();
      }
      resolve();
    }, windowMs);
    timer.unref?.();
  });
}

/**
 * Gracefully shuts down the process, ensuring cleanup runs exactly once.
 * Guards against concurrent shutdown from signals (SIGHUP, SIGTERM, SIGINT)
 * and TTY loss detection racing each other.
 *
 * @see https://github.com/google-gemini/gemini-cli/issues/15874
 */
async function handleShutdownSignal(reason: string) {
  const entry = lookupShutdownEntry(reason);

  // Record the root cause first (first-call-wins) so a cleanup timeout
  // doesn't overwrite the signal in the exit context. The timeout still surfaces
  // via the forceExit log line.
  sessionLogger.setExitContext({
    reason: entry.contextReason,
    exit_code: entry.exitCode,
    message: `${reason} received`,
    source: 'cleanup.handleShutdownSignal',
  });

  await gracefulExit(entry.exitCode, {
    exitReason: entry.exitReason,
  });
}

type ShutdownReason = 'SIGINT' | 'SIGHUP' | 'SIGTERM' | 'TTY loss';

interface ShutdownEntry {
  exitCode: number;
  exitReason: CliExitReason;
  contextReason: ExitReason;
}

// POSIX 128+N convention: shells and process supervisors recover the
// originating signal from the exit code. SIGINT reuses
// FATAL_CANCELLATION_ERROR (130) since they share semantics.
const SHUTDOWN_TABLE: Record<ShutdownReason, ShutdownEntry> = {
  SIGINT: {
    exitCode: ExitCodes.FATAL_CANCELLATION_ERROR,
    exitReason: 'signal_int',
    contextReason: 'signal_int',
  },
  SIGHUP: {
    exitCode: 129,
    exitReason: 'signal_term',
    contextReason: 'signal_term',
  },
  SIGTERM: {
    exitCode: 143,
    exitReason: 'signal_term',
    contextReason: 'signal_term',
  },
  'TTY loss': {
    exitCode: 129,
    exitReason: 'idle_timeout',
    contextReason: 'tty_loss',
  },
};

const DEFAULT_SHUTDOWN_ENTRY: ShutdownEntry = {
  exitCode: ExitCodes.SUCCESS,
  exitReason: 'natural_end',
  contextReason: 'unknown',
};

function lookupShutdownEntry(reason: string): ShutdownEntry {
  return SHUTDOWN_TABLE[reason as ShutdownReason] ?? DEFAULT_SHUTDOWN_ENTRY;
}

export function setupSignalHandlers() {
  // Permanent no-op exit callback: works around a Bun bug where
  // removeListener() resets kernel signal disposition when listener count drops
  // to zero. Keeping at least one listener registered prevents this.
  onExit(() => {});

  process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
  process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
  process.on('SIGINT', () => {
    void handleShutdownSignal('SIGINT');
  });
}

export function setupTtyCheck(): () => void {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let isCheckingTty = false;

  intervalId = setInterval(async () => {
    if (isCheckingTty || isShuttingDown) {
      return;
    }

    // `writable`/`readable` flip to false the moment macOS revokes the TTY
    // file descriptor, while `isTTY` can stay true on the orphaned process.
    // Checking the streams catches both signal-less terminal closes and
    // ordinary pipe-detached startup.
    if (!process.stdout.writable || !process.stdin.readable) {
      isCheckingTty = true;

      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }

      await handleShutdownSignal('TTY loss');
    }
  }, 30_000);

  // Don't keep the process alive just for this interval
  intervalId.unref();

  return () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}
