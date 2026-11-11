/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import treeKill from 'tree-kill';
import {
  getShellConfiguration,
  type ShellConfiguration,
} from '../utils/shell-utils.js';
import { getPlatform } from '../utils/platform.js';
import { runLogger } from '../utils/runLogger.js';
import {
  resolveShellPrefix,
  wrapPosixShellCommand,
} from '../utils/shell/shellPrefix.js';
import {
  normalizeWindowsBashCommand,
  prependWindowsExecutableDirectoryToPath,
  tryFindGitBashPathForOptionalRunner,
} from '../utils/windowsPaths.js';
import type { StatusLineConfig, StatusLineCommandInput } from './types.js';

/** Default timeout for statusline command execution (5 seconds). */
const STATUS_LINE_TIMEOUT_MS = 5000;

/** Grace period before an unresponsive status line process tree is killed. */
const STATUS_LINE_TERMINATION_GRACE_MS = 1500;

/** Native-compatible cadence for observing detached POSIX process groups. */
const STATUS_LINE_EXIT_POLL_MS = 100;

function hasProcessTreeExited(pid: number): boolean {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
  }

  return true;
}

/**
 * Signal the child's detached process group WITHOUT forking a helper process.
 *
 * Safety: `process.kill(-0, …)` targets the caller's OWN process group and
 * `process.kill(-1, …)` every process the user owns, so refuse anything that is
 * not a real child pid (mirrors killHookProcessGroup in hooks/hookRunner.ts and
 * killProcessGroup in utils/process-utils.ts).
 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      runLogger.debug(
        `StatusLine process group ${signal} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Windows-only descendant teardown; `tree-kill` shells out to `taskkill`. */
function killDescendantProcesses(
  pid: number,
  signal: NodeJS.Signals,
): Promise<void> {
  return new Promise((resolve) => {
    try {
      treeKill(pid, signal, (error) => {
        if (error) {
          runLogger.debug(
            `StatusLine process tree ${signal} failed: ${error.message}`,
          );
        }
        resolve();
      });
    } catch (error) {
      runLogger.debug(
        `StatusLine process tree ${signal} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      resolve();
    }
  });
}

/**
 * Tear down a status line process tree.
 *
 * POSIX: the child is spawned with `detached: true`, so `child.pid` leads its
 * own process group and a single non-forking `process.kill(-pid, signal)`
 * reaches every descendant (including reparented grandchildren). `tree-kill`
 * MUST NOT be used here: on macOS it spawns `pgrep -P <pid>` per tree node, and
 * every status line refresh aborts the previous run — so a saturated process
 * table makes those `pgrep` forks fail with EAGAIN exactly when cleanup matters
 * most, leaving the helpers standing and amplifying the fork storm that
 * exhausted `kern.maxprocperuid` in the first place. Same rationale as the
 * command-hook teardown (docs/designs/2026-07-23-hook-process-group-teardown.md).
 *
 * Windows: unchanged — no process groups, so descendants are torn down with
 * `tree-kill`/`taskkill`.
 */
function killStatusLineProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  isWindows: boolean,
): Promise<void> {
  if (!pid || pid <= 1) return Promise.resolve();

  if (!isWindows) {
    signalProcessGroup(pid, signal);
    return Promise.resolve();
  }

  return killDescendantProcesses(pid, signal);
}

/**
 * Gracefully stop a status line tree, then force-kill it after the same grace
 * period used by the native runner. POSIX checks the detached group every
 * 100ms and cancels the force timer only after both PGID and root PID vanish.
 */
function terminateStatusLineProcessTree(
  pid: number | undefined,
  isWindows: boolean,
): void {
  if (!pid || pid <= 1) return;

  const termination = killStatusLineProcessTree(pid, 'SIGTERM', isWindows);
  let exitPollHandle: ReturnType<typeof setInterval> | undefined;
  let forceKillHandle: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => {
      forceKillHandle = undefined;
      if (exitPollHandle) clearInterval(exitPollHandle);
      void killStatusLineProcessTree(pid, 'SIGKILL', isWindows);
    },
    STATUS_LINE_TERMINATION_GRACE_MS,
  );
  forceKillHandle.unref();

  if (isWindows) return;

  const clearForceKillIfExited = () => {
    if (!forceKillHandle || !hasProcessTreeExited(pid)) return;
    clearTimeout(forceKillHandle);
    forceKillHandle = undefined;
    if (exitPollHandle) {
      clearInterval(exitPollHandle);
      exitPollHandle = undefined;
    }
  };

  void termination.then(() => {
    clearForceKillIfExited();
    if (!forceKillHandle) return;
    exitPollHandle = setInterval(
      clearForceKillIfExited,
      STATUS_LINE_EXIT_POLL_MS,
    );
    exitPollHandle.unref();
  });
}

/**
 * Prefer an already available Git Bash for Windows status line commands.
 * Status lines are optional, so a missing or invalid installation falls back
 * to PowerShell without waiting for managed environment preparation.
 */
const SHELL_PROBE_ABORTED = Symbol('shell-probe-aborted');

/** Wait for a shared probe without allowing it to delay caller cancellation. */
function waitForGitBashProbeOrAbort(
  probe: Promise<string | null>,
  signal: AbortSignal,
): Promise<string | null | typeof SHELL_PROBE_ABORTED> {
  if (signal.aborted) return Promise.resolve(SHELL_PROBE_ABORTED);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      value: string | null | typeof SHELL_PROBE_ABORTED,
    ) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(SHELL_PROBE_ABORTED);

    signal.addEventListener('abort', onAbort, { once: true });
    void probe.then(
      (value) => finish(value),
      (error) => {
        runLogger.debug(
          `StatusLine shell discovery error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        finish(null);
      },
    );
  });
}

async function getStatusLineShellConfiguration(
  signal: AbortSignal,
): Promise<ShellConfiguration | undefined> {
  if (getPlatform() === 'windows') {
    if (signal.aborted) return undefined;
    const gitBashPath = await waitForGitBashProbeOrAbort(
      tryFindGitBashPathForOptionalRunner(),
      signal,
    );
    if (gitBashPath === SHELL_PROBE_ABORTED) return undefined;
    if (gitBashPath) {
      return {
        executable: gitBashPath,
        argsPrefix: ['-c'],
        shell: 'bash',
      };
    }
  }

  return getShellConfiguration();
}

/** Match the Windows Git Bash launch environment used by shell-form runners. */
function getStatusLineSpawnEnvironment(
  shellConfig: ShellConfiguration,
): NodeJS.ProcessEnv | undefined {
  if (
    getPlatform() !== 'windows' ||
    shellConfig.shell !== 'bash'
  ) {
    return undefined;
  }

  const env = { ...process.env };
  prependWindowsExecutableDirectoryToPath(env, shellConfig.executable);
  const shellKey =
    Object.keys(env).find((key) => key.toUpperCase() === 'SHELL') ?? 'SHELL';
  env[shellKey] = shellConfig.executable;
  return env;
}

/**
 * Result of a statusline command execution.
 */
export interface StatusLineCommandResult {
  /** Whether the command was aborted before completing. */
  aborted: boolean;
  /** Process exit status code (0 = success). */
  status: number;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
}

/**
 * Executes the user-configured statusline command.
 *
 * The command receives a JSON blob on stdin containing rich session data
 * (model, workspace, context window, etc.) and is expected to print
 * lines to stdout that will be rendered below the input prompt.
 * ANSI escape codes are preserved so scripts can emit colors.
 *
 * @param statusLine  The statusLine config from settings.json
 * @param input       The JSON session data to pipe on stdin
 * @param signal      Optional AbortSignal to cancel the execution
 * @param timeoutMs   Timeout in milliseconds (default 5 000)
 * @param logResult   Whether to log the result for debugging
 * @returns The trimmed stdout output, or `undefined` on error / empty output
 */
export async function executeStatusLineCommand(
  statusLine: StatusLineConfig,
  input: StatusLineCommandInput,
  signal?: AbortSignal,
  timeoutMs: number = STATUS_LINE_TIMEOUT_MS,
  logResult = false,
): Promise<string | undefined> {
  if (!statusLine || statusLine.type !== 'command' || !statusLine.command) {
    return undefined;
  }

  const startedAt = Date.now();
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
  timeoutHandle.unref();
  const timeoutSignal = timeoutController.signal;
  const abortSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    const shellConfig = await getStatusLineShellConfiguration(abortSignal);
    if (!shellConfig || abortSignal.aborted) return undefined;

    const isWindows = getPlatform() === 'windows';
    const originalCommand = statusLine.command;
    let command =
      isWindows && shellConfig.shell === 'bash'
        ? normalizeWindowsBashCommand(originalCommand)
        : originalCommand;
    if (shellConfig.shell !== 'powershell') {
      const shellPrefix = resolveShellPrefix();
      if (shellPrefix) {
        command = wrapPosixShellCommand(command, shellPrefix);
      }
    }
    const spawnEnv = getStatusLineSpawnEnvironment(shellConfig);

    return await new Promise<string | undefined>((resolve) => {
      if (abortSignal.aborted) {
        resolve(undefined);
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;

      const child = spawn(
        shellConfig.executable,
        [...shellConfig.argsPrefix, command],
        {
          cwd: input.workspace?.current_dir ?? input.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          detached: !isWindows,
          windowsHide: true,
          ...(spawnEnv ? { env: spawnEnv } : {}),
        },
      );

      // Pipe JSON input on stdin
      try {
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
      } catch {
        // stdin may be closed if the process already exited
      }

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // The combined signal's timeout started before shell discovery, so probe
      // time counts against the same end-to-end status line deadline.
      const onAbort = () => {
        if (!settled) {
          settled = true;
          terminateStatusLineProcessTree(child.pid, isWindows);
          if (timeoutSignal.aborted) {
            runLogger.debug(
              `StatusLine command timed out after ${Date.now() - startedAt}ms`,
            );
          }
          resolve(undefined);
        }
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          abortSignal.removeEventListener('abort', onAbort);
          runLogger.debug(`StatusLine command error: ${error.message}`);
          resolve(undefined);
        }
      });

      child.on('close', (code) => {
        if (!settled) {
          settled = true;
          abortSignal.removeEventListener('abort', onAbort);

          if (code === 0) {
            // Join non-empty lines
            const output = stdout
              .trim()
              .split('\n')
              .filter((line) => line.trim().length > 0)
              .join('\n');

            if (output) {
              if (logResult) {
                runLogger.log(
                  `StatusLine [${originalCommand}] completed with status ${code}`,
                );
              }
              resolve(output);
            } else {
              resolve(undefined);
            }
          } else {
            if (logResult) {
              runLogger.warn(
                `StatusLine [${originalCommand}] completed with status ${code}`,
              );
              if (stderr) {
                runLogger.warn(`StatusLine stderr: ${stderr.slice(0, 5000)}`);
              }
            }
            resolve(undefined);
          }
        }
      });
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}
