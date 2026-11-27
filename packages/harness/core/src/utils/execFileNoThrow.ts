/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A lightweight execFile wrapper that never throws.
 *
 * This project uses node:child_process directly instead of execa.
 * This provides the minimal subset needed by codesign and ripgrep first-use test.
 */

import { execFile, type ChildProcess } from 'node:child_process';
import { runLogger } from './runLogger.js';

const WINDOWS_CLEANUP_TIMEOUT_MS = 4500;
const WINDOWS_TASKKILL_TIMEOUT_MS = 2000;
const WINDOWS_FINALIZE_TIMEOUT_MS = 500;

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut?: boolean;
}

/**
 * Run a command and return the result without throwing.
 * Non-zero exit codes are returned in `code`, not thrown.
 */
export function execFileNoThrow(
  file: string,
  args: string[],
  options: {
    timeout?: number;
    preserveOutputOnError?: boolean;
    cwd?: string;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    windowsProcessTreeCleanup?: { source: string };
  } = {},
): Promise<ExecFileResult> {
  const {
    timeout = 10_000,
    preserveOutputOnError = true,
    cwd,
    signal,
    env,
    windowsProcessTreeCleanup,
  } = options;
  const treeCleanup =
    process.platform === 'win32' ? windowsProcessTreeCleanup : undefined;

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ stdout: '', stderr: '', code: 1 });
      return;
    }

    let settled = false;
    let cleanupPromise: Promise<void> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ExecFileResult) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      signal?.removeEventListener('abort', abortForSignal);
      resolve(result);
    };
    const child = execFile(
      file,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 1_000_000,
        windowsHide: true,
        ...(cwd ? { cwd } : {}),
        ...(signal && !treeCleanup ? { signal } : {}),
        ...(env ? { env } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = error.code
            ? typeof error.code === 'number'
              ? error.code
              : 1
            : 1;
          finish({
            stdout: preserveOutputOnError ? stdout || '' : '',
            stderr: preserveOutputOnError ? stderr || '' : '',
            code,
          });
        } else {
          finish({ stdout: stdout || '', stderr: stderr || '', code: 0 });
        }
      },
    );

    function abortChild(timedOut = false): void {
      if (treeCleanup) {
        if (settled || cleanupPromise) return;
        cleanupPromise = cleanupWindowsProcessTree(
          child,
          treeCleanup.source,
          timedOut ? 'timeout' : 'cancelled',
        );
      } else {
        try {
          child.kill();
        } catch {
          // The process may already have exited between the signal and the kill.
        }
      }
      finish({
        stdout: '',
        stderr: '',
        code: 1,
        ...(timedOut ? { timedOut: true } : {}),
      });
    }

    const abortForSignal = () => abortChild(false);
    signal?.addEventListener('abort', abortForSignal, { once: true });
    if (signal?.aborted) abortForSignal();
    if (timeout > 0 && !settled) {
      deadline = setTimeout(() => abortChild(true), timeout);
      deadline.unref?.();
    }
  });
}

function cleanupWindowsProcessTree(
  child: ChildProcess,
  source: string,
  stopReason: string,
): Promise<void> {
  const startedAt = performance.now();
  const deadline = startedAt + WINDOWS_CLEANUP_TIMEOUT_MS;
  let exited = child.exitCode != null || child.signalCode != null;
  const isLeaderExited = () =>
    exited || child.exitCode != null || child.signalCode != null;

  return new Promise((resolve) => {
    let completed = false;
    let attempts = 0;
    let finalDeadline: number | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    let commandSucceeded = false;

    runLogger.debug(
      `[execFileNoThrow] cleanup_started source=${source} pid=${child.pid} stop_reason=${stopReason}`,
    );

    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(budgetTimer);
      if (finalTimer) clearTimeout(finalTimer);
      const leaderExited = isLeaderExited();
      if (!leaderExited) {
        runLogger.warn(
          `[execFileNoThrow] cleanup_unconfirmed source=${source} pid=${child.pid} reason=leader_exit_unconfirmed`,
        );
      }
      child.removeAllListeners();
      child.on('error', () => undefined);
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream?.removeAllListeners();
        stream?.on('error', () => undefined);
        stream?.destroy();
      }
      child.unref();
      runLogger.debug(
        `[execFileNoThrow] cleanup_finished source=${source} pid=${child.pid} stop_reason=${stopReason} attempts=${attempts} command_succeeded=${commandSucceeded} leader_exited=${leaderExited} elapsed_ms=${Math.round(performance.now() - startedAt)}`,
      );
      resolve();
    };

    const finalize = (
      succeeded: boolean,
      reason: string,
      observationDeadline?: number,
    ) => {
      if (completed) return;
      const now = performance.now();
      if (finalDeadline !== undefined) {
        if (now >= finalDeadline) finish();
        return;
      }
      commandSucceeded = succeeded;
      finalDeadline = Math.min(
        deadline,
        observationDeadline ?? now + WINDOWS_FINALIZE_TIMEOUT_MS,
      );
      if (succeeded) {
        runLogger.debug(
          `[execFileNoThrow] termination_command_succeeded source=${source} pid=${child.pid} attempts=${attempts}`,
        );
      } else {
        runLogger.warn(
          `[execFileNoThrow] cleanup_unconfirmed source=${source} pid=${child.pid} reason=${reason} attempts=${attempts}`,
        );
        if (!isLeaderExited()) {
          try {
            const requested = child.kill();
            runLogger.warn(
              `[execFileNoThrow] direct_process_fallback source=${source} pid=${child.pid} requested=${requested}`,
            );
          } catch (error) {
            runLogger.warn(
              `[execFileNoThrow] direct_process_fallback_failed source=${source} pid=${child.pid} error=${String(error)}`,
            );
          }
        }
      }
      if (isLeaderExited() || performance.now() >= finalDeadline) {
        finish();
      } else {
        finalTimer = setTimeout(
          finish,
          Math.max(0, finalDeadline - performance.now()),
        );
        finalTimer.unref?.();
      }
    };

    child.on('exit', () => {
      exited = true;
      if (finalDeadline !== undefined) {
        if (performance.now() < finalDeadline) {
          runLogger.debug(
            `[execFileNoThrow] cleanup_leader_exit source=${source} pid=${child.pid}`,
          );
        }
        finish();
      }
    });
    const budgetTimer = setTimeout(
      () => finalize(false, 'deadline_exceeded'),
      Math.max(0, deadline - performance.now()),
    );
    budgetTimer.unref?.();

    const terminate = async () => {
      const { killProcessGroup, WindowsTaskkillError } = await import(
        './process-utils.js'
      );
      if (completed) return;
      if (performance.now() >= deadline) {
        finalize(false, 'deadline_exceeded');
        return;
      }
      if (child.pid === undefined) {
        finalize(false, 'missing_pid');
        return;
      }
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (isLeaderExited()) {
          finalize(false, 'leader_exited');
          return;
        }
        attempts = attempt;
        try {
          await killProcessGroup({
            pid: child.pid,
            isLeaderExited,
            windowsTaskkill: { deadline },
          });
        } catch (error) {
          if (completed) return;
          runLogger.warn(
            `[execFileNoThrow] termination_attempt_failed source=${source} pid=${child.pid} attempt=${attempt} error=${String(error)}`,
          );
          if (
            error instanceof WindowsTaskkillError &&
            error.retryable &&
            attempt < 2 &&
            !isLeaderExited() &&
            deadline - performance.now() >=
              WINDOWS_TASKKILL_TIMEOUT_MS + WINDOWS_FINALIZE_TIMEOUT_MS
          ) {
            continue;
          }
          finalize(
            false,
            error instanceof WindowsTaskkillError
              ? error.reason
              : 'taskkill_failed',
            error instanceof WindowsTaskkillError
              ? error.cleanupDeadline
              : undefined,
          );
          return;
        }
        if (completed) return;
        finalize(
          performance.now() < deadline,
          performance.now() < deadline
            ? 'taskkill_succeeded'
            : 'deadline_exceeded',
        );
        return;
      }
    };
    void terminate().catch((error: unknown) => {
      if (completed) return;
      runLogger.warn(
        `[execFileNoThrow] cleanup_failed source=${source} pid=${child.pid} error=${String(error)}`,
      );
      finalize(false, 'cleanup_failed');
    });
  });
}
