/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  sanitizeEnvironment,
  getSecureSanitizationConfig,
} from '../services/environmentSanitization.js';
import { spawnAsync } from './shell-utils.js';
import { runLogger } from './runLogger.js';

/** Default timeout for SIGKILL escalation on Unix systems. */
export const SIGKILL_TIMEOUT_MS = 1500;

/** Interval between process-tree exit checks during graceful shutdown. */
const PROCESS_EXIT_POLL_INTERVAL_MS = 100;

/** Maximum time allowed for enumerating descendant processes. */
const DESCENDANT_ENUM_TIMEOUT_MS = 500;

/** Configuration for process termination. */
export interface KillOptions {
  /** The process ID to terminate. */
  pid: number;
  /** Whether to attempt SIGTERM before SIGKILL on Unix systems. */
  escalate?: boolean;
  /** Initial signal to use (defaults to SIGTERM if escalate is true, else SIGKILL). */
  signal?: NodeJS.Signals | number;
  /** Live child-process state; a known exit must never be inferred from PID alone. */
  isLeaderExited?: () => boolean;
  /** Opt-in taskkill bound, expressed as an absolute performance.now() deadline. */
  windowsTaskkill?: { deadline: number };
}

export class WindowsTaskkillError extends Error {
  readonly reason: string;
  readonly retryable: boolean;
  readonly cleanupDeadline?: number;

  constructor(
    message: string,
    options: {
      reason: string;
      retryable: boolean;
      cleanupDeadline?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'WindowsTaskkillError';
    this.reason = options.reason;
    this.retryable = options.retryable;
    this.cleanupDeadline = options.cleanupDeadline;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

async function enumerateDescendantPids(rootPid: number): Promise<number[]> {
  try {
    const { stdout } = await spawnAsync(
      'ps',
      ['-A', '-o', 'pid=', '-o', 'ppid='],
      { cwd: '/', timeout: DESCENDANT_ENUM_TIMEOUT_MS },
    );
    const childrenByParent = new Map<number, number[]>();

    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) {
        continue;
      }
      const childPid = Number(match[1]);
      const parentPid = Number(match[2]);
      if (childPid <= 1 || childPid === rootPid) {
        continue;
      }
      const children = childrenByParent.get(parentPid) ?? [];
      children.push(childPid);
      childrenByParent.set(parentPid, children);
    }

    const descendants: number[] = [];
    const visited = new Set<number>([rootPid]);
    const queue = [...(childrenByParent.get(rootPid) ?? [])];
    while (queue.length > 0) {
      const pid = queue.shift();
      if (pid === undefined || visited.has(pid)) {
        continue;
      }
      visited.add(pid);
      descendants.push(pid);
      queue.push(...(childrenByParent.get(pid) ?? []));
    }
    return descendants;
  } catch (error) {
    runLogger.debug(
      `[ProcessUtils] failed to enumerate descendants for pid=${rootPid}: ${String(error)}`,
    );
    return [];
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals | number): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function signalProcessTree(
  rootPid: number,
  signal: NodeJS.Signals | number,
  descendants: Set<number>,
  isLeaderExited: () => boolean,
  forceImmediately = false,
): Promise<void> {
  const signalLeaderAndGroup = () => {
    // Queue the leader's signal before a group broadcast can wake its children.
    // The callback identifies the original child, unlike kill(pid, 0).
    if (!isLeaderExited()) sendSignal(rootPid, signal);
    runLogger.debug(
      `[ProcessUtils] sending ${String(signal)} to process group -${rootPid}`,
    );
    sendSignal(-rootPid, signal);
  };
  // Do not let a process-table query delay forced termination.
  if (forceImmediately) signalLeaderAndGroup();
  if (!isLeaderExited()) {
    const snapshot = await enumerateDescendantPids(rootPid);
    // Exit/reaping can happen while ps is in flight. Such a snapshot may now
    // describe a reused PID's children; retain only earlier trusted entries.
    if (!isLeaderExited()) {
      for (const pid of snapshot) descendants.add(pid);
    }
  }
  if (!forceImmediately) signalLeaderAndGroup();
  for (const descendantPid of descendants) {
    sendSignal(descendantPid, signal);
  }
}

function isSignalTargetGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return getErrorCode(error) === 'ESRCH';
  }
}

function isProcessTreeGone(
  rootPid: number,
  descendants: Set<number>,
  isLeaderExited: () => boolean,
): boolean {
  return (
    isSignalTargetGone(-rootPid) &&
    (isLeaderExited() || isSignalTargetGone(rootPid)) &&
    [...descendants].every(isSignalTargetGone)
  );
}

async function waitForProcessTreeExit(
  rootPid: number,
  descendants: Set<number>,
  isLeaderExited: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + SIGKILL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isProcessTreeGone(rootPid, descendants, isLeaderExited)) {
      return true;
    }
    const remainingMs = deadline - Date.now();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        resolve,
        Math.min(PROCESS_EXIT_POLL_INTERVAL_MS, remainingMs),
      );
      timer.unref?.();
    });
  }
  return isProcessTreeGone(rootPid, descendants, isLeaderExited);
}

/**
 * Robustly terminates a process tree across platforms.
 *
 * On Windows, it requests tree termination with `taskkill /f /t` and rejects
 * on failure. This cannot recover descendants whose parent chain is gone.
 *
 * On Unix, it enumerates descendants, signals the leader before the process
 * group and each known descendant, then optionally escalates from SIGTERM to
 * SIGKILL after waiting for the group and its leader to exit.
 */
export async function killProcessGroup(options: KillOptions): Promise<void> {
  const { pid, escalate = false } = options;
  const isWindows = os.platform() === 'win32';
  let leaderExited = false;
  const isLeaderExited = () =>
    (leaderExited ||= options.isLeaderExited?.() ?? false);

  if (!Number.isInteger(pid) || pid <= 1) {
    runLogger.warn(`[ProcessUtils] refusing to kill invalid pid=${pid}`);
    return;
  }

  runLogger.debug(
    `[ProcessUtils] killProcessGroup: pid=${pid}, escalate=${escalate}, isWindows=${isWindows}`,
  );

  if (isWindows) {
    if (isLeaderExited()) {
      const message = `Cannot terminate process tree pid=${pid}: original leader exited; descendant cleanup is unconfirmed`;
      if (options.windowsTaskkill) {
        throw new WindowsTaskkillError(message, {
          reason: 'leader_exited',
          retryable: false,
        });
      }
      throw new Error(message);
    }
    if (options.windowsTaskkill) {
      await executeWindowsTaskkill(pid, options.windowsTaskkill.deadline);
      return;
    }
    // Do not turn access errors, missing taskkill, or a missing root into a
    // successful stop. Even a missing root cannot prove its descendants exited.
    try {
      await spawnAsync('taskkill', ['/pid', pid.toString(), '/f', '/t'], {
        windowsHide: true,
        timeout: 2000,
      });
    } catch (error) {
      runLogger.warn(
        `[ProcessUtils] taskkill failed: pid=${pid}, timeoutMs=2000, error=${String(error)}`,
      );
      throw new Error(
        `Failed to terminate process tree pid=${pid}: ${String(error)}`,
        {
          cause: error,
        },
      );
    }
    return;
  }

  const initialSignal = options.signal || (escalate ? 'SIGTERM' : 'SIGKILL');
  // Keep the original descendants even when the leader exits or they reparent.
  const descendants = new Set<number>();
  await signalProcessTree(pid, initialSignal, descendants, isLeaderExited);

  if (!escalate) {
    return;
  }

  if (await waitForProcessTreeExit(pid, descendants, isLeaderExited)) {
    return;
  }

  runLogger.debug(
    `[ProcessUtils] escalating to SIGKILL for process tree pid=${pid}`,
  );
  await signalProcessTree(pid, 'SIGKILL', descendants, isLeaderExited, true);
}

function executeWindowsTaskkill(
  pid: number,
  overallDeadline: number,
): Promise<void> {
  const resultDeadline = Math.min(performance.now() + 2000, overallDeadline);
  const createTimeoutError = (now: number) => {
    const reason =
      now >= overallDeadline ? 'deadline_exceeded' : 'taskkill_timeout';
    return new WindowsTaskkillError(`taskkill did not finish: ${reason}`, {
      reason,
      retryable: false,
      cleanupDeadline: Math.min(overallDeadline, now + 500),
    });
  };
  if (performance.now() >= resultDeadline) {
    return Promise.reject(createTimeoutError(performance.now()));
  }

  let child: ChildProcess;
  try {
    child = spawn('taskkill', ['/pid', pid.toString(), '/f', '/t'], {
      windowsHide: true,
      env: sanitizeEnvironment(process.env, getSecureSanitizationConfig()),
    });
  } catch (error) {
    return Promise.reject(
      performance.now() >= resultDeadline
        ? createTimeoutError(performance.now())
        : new WindowsTaskkillError(`Failed to spawn taskkill: ${String(error)}`, {
            reason: `taskkill_spawn_error: ${String(error)}`,
            retryable: false,
            cause: error,
          }),
    );
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let released = false;
    let stderr = '';
    let cleanupDeadline = overallDeadline;
    let resultTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const hasExited = () => child.exitCode !== null || child.signalCode !== null;

    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(resultTimer);
      clearTimeout(cleanupTimer);
      child.on('error', ignoreWindowsTaskkillError);
      child.off('exit', onResult);
      child.off('close', onResult);
      child.off('error', onError);
      child.stderr?.off('data', onStderr);
      stderr = '';
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    };

    const expire = (now: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(resultTimer);
      const error = createTimeoutError(now);
      cleanupDeadline = error.cleanupDeadline!;
      stderr = '';
      reject(error);
      if (!hasExited()) {
        if (cleanupDeadline > now) {
          cleanupTimer = setTimeout(release, Math.ceil(cleanupDeadline - now));
          cleanupTimer.unref?.();
        }
        try {
          if (!child.kill('SIGKILL')) {
            runLogger.warn(
              `[ProcessUtils] taskkill termination request failed: pid=${pid}`,
            );
          }
        } catch (killError) {
          runLogger.warn(
            `[ProcessUtils] taskkill termination request threw: pid=${pid}, code=${getErrorCode(killError) ?? 'unknown'}`,
          );
        }
      }
      if (hasExited() || performance.now() >= cleanupDeadline) release();
    };

    const onResult = (code: number | null, signal: NodeJS.Signals | null) => {
      const now = performance.now();
      if (!settled && now >= resultDeadline) expire(now);
      if (settled) {
        if (!released && now < cleanupDeadline) {
          runLogger.debug(
            `[ProcessUtils] late taskkill exit: pid=${pid}, code=${code}, signal=${signal}`,
          );
        }
        release();
        return;
      }
      settled = true;
      const error =
        code === 0
          ? undefined
          : new WindowsTaskkillError(
              `taskkill failed with code=${code}, signal=${signal}`,
              {
                reason: `taskkill_exit_${code ?? signal ?? 'unknown'}`,
                retryable: code !== null || signal !== null || hasExited(),
                cause: new Error(stderr.trim()),
              },
            );
      release();
      if (error) reject(error);
      else resolve();
    };

    const onError = (error: Error) => {
      const now = performance.now();
      if (!settled && now >= resultDeadline) expire(now);
      if (settled) {
        if (!released && now < cleanupDeadline) {
          runLogger.debug(
            `[ProcessUtils] late taskkill error: pid=${pid}, code=${getErrorCode(error) ?? 'unknown'}`,
          );
        }
        if (hasExited() || now >= cleanupDeadline) release();
        return;
      }
      settled = true;
      const failure = new WindowsTaskkillError(error.message, {
        reason: `taskkill_error: ${error.message}`,
        retryable: hasExited(),
        cause: error,
      });
      release();
      reject(failure);
    };

    const onStderr = (data: Buffer) => {
      if (!settled) stderr += data.toString();
    };
    const onTimeout = () => {
      const now = performance.now();
      if (now >= resultDeadline) {
        expire(now);
      } else {
        resultTimer = setTimeout(onTimeout, Math.ceil(resultDeadline - now));
        resultTimer.unref?.();
      }
    };

    child.stdout?.resume();
    child.stderr?.on('data', onStderr);
    child.on('exit', onResult);
    child.on('close', onResult);
    child.on('error', onError);
    resultTimer = setTimeout(
      onTimeout,
      Math.max(0, Math.ceil(resultDeadline - performance.now())),
    );
    resultTimer.unref?.();
  });
}

function ignoreWindowsTaskkillError(): void {}
