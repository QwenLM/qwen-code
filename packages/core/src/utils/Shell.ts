/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shell execution singleton. Entry point for running shell commands with
 * proper command assembly, CWD tracking, and process lifecycle management.
 */

import {
  guardDetachedProcess,
  prepareDetachedProcessGuard,
} from '../services/detachedProcessGuard.js';
import {
  constants as fsConstants,
  openSync,
  closeSync,
  realpathSync,
  statSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { spawn, type StdioOptions } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  DEFAULT_SHELL_TYPE,
  type ShellProvider,
  type ShellSessionContext,
  type ShellType,
} from './shell/shellProvider.js';
import { createBashShellProvider } from './shell/bashProvider.js';
import { createPowerShellProvider } from './shell/powerShell.js';
import {
  wrapSpawn,
  createAbortedCommand,
  createFailedCommand,
  type ShellCommand,
} from './ShellCommand.js';
import { TaskOutput, type ProgressCallback } from './task/TaskOutput.js';
import { initTaskOutput, O_NOFOLLOW } from './task/diskOutput.js';
import { runLogger } from './runLogger.js';
import { getPlatform } from './platform.js';
import { raceWithAbortSignal } from './abort-race.js';
import { posixPathToWindowsPath, findGitBashPath } from './windowsPaths.js';
import {
  ShellErrorDiagnostics,
  summarizeShellOutputFile,
} from './shell/shellDiagnostics.js';

/**
 * Register a callback that is invoked whenever the tracked shell working
 * directory changes through {@link setCwdAndNotify}. Set to `null` to
 * unregister.
 */
export function setCwdChangedCallback(
  cb: ((oldCwd: string, newCwd: string) => void) | null,
): () => void {
  const state = getShellState();
  state.cwdChangedCallback = cb;
  return () => {
    if (state.cwdChangedCallback === cb) state.cwdChangedCallback = null;
  };
}

/** Default command timeout: 30 minutes. */
const DEFAULT_TIMEOUT = 30 * 60 * 1000;

/** Parameters for spawn transformation (environment sanitization). */
export type SpawnParams = {
  program: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string;
};

/** Result of spawn transformation. */
export type TransformedSpawnParams = SpawnParams & {
  cleanup?: () => void;
};

/** Options for Shell.exec(). */
export type ExecOptions = {
  /** Command timeout in milliseconds. Default: 30 minutes. */
  timeout?: number;
  /** Callback for progress updates during execution. */
  onProgress?: ProgressCallback;
  /** Prevent CWD updates after command execution. */
  preventCwdChanges?: boolean;
  /** Whether to auto-background on timeout. */
  shouldAutoBackground?: boolean;
  /**
   * Whether to redirect stdout to a file instead of piping through JS.
   * File mode avoids memory pressure for large outputs.
   * Default: false (pipe mode).
   */
  stdoutToFile?: boolean;
  /** Keep pipe-mode stdout/stderr in the task output file from the first chunk. */
  persistOutputToFile?: boolean;
  /** Observe raw stdout chunks in pipe mode. */
  onStdout?: (chunk: string) => void;
  /** External taskId for this execution (for background task tracking). */
  taskId?: string;
  /**
   * Override CWD for this command.
   * If not provided, uses the Shell module's tracked CWD.
   */
  cwd?: string;
  /**
   * Session-owned inputs for this command, supplied by the calling session's
   * Config. Resolved providers are memoized per shell type and shared across
   * sessions, so anything session-specific has to travel with the command.
   */
  sessionContext?: ShellSessionContext;
  /**
   * Transform spawn parameters before process creation.
   * Used for environment sanitization.
   * The transform receives bashProvider's assembled program/args/env/cwd
   * and can modify them (e.g., sanitize the environment).
   */
  transformSpawn?: (params: SpawnParams) => Promise<TransformedSpawnParams>;
};

interface ShellState {
  cwd: string;
  originalCwd: string;
  cwdChangedCallback: ((oldCwd: string, newCwd: string) => void) | null;
}

const defaultShellState: ShellState = {
  cwd: process.cwd(),
  originalCwd: process.cwd(),
  cwdChangedCallback: null,
};
const shellSessions = new WeakMap<object, ShellState>();
const shellSessionStorage = new AsyncLocalStorage<ShellState>();

function getShellState(): ShellState {
  return shellSessionStorage.getStore() ?? defaultShellState;
}

/** ACP 的 Config 生命周期独占 Shell 状态；本地单会话保留原有默认上下文。 */
export function initializeShellSession(owner: object, cwd: string): void {
  shellSessions.set(owner, { cwd, originalCwd: cwd, cwdChangedCallback: null });
}

export function hasIsolatedShellSession(owner: object): boolean {
  return shellSessions.has(owner);
}

/** 状态对象跨轮次复用，使 cd 与异步完成通知只影响所属会话。 */
export function runWithShellSession<T>(owner: object, fn: () => T): T {
  const state = shellSessions.get(owner);
  // scoped Config 不另建会话，继续继承当前主会话；本地入口则自然使用默认状态。
  return state ? shellSessionStorage.run(state, fn) : fn();
}

/** Effective working directory of the owner's session, honoring agent cwd overrides. */
export function getSessionCwd(owner?: object): string {
  return owner ? runWithShellSession(owner, getCwd) : getCwd();
}

export interface CwdContext {
  cwd: string;
  originalCwd: string;
  /** Session-owned notifications; agent overrides deliberately omit this. */
  onCwdChanged?: (oldCwd: string, newCwd: string) => void;
}

// Session/agent-scoped mutable CWD. The single-session CLI falls back to currentCwd.
const cwdOverrideStorage = new AsyncLocalStorage<CwdContext>();

// Memoized providers
const resolvedProviders: Partial<Record<ShellType, ShellProvider>> = {};
const resolvingProviders: Partial<Record<ShellType, Promise<ShellProvider>>> =
  {};

/**
 * Finds a suitable shell binary on the system.
 *
 * On Windows, delegates to `findGitBashPath()` which has comprehensive
 * Git Bash discovery and can wait for a background Portable Git download.
 * On Unix, only accepts $SHELL when it points to bash or zsh; otherwise
 * discovers a supported shell from standard locations.
 *
 * @returns Absolute path to the shell binary.
 */
export async function findSuitableShell(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  // Windows needs Git Bash / MSYS2 path semantics; handle first to avoid
  // accidentally accepting WSL bash (C:\Windows\System32\bash.exe).
  if (getPlatform() === 'windows') {
    runLogger.debug(
      '[Shell] findSuitableShell: Windows, delegating to findGitBashPath',
    );
    return findGitBashPath(signal);
  }

  const envShell = process.env['SHELL'];
  const envShellBase = envShell
    ? path
        .basename(envShell)
        .toLowerCase()
        .replace(/\.exe$/, '')
    : '';
  const envShellSupported = envShellBase === 'bash' || envShellBase === 'zsh';
  const preferBash = envShellSupported && envShellBase === 'bash';

  if (envShell && !envShellSupported) {
    runLogger.debug(
      `[Shell] findSuitableShell: ignoring unsupported SHELL="${envShell}"`,
    );
  }

  // Build ordered candidate list
  const shellDirs = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
  const shellNames = preferBash ? ['bash', 'zsh'] : ['zsh', 'bash'];
  const candidates: string[] = [];

  // If $SHELL is a supported shell, prioritize it
  if (envShell && envShellSupported) {
    candidates.push(envShell);
  }

  // Add discovery paths in preference order
  for (const name of shellNames) {
    for (const dir of shellDirs) {
      const candidate = path.join(dir, name);
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
  }

  // Last-resort fallback
  candidates.push('/bin/sh');

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      runLogger.debug(`[Shell] findSuitableShell: selected ${candidate}`);
      return candidate;
    }
  }

  runLogger.debug('[Shell] findSuitableShell: fallback to /bin/sh');
  return '/bin/sh';
}

/**
 * Checks if a file is executable.
 */
async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a ShellProvider for the given shell type.
 */
async function createProvider(
  shellType: ShellType,
  options?: {
    signal?: AbortSignal;
  },
): Promise<ShellProvider> {
  if (shellType === 'bash') {
    const shellPath = await findSuitableShell(options?.signal);
    return createBashShellProvider(shellPath, {
      signal: options?.signal,
    });
  }

  if (shellType === 'powershell') {
    const provider = await createPowerShellProvider();
    resolvedProviders[shellType] = provider;
    return provider;
  }

  throw new Error(
    `Shell type "${shellType}" is not yet supported. ` +
      `Skills with "shell: ${shellType}" cannot execute inline shell commands at this time.`,
  );
}

/**
 * Resolves a ShellProvider for the given shell type.
 * Resolved providers and in-flight creation promises are both memoized so
 * startup prewarming and concurrent commands share one initialization.
 */
async function resolveProvider(
  shellType: ShellType,
  options?: {
    signal?: AbortSignal;
  },
): Promise<ShellProvider> {
  const resolved = resolvedProviders[shellType];
  if (resolved) {
    return resolved;
  }

  const resolving = resolvingProviders[shellType];
  if (resolving) {
    return resolving;
  }

  const promise = createProvider(shellType, options);
  resolvingProviders[shellType] = promise;

  try {
    const provider = await promise;
    resolvedProviders[shellType] = provider;
    return provider;
  } finally {
    delete resolvingProviders[shellType];
  }
}

/**
 * Starts shell provider initialization without executing a command.
 * Callers may fire-and-forget this promise; a later exec() call will await the
 * same in-flight provider.
 */
export async function prewarmShellProvider(
  shellType: ShellType = DEFAULT_SHELL_TYPE,
  options?: {
    signal?: AbortSignal;
  },
): Promise<void> {
  await resolveProvider(shellType, options);
}

/**
 * Builds the child process environment.
 */
function buildProcessEnv(
  envOverrides: Record<string, string>,
): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_EDITOR: 'true',
    ...envOverrides,
  };
}

/** Resolve a command's directory, recovering only to an explicitly supplied root. */
export function resolveShellCwd(
  requestedCwd: string,
  fallbackCwd?: string,
): { cwd: string; recoveredFrom?: string } {
  const isDirectory = (directory: string): boolean => {
    try {
      return statSync(directory).isDirectory();
    } catch {
      return false;
    }
  };
  if (isDirectory(requestedCwd)) return { cwd: requestedCwd };
  if (fallbackCwd !== undefined && isDirectory(fallbackCwd)) {
    runLogger.warn(`[Shell] CWD recovered: ${requestedCwd} -> ${fallbackCwd}`);
    return { cwd: fallbackCwd, recoveredFrom: requestedCwd };
  }
  throw new Error(
    `Working directory does not exist or is not a directory: ${requestedCwd}`,
  );
}

/**
 * Executes a shell command with full lifecycle management.
 *
 * @param command - The command string to execute.
 * @param abortSignal - Signal to abort execution.
 * @param shellType - Which shell to use (default: 'bash').
 * @param options - Execution options.
 * @returns A ShellCommand wrapping the running process.
 */
export async function exec(
  command: string,
  abortSignal: AbortSignal,
  shellType: ShellType = DEFAULT_SHELL_TYPE,
  options?: ExecOptions,
): Promise<ShellCommand> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

  // Generate a unique ID for this execution
  const id = crypto.randomBytes(2).toString('hex');
  const taskId = options?.taskId ?? id;

  runLogger.debug(
    `[Shell] exec: command_bytes=${Buffer.byteLength(command)}, ` +
      `cwd=${options?.cwd ?? getCwd()}, taskId=${taskId}, ` +
      `stdoutToFile=${options?.stdoutToFile ?? false}, timeout=${timeout}ms`,
  );

  // Check before shell initialization or any output preparation.
  if (abortSignal.aborted) {
    runLogger.debug('[Shell] exec: aborted before spawn');
    return createAbortedCommand();
  }

  let cwd: string;
  try {
    const resolved = resolveShellCwd(
      options?.cwd ?? getCwd(),
      options?.cwd === undefined && !options?.preventCwdChanges
        ? getOriginalCwd()
        : undefined,
    );
    cwd = realpathSync(resolved.cwd);
    if (resolved.recoveredFrom) setCwdAndNotify(cwd);
  } catch (error) {
    return createFailedCommand(
      String(error instanceof Error ? error.message : error),
    );
  }

  let provider: ShellProvider;
  try {
    // A command owns its wait, not the initialization shared with other callers.
    provider = await raceWithAbortSignal(resolveProvider(shellType), abortSignal);
  } catch (error) {
    if (abortSignal.aborted) return createAbortedCommand();
    throw error;
  }

  // Create TaskOutput for output management
  const stdoutToFile = options?.stdoutToFile ?? false;
  const taskOutput = new TaskOutput(
    taskId,
    options?.onProgress ?? null,
    stdoutToFile,
    undefined,
    options?.onStdout ?? null,
    options?.persistOutputToFile ?? false,
  );

  // Build the command string
  const {
    commandString,
    cwdFilePath,
    env: commandEnv,
    diagnostics,
    cleanup: providerCleanup,
  } = await provider.buildExecCommand(command, {
    id,
    sessionContext: options?.sessionContext,
  });

  try {
    if (abortSignal.aborted) {
      taskOutput.clear();
      providerCleanup?.();
      runLogger.debug('[Shell] exec: aborted during shell preparation');
      return createAbortedCommand();
    }

    // Get spawn arguments and environment
    const spawnArgs = provider.getSpawnArgs(commandString);
    const envOverrides = await provider.getEnvironmentOverrides(command);
    const env = buildProcessEnv({ ...envOverrides, ...commandEnv });

    // Apply transformSpawn if provided (for environment sanitization)
    let spawnProgram = provider.shellPath;
    let spawnArgsFinal = spawnArgs;
    let spawnEnv: Record<string, string | undefined> = env;
    let spawnCwd = cwd;
    let spawnCleanup: (() => void) | undefined;

    if (options?.transformSpawn) {
      const transformed = await options.transformSpawn({
        program: spawnProgram,
        args: spawnArgsFinal,
        env: spawnEnv,
        cwd: spawnCwd,
      });
      spawnProgram = transformed.program;
      spawnArgsFinal = transformed.args;
      spawnEnv = transformed.env;
      spawnCwd = transformed.cwd;
      spawnCleanup = transformed.cleanup;
    }

    // Set up stdio based on mode
    let outputFd: number | undefined;
    let stdio: StdioOptions;

    if (stdoutToFile) {
      // File mode: stdout and stderr go directly to a file fd
      let outputFileInitialized = false;
      try {
        await initTaskOutput(taskId, taskOutput.path);
        outputFileInitialized = true;
        // On Windows, 'a' (append) mode strips FILE_WRITE_DATA (only grants
        // FILE_APPEND_DATA) via libuv's fs__open. MSYS2/Cygwin probes inherited
        // handles with NtQueryInformationFile(FileAccessInformation) and treats
        // handles without FILE_WRITE_DATA as read-only, silently discarding all
        // output. Using 'w' grants FILE_GENERIC_WRITE, avoiding the issue.
        outputFd = openSync(
          taskOutput.path,
          getPlatform() === 'windows'
            ? 'w'
            : fsConstants.O_WRONLY |
                fsConstants.O_APPEND |
                fsConstants.O_CREAT |
                (O_NOFOLLOW || 0),
        );
        stdio = ['pipe', outputFd, outputFd];
      } catch (error) {
        if (outputFileInitialized) {
          try {
            unlinkSync(taskOutput.path);
          } catch {
            // The file may already have been removed.
          }
        }
        taskOutput.clear();
        try {
          spawnCleanup?.();
        } catch (cleanupError) {
          runLogger.warn(
            `[Shell] exec: spawn cleanup failed after output preparation error: taskId=${taskId}`,
            cleanupError,
          );
        }

        const errorCode =
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : 'unknown';
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        runLogger.warn(
          `[Shell] exec: output preparation failed: taskId=${taskId}, ` +
            `path=${taskOutput.path}, code=${errorCode}, error=${errorMessage}`,
        );
        providerCleanup?.();
        return createFailedCommand(
          `Failed to prepare shell output (${errorCode}): ${errorMessage}`,
        );
      }
    } else {
      // Pipe mode: stdout/stderr flow through JS
      if (options?.persistOutputToFile) {
        try {
          await initTaskOutput(taskId, taskOutput.path);
        } catch (error) {
          taskOutput.clear();
          providerCleanup?.();
          return createFailedCommand(
            `Failed to prepare shell output: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      stdio = ['pipe', 'pipe', 'pipe'];
    }

    // PowerShell preparation can await provider/transform/output I/O. A cancellation
    // during those awaits must not start a new process with an already-aborted signal.
    if (shellType === 'powershell' && abortSignal.aborted) {
      if (outputFd !== undefined) closeSync(outputFd);
      try {
        spawnCleanup?.();
      } catch (error) {
        runLogger.warn(
          '[Shell] spawn cleanup failed after cancellation',
          error,
        );
      }
      taskOutput.clear();
      await taskOutput.deleteOutputFile();
      providerCleanup?.();
      return createAbortedCommand();
    }

    // Spawn the child process
    let childProcess: ReturnType<typeof spawn>;
    try {
      if (provider.detached) prepareDetachedProcessGuard();
      childProcess = spawn(spawnProgram, spawnArgsFinal, {
        env: spawnEnv,
        cwd: spawnCwd,
        stdio,
        detached: provider.detached,
        windowsHide: true,
      });
    } catch (error) {
      runLogger.warn(
        `[Shell] spawn threw: taskId=${taskId}, ` +
          `error_code=${(error as NodeJS.ErrnoException)?.code ?? 'unknown'}` +
          (diagnostics ? `, ${diagnostics}` : ''),
      );
      throw error;
    } finally {
      // Always release the parent's fd, including when spawn throws.
      // After a successful spawn, the child retains its own reference.
      if (outputFd !== undefined) {
        closeSync(outputFd);
      }
    }

    if (provider.detached) guardDetachedProcess(childProcess);

    runLogger.debug(
      `[Shell] spawn: pid=${childProcess.pid}, program=${spawnProgram}, ` +
        `cwd=${spawnCwd}, stdio=${stdoutToFile ? 'file' : 'pipe'}, taskId=${taskId}, ` +
        `argv_bytes=${spawnArgsFinal.reduce((sum, arg) => sum + Buffer.byteLength(arg), 0)}, ` +
        `command_env_preserved=${Object.entries(commandEnv ?? {}).every(([key, value]) => spawnEnv[key] === value)}, ` +
        `transformed=${Boolean(options?.transformSpawn)}` +
        (diagnostics ? `, ${diagnostics}` : ''),
    );

    if (diagnostics) {
      const errors = new ShellErrorDiagnostics();
      childProcess.stderr?.on('data', (chunk: Buffer | string) =>
        errors.append(chunk),
      );
      // Pipe mode needs close to drain stderr. File mode must capture at exit,
      // before wrapSpawn resolves and result consumers delete small output files.
      // Process events also cover commands that have been backgrounded.
      childProcess.once(stdoutToFile ? 'exit' : 'close', (code, signal) => {
        if (code === 0 && !signal) return;
        const report = (summary: string) =>
          runLogger.warn(
            `[Shell] execution failed: taskId=${taskId}, pid=${childProcess.pid}, ` +
              `code=${String(code)}, signal=${String(signal)}, ${diagnostics}, ${summary}`,
          );
        if (stdoutToFile) {
          try {
            report(summarizeShellOutputFile(taskOutput.path));
          } catch {
            report('output_unavailable=true');
          }
        } else {
          report(errors.summary());
        }
      });
      childProcess.once('error', (error: NodeJS.ErrnoException) => {
        runLogger.warn(
          `[Shell] spawn failed: taskId=${taskId}, error_code=${error.code ?? 'unknown'}, ${diagnostics}`,
        );
      });
    }

    // Wrap the process with lifecycle management
    const shellCommand = wrapSpawn(
      childProcess,
      abortSignal,
      timeout,
      options?.shouldAutoBackground,
      taskOutput,
      shellType,
    );

    // Track CWD after process completion. PowerShell also cleans its CWD file
    // when directory updates are suppressed; preserve the existing Bash path.
    if (!options?.preventCwdChanges || shellType === 'powershell') {
      void shellCommand.result.then(
        (result) => {
          try {
            // 无论是否有 providerCleanup，spawnCleanup 都只需执行一次；
            // 放进 try 内还能避免它抛错时变成 unhandledRejection。
            spawnCleanup?.();
            // Background tasks should not update the foreground session CWD
            if (
              result.backgroundTaskId ||
              (shellType === 'powershell' && options?.preventCwdChanges)
            ) {
              return;
            }
            // On Windows, cwdFilePath is a native Windows path for Node.js file I/O,
            // but the content (written by bash's `pwd -P`) is in POSIX format.
            // Convert back to Windows native path.
            let newCwd = readFileSync(cwdFilePath, 'utf-8').trim();
            if (
              getPlatform() === 'windows' &&
              newCwd &&
              provider.cwdFileContentPathStyle !== 'native'
            ) {
              newCwd = posixPathToWindowsPath(newCwd);
            }
            if (newCwd && newCwd !== getCwd()) {
              setCwdAndNotify(newCwd);
            }
          } catch {
            // 命令可能在写入 CWD 文件前失败；spawnCleanup 自身的异常也在此忽略。
          } finally {
            // Clean up the temp CWD file
            try {
              if (providerCleanup) providerCleanup();
              else unlinkSync(cwdFilePath);
            } catch {
              // Ignore
            }
          }
        },
        (error: unknown) => {
          // result 可能因进程树终止失败而 reject；此时仍必须释放临时文件，
          // 并且不能把清理失败再次变成 unhandledRejection。
          runLogger.warn(
            `[Shell] shell result rejected before CWD update: ${String(error)}`,
          );
          try {
            spawnCleanup?.();
          } catch {
            // Ignore cleanup errors on an already-failed command.
          } finally {
            try {
              if (providerCleanup) providerCleanup();
              else unlinkSync(cwdFilePath);
            } catch {
              // Ignore
            }
          }
        },
      );
    } else if (spawnCleanup) {
      const cleanup = () => {
        try {
          spawnCleanup?.();
        } catch {
          // Ignore cleanup errors on an already-failed command.
        }
      };
      void shellCommand.result.then(cleanup, cleanup);
    } else {
      // 该分支没有清理动作，但仍需观察 rejection，避免直接调用方只等待
      // 就绪时把终止失败变成 unhandledRejection。
      void shellCommand.result.catch((error: unknown) => {
        runLogger.warn(`[Shell] shell result rejected: ${String(error)}`);
      });
    }

    return shellCommand;
  } catch (error) {
    providerCleanup?.();
    throw error;
  }
}

/**
 * Sets the current working directory.
 *
 * @param newPath - The new CWD path (absolute or relative).
 * @param relativeTo - Base path for relative resolution.
 */
export function setCwd(newPath: string, relativeTo?: string): void {
  const store = cwdOverrideStorage.getStore();
  const absolute = path.isAbsolute(newPath)
    ? newPath
    : path.resolve(relativeTo ?? store?.cwd ?? getShellState().cwd, newPath);

  try {
    // Normalize to NFC for macOS APFS compatibility (APFS stores NFD form).
    const resolved = realpathSync(absolute).normalize('NFC');
    if (store) store.cwd = resolved;
    else getShellState().cwd = resolved;
  } catch {
    const resolved = absolute.normalize('NFC');
    if (store) store.cwd = resolved;
    else getShellState().cwd = resolved;
  }
}

/**
 * Sets the tracked shell working directory and notifies registered observers.
 *
 * The CWD and synchronous observer state are updated before this function
 * returns. Observers may start asynchronous notification work, but callers do
 * not wait for it; lifecycle transitions therefore cannot be blocked by a
 * long-running CwdChanged hook.
 */
export function setCwdAndNotify(newPath: string, relativeTo?: string): void {
  const oldCwd = getCwd();
  setCwd(newPath, relativeTo);
  notifyCwdChanged(oldCwd, getCwd());
}

/** 事务提交后才通知当前执行上下文；子 Agent 没有回调时不通知父会话。 */
export function notifyCwdChanged(
  oldCwd: string,
  newCwd: string,
  ownerCallback?: ((oldCwd: string, newCwd: string) => void) | null,
): void {
  if (newCwd === oldCwd) return;
  runLogger.debug(`[Shell] CWD changed: ${oldCwd} -> ${newCwd}`);
  try {
    const context = cwdOverrideStorage.getStore();
    // Worktree 提交有明确的 Config 所有者，不借用其他会话的环境回调。
    const notify = ownerCallback !== undefined
      ? ownerCallback
      : context
        ? context.onCwdChanged
        : getShellState().cwdChangedCallback;
    notify?.(oldCwd, newCwd);
  } catch (error) {
    runLogger.debug(`[Shell] CWD change observer failed: ${String(error)}`);
  }
}

/**
 * Gets the current working directory.
 * Returns the session/agent context's CWD when bound, otherwise the
 * process-global currentCwd used by the single-session CLI.
 */
export function getCwd(): string {
  return cwdOverrideStorage.getStore()?.cwd ?? getShellState().cwd;
}

/**
 * Gets this execution context's reset directory, or the CLI startup directory.
 */
export function getOriginalCwd(): string {
  return cwdOverrideStorage.getStore()?.originalCwd ?? getShellState().originalCwd;
}

/**
 * Sets the original working directory used by shell cwd reset/fallback logic.
 */
export function setOriginalCwd(newPath: string): void {
  const store = cwdOverrideStorage.getStore();
  const absolute = path.isAbsolute(newPath)
    ? newPath
    : path.resolve(getCwd(), newPath);

  try {
    const resolved = realpathSync(absolute).normalize('NFC');
    if (store) store.originalCwd = resolved;
    else getShellState().originalCwd = resolved;
  } catch {
    const resolved = absolute.normalize('NFC');
    if (store) store.originalCwd = resolved;
    else getShellState().originalCwd = resolved;
  }
}

/**
 * Runs `fn` inside an isolated, mutable CWD context. getCwd()/setCwd() within
 * the callback and its async descendants operate on this context rather than
 * the main session's currentCwd.
 *
 * @param startCwd - The CWD this context should report.
 * @param fn - The function to run.
 */
export function runWithCwdOverride<T>(startCwd: string, fn: () => T): T {
  return cwdOverrideStorage.run({ cwd: startCwd, originalCwd: startCwd }, fn);
}

/** Run an operation in an existing session context without resetting its CWD. */
export function runWithCwdContext<T>(context: CwdContext, fn: () => T): T {
  return cwdOverrideStorage.run(context, fn);
}

/** Bind every iterator step, including cleanup, to a persistent session CWD.
 * Creating a generator inside ALS alone does not bind later next() calls.
 */
export function bindCwdContext<T, R, N>(
  context: CwdContext,
  generator: AsyncGenerator<T, R, N>,
): AsyncGenerator<T, R, N> {
  return {
    next: (...args: [] | [N]) =>
      runWithCwdContext(context, () => generator.next(...args)),
    return: (value) =>
      runWithCwdContext(context, () => generator.return(value)),
    throw: (error) => runWithCwdContext(context, () => generator.throw(error)),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/**
 * Returns the process-global currentCwd directly, bypassing ALS.
 * For testing only — verifies agent-scoped updates stay isolated.
 */
export function currentCwdForTest(): string {
  return defaultShellState.cwd;
}

/**
 * Resets the Shell module state. For testing only.
 */
export function resetForTest(cwd?: string): void {
  defaultShellState.cwd = cwd ?? process.cwd();
  defaultShellState.originalCwd = cwd ?? process.cwd();
  // Clear memoized providers
  for (const key of Object.keys(resolvedProviders) as ShellType[]) {
    delete resolvedProviders[key];
  }
  for (const key of Object.keys(resolvingProviders) as ShellType[]) {
    delete resolvingProviders[key];
  }
}
